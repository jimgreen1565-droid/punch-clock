/**
 * 量化验证毛玻璃是否真的在模糊背景。
 *
 * 方法：在页面坐标系里取同一块区域，分别读"开 blur"和"关 blur"的像素，
 * 比较相邻像素差（局部对比度）。模糊会把渐变抹平 → 局部对比度下降。
 *
 * 用 Playwright 直接读像素，不走 PNG 解码（避免 filter 类型带来的解析歧义）。
 */
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const ENTRY = 'file:///' + path.join(ROOT, 'webapp', 'index.html').replace(/\\/g, '/') + '?bg=8';

(async () => {
  let chromium;
  for (const c of ['playwright-core', path.join(ROOT, '..', 'node_modules', 'playwright-core')]) {
    try { chromium = require(c).chromium; break; } catch (e) { /* next */ }
  }
  if (!chromium || !require('fs').existsSync(CHROME)) { console.error('缺 playwright-core 或 Chrome'); process.exit(2); }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  async function sample(disableBlur) {
    await page.goto(ENTRY);
    await page.waitForTimeout(700);
    if (disableBlur) {
      await page.evaluate(() => {
        const s = document.createElement('style');
        s.textContent = '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
        document.head.appendChild(s);
      });
      await page.waitForTimeout(300);
    }
    // 取"卡片边缘 + 背景"的跨界区域：这里 blur 前后差异最明显
    const rect = await page.evaluate(() => {
      const card = document.querySelector('.geo-card') || document.querySelector('.card');
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return {
        x: Math.round(r.left + 20),
        y: Math.round(r.top - 6),   // 上半截在卡片外（纯背景），下半截在卡片内（模糊层）
        width: 120,
        height: 60,
      };
    });
    const buf = await page.screenshot({ clip: rect });
    // 用 canvas 解 PNG 读像素
    const stats = await page.evaluate(async ({ dataB64 }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + dataB64;
      await new Promise((r) => { img.onload = r; });
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      const { data, width, height } = cx.getImageData(0, 0, img.width, img.height);
      // 局部对比度：相邻像素 R 通道差的绝对值均值
      let sum = 0, n = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width - 1; x++) {
          const i = (y * width + x) * 4;
          sum += Math.abs(data[i] - data[i + 4]);
          n++;
        }
      }
      // 同时算整体方差
      let rSum = 0, rN = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) { rSum += data[(y * width + x) * 4]; rN++; }
      }
      const mean = rSum / rN;
      let vSum = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const v = data[(y * width + x) * 4];
          vSum += (v - mean) ** 2;
        }
      }
      return { adjacency: +(sum / n).toFixed(3), variance: +(vSum / rN).toFixed(2), mean: +mean.toFixed(1) };
    }, { dataB64: buf.toString('base64') });
    return stats;
  }

  const withBlur = await sample(false);
  const noBlur = await sample(true);

  console.log('开 blur :', JSON.stringify(withBlur));
  console.log('关 blur :', JSON.stringify(noBlur));
  console.log('');
  const reduced = withBlur.adjacency < noBlur.adjacency;
  console.log(reduced
    ? '✔ 毛玻璃生效：相邻像素差从 ' + noBlur.adjacency + ' 降到 ' + withBlur.adjacency +
      '（降 ' + (100 * (1 - withBlur.adjacency / noBlur.adjacency)).toFixed(1) + '%），说明背景被真实模糊了'
    : '✘ 未见模糊效果（' + withBlur.adjacency + ' vs ' + noBlur.adjacency + '）');

  await browser.close();
  process.exit(reduced ? 0 : 1);
})();
