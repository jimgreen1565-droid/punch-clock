/**
 * 毛玻璃在这个设计里到底有多少视觉收益？（实测对照）
 *
 * 怀疑点：背景是极平滑的径向渐变，模糊它几乎看不出差别。
 * 毛玻璃真正有价值的前提是"身后有高频细节"（文字、图片、纹理）。
 * 这个脚本用同一区域、开/关 blur 各截一张放大图，肉眼可对比。
 */
const path = require('path');
const fs = require('fs');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const ENTRY = 'file:///' + path.join(ROOT, 'webapp', 'index.html').replace(/\\/g, '/') + '?bg=8';
const OUT = path.join(ROOT, 'docs');

(async () => {
  let chromium;
  for (const c of ['playwright-core', path.join(ROOT, '..', 'node_modules', 'playwright-core')]) {
    try { chromium = require(c).chromium; break; } catch (e) { /* next */ }
  }
  if (!chromium || !fs.existsSync(CHROME)) { console.error('缺 playwright-core 或 Chrome'); process.exit(2); }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();

  for (const mode of ['on', 'off']) {
    await page.goto(ENTRY);
    await page.waitForTimeout(700);
    if (mode === 'off') {
      await page.evaluate(() => {
        const s = document.createElement('style');
        s.textContent = '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
        document.head.appendChild(s);
      });
      await page.waitForTimeout(300);
    }
    // 截"记录页"：列表项与卡片重叠、彼此遮挡，最能体现毛玻璃层次
    await page.evaluate(() => window.__pc.go('records'));
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(OUT, 'glass-compare-' + mode + '.png'),
      clip: { x: 0, y: 240, width: 390, height: 320 },
    });
    console.log('shot glass-compare-' + mode + '.png');
  }

  await browser.close();
  console.log('done');
})();
