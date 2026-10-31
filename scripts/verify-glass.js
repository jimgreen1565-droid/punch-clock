import { chromium } from 'playwright-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = 'D:/ZW/Documents/deepseek-harness/default-workspace/punch-clock';
const ENTRY = 'file:///' + ROOT + '/webapp/index.html';

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

async function measure(bg, disableBlur) {
  await page.goto(ENTRY + '?bg=' + bg);
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__pc.go('records'));
  await page.waitForTimeout(400);
  if (disableBlur) {
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = '*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
      document.head.appendChild(s);
    });
    await page.waitForTimeout(250);
  }
  // 关键：必须避开文字。取卡片"右侧空白区"（时间数字左边、标签右边的空隙），
  // 那里只有玻璃和背景，没有任何内容覆盖。
  const rect = await page.evaluate(() => {
    const card = document.querySelectorAll('.day')[1] || document.querySelector('.card');
    const r = card.getBoundingClientRect();
    // 卡片内：左 45% 位置到 60%，垂直居中偏下（避开标题行）
    return {
      x: Math.round(r.left + r.width * 0.42),
      y: Math.round(r.top + r.height * 0.55),
      width: Math.round(r.width * 0.16),
      height: Math.round(r.height * 0.3),
    };
  });
  const png = await page.screenshot({ clip: rect });

  return await page.evaluate(async ({ b64 }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await new Promise((r) => { img.onload = r; });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const { data, width, height } = cx.getImageData(0, 0, img.width, img.height);

    let rS = 0, gS = 0, bS = 0, n = 0;
    const lum = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        rS += data[i]; gS += data[i + 1]; bS += data[i + 2]; n++;
        lum.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      }
    }
    const meanR = rS / n, meanG = gS / n, meanB = bS / n;
    const lumMean = lum.reduce((a, b) => a + b, 0) / lum.length;
    const lumVar = lum.reduce((a, b) => a + (b - lumMean) ** 2, 0) / lum.length;
    const tint = meanB - meanR;
    let adj = 0, an = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width - 1; x++) {
        const i = (y * width + x) * 4;
        adj += Math.abs(data[i] - data[i + 4]); an++;
      }
    }
    return {
      tint: +tint.toFixed(2),
      lumVar: +lumVar.toFixed(2),
      adjacency: +(adj / an).toFixed(3),
      rgb: [+meanR.toFixed(0), +meanG.toFixed(0), +meanB.toFixed(0)],
    };
  }, { b64: png.toString('base64') });
}

for (const bg of ['10', '8']) {
  const on = await measure(bg, false);
  const off = await measure(bg, true);
  console.log('\n=== bg=' + bg + ' ===');
  console.log('开 blur:', JSON.stringify(on));
  console.log('关 blur:', JSON.stringify(off));
  const tintGain = Math.abs(on.tint) - Math.abs(off.tint);
  console.log('  色相偏移(透出的背景色): ' + tintGain.toFixed(2) + (tintGain > 0.3 ? '  ✔ 明显' : '  ≈ 微弱'));
  console.log('  亮度层次(内部明暗):     ' + (off.lumVar - on.lumVar).toFixed(0) + (off.lumVar - on.lumVar > 40 ? '  ✔ 明显' : '  ≈ 微弱'));
  console.log('  细节抹平(模糊前后):     ' + off.adjacency + ' → ' + on.adjacency);
  console.log('  卡片平均色:             rgb(' + on.rgb.join(',') + ')');
}

await browser.close();
