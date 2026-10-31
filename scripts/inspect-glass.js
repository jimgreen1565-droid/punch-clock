import { chromium } from 'playwright-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ENTRY = 'file:///D:/ZW/Documents/deepseek-harness/default-workspace/punch-clock/webapp/index.html';

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// 直接问浏览器：卡片背景是什么？背景层是什么？以及离屏合成后的实际色
for (const bg of ['10', '8', '0']) {
  await page.goto(ENTRY + '?bg=' + bg);
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__pc.go('records'));
  await page.waitForTimeout(400);

  const r = await page.evaluate(() => {
    const card = document.querySelectorAll('.day')[1] || document.querySelector('.day');
    const aurora = document.querySelector('.aurora');
    const q = (el) => (el ? getComputedStyle(el) : null);
    const cc = q(card);
    const ac = aurora ? q(aurora) : null;

    // 用 canvas 把"卡片白色 + 背景色"按 alpha 合成，得到理论上的可见色
    const m = cc && cc.backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    const alpha = m ? parseFloat(m[4] ?? '1') : 1;

    return {
      bg: document.body.getAttribute('data-bg'),
      cardBg: cc ? cc.backgroundColor : 'none',
      cardAlpha: alpha,
      cardBlur: cc ? cc.backdropFilter || cc.webkitBackdropFilter : 'none',
      auroraBg: ac ? ac.backgroundImage.slice(0, 60) : 'none',
      auroraBgColor: ac ? ac.backgroundColor : 'none',
      // 卡片内空白区（避开文字）的位置，供后续截图参考
      blankRect: (() => {
        const rr = card.getBoundingClientRect();
        return { l: Math.round(rr.left), t: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) };
      })(),
    };
  });

  console.log('\nbg=' + bg);
  console.log('  卡片底色      :', r.cardBg, '→ alpha', r.cardAlpha);
  console.log('  卡片模糊      :', r.cardBlur);
  console.log('  背景层(mesh)  :', r.auroraBgColor);
  console.log('  背景渐变前60字:', r.auroraBg);
  console.log('  卡片几何      :', JSON.stringify(r.blankRect));
}

await browser.close();
