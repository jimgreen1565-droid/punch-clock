/**
 * 拍规则页下半部分（补卡规则 / 打卡方式 / 规则模板）
 * 用法：node scripts/shoot-rules-lower.js
 */
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs');

(async () => {
  let chromium;
  for (const c of ['playwright-core', path.join(ROOT, '..', 'node_modules', 'playwright-core')]) {
    try { chromium = require(c).chromium; break; } catch (e) { /* next */ }
  }
  if (!chromium || !fs.existsSync(CHROME)) { console.error('缺 playwright-core 或 Chrome'); process.exit(2); }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    geolocation: { latitude: 39.90871, longitude: 116.397412, accuracy: 22 },
    permissions: ['geolocation'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto('file:///' + path.join(ROOT, 'webapp', 'index.html').replace(/\\/g, '/'));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(700);

  await page.evaluate(() => window.__pc.go('rules'));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.scrollTo(0, 1500);
    const c = document.querySelector('.content');
    if (c) c.scrollTop = 1500;
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'web-rules-patch.png') });
  console.log('shot-web-rules-patch.png');

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.row.tappable')].map((r) => r.textContent.replace('›', '').trim())
  );
  console.log('rows:', JSON.stringify(rows.filter((r) => /补卡|可补|每月|定位/.test(r))));
  console.log('errors:', errs.length ? errs : 'none');

  await browser.close();
  process.exit(errs.length ? 1 : 0);
})();
