/**
 * 用真实 Chrome 渲染 demo/preview.html 并截图到 docs/
 * 需要本机有 Chrome（路径见 CHROME）。这是可选的开发脚本，不影响小程序运行。
 *
 * 用法：node scripts/shoot.js
 */
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs');

(async () => {
  let chromium;
  // playwright-core 可能装在工作区根目录（不在本工程内）——按需向上找
  const candidates = ['playwright-core', path.join(ROOT, '..', 'node_modules', 'playwright-core')];
  for (const c of candidates) {
    try {
      chromium = require(c).chromium;
      break;
    } catch (e) {
      // 继续试下一个
    }
  }
  if (!chromium) {
    console.error('需要 playwright-core：在工作区根目录 npm i playwright-core');
    process.exit(2);
  }
  if (!fs.existsSync(CHROME)) {
    console.error('未找到 Chrome：' + CHROME);
    process.exit(2);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 460, height: 1000 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.goto('file:///' + path.join(ROOT, 'demo', 'preview.html').replace(/\\/g, '/'));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(700);

  const pages = ['index', 'records', 'stats', 'me', 'rules', 'admin'];
  for (const p of pages) {
    await page.evaluate((pp) => window.__preview.go(pp), p);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, 'shot-' + p + '.png') });
    console.log('shot-' + p + '.png');
  }

  // 记录页展开状态
  await page.evaluate(() => window.__preview.go('records'));
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const nodes = document.querySelectorAll('[data-day]');
    if (nodes.length) nodes[1].click();
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'shot-records-open.png') });
  console.log('shot-records-open.png');

  // 首页：弹性规则形态
  await page.evaluate(() => { window.__preview.setRule('flexible'); window.__preview.go('index'); });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'shot-index-flexible.png') });
  console.log('shot-index-flexible.png');

  // 首页：自由工时形态
  await page.evaluate(() => { window.__preview.setRule('free'); window.__preview.go('index'); });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'shot-index-free.png') });
  console.log('shot-index-free.png');

  // 恢复固定班制
  await page.evaluate(() => { window.__preview.setRule('fixed'); window.__preview.go('index'); });
  await page.waitForTimeout(250);

  await browser.close();

  if (errs.length) {
    console.error('页面错误:\n' + errs.join('\n'));
    process.exit(1);
  }
  console.log('done, no page errors');
  process.exit(0);
})();
