/**
 * 手机 Web 版截图（真机尺寸 390x844，走真实 geolocation）
 * 用法：node scripts/shoot-web.js
 */
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs');

(async () => {
  let chromium;
  const candidates = ['playwright-core', path.join(ROOT, '..', 'node_modules', 'playwright-core')];
  for (const c of candidates) {
    try { chromium = require(c).chromium; break; } catch (e) { /* next */ }
  }
  if (!chromium) { console.error('需要 playwright-core'); process.exit(2); }
  if (!fs.existsSync(CHROME)) { console.error('未找到 Chrome'); process.exit(2); }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    geolocation: { latitude: 39.90871, longitude: 116.397412, accuracy: 22 },
    permissions: ['geolocation'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto('file:///' + path.join(ROOT, 'webapp', 'index.html').replace(/\\/g, '/'));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(900);

  const shots = [
    { name: 'web-index', page: 'index' },
    { name: 'web-records', page: 'records' },
    { name: 'web-stats', page: 'stats' },
    { name: 'web-rules', page: 'rules' },
    { name: 'web-me', page: 'me' },
    { name: 'web-admin', page: 'admin' },
  ];

  for (const s of shots) {
    await page.evaluate((pg) => window.__pc.go(pg), s.page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, s.name + '.png') });
    console.log('shot-' + s.name + '.png');
  }

  // 记录页展开一天
  await page.evaluate(() => window.__pc.go('records'));
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const days = document.querySelectorAll('[data-day]');
    if (days.length > 1) days[1].click();
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'web-records-open.png') });
  console.log('shot-web-records-open.png');

  // 弹性规则下的首页
  await page.evaluate(() => { window.__pc.rule('flexible'); window.__pc.go('index'); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'web-index-flexible.png') });
  console.log('shot-web-index-flexible.png');

  // 自由工时
  await page.evaluate(() => { window.__pc.rule('free'); window.__pc.go('index'); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'web-index-free.png') });
  console.log('shot-web-index-free.png');

  await page.evaluate(() => { window.__pc.rule('fixed'); window.__pc.go('index'); });
  await page.waitForTimeout(300);

  await browser.close();

  if (errs.length) {
    console.error('页面错误:\n' + errs.join('\n'));
    process.exit(1);
  }
  console.log('done, no page errors');
  process.exit(0);
})();
