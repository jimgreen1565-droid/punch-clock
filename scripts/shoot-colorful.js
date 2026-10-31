/**
 * 多色彩方案对照图（默认 blue vs colorful）
 * 用法：node scripts/shoot-colorful.js
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

  const pairs = [
    { id: 'blue', label: 'A 旧：单色（蓝 + 灰）' },
    { id: 'colorful', label: 'B 新：多色彩（默认）' },
  ];

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 760, height: 940 }, deviceScaleFactor: 1.5 })).newPage();

  // 读两张记录页截图做并排
  const imgs = pairs.map((p) =>
    'data:image/png;base64,' + fs.readFileSync(path.join(OUT, 'pal-' + p.id + '-records.png')).toString('base64')
  );

  const html = `<body style="margin:0;background:#e8ebf0;font:13px/1.4 -apple-system,'Segoe UI','PingFang SC',sans-serif;display:flex;gap:16px;padding:18px;justify-content:center;align-items:flex-start">
${imgs.map((u, i) => `<div style="text-align:center"><img src="${u}" style="width:310px;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,.14)"><div style="margin-top:9px;font-weight:600;color:#111827">${pairs[i].label}</div></div>`).join('')}
</body>`;

  await page.setContent(html, 'utf8');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'pal-colorful-compare.png') });

  await browser.close();
  console.log('wrote docs/pal-colorful-compare.png');
})();
