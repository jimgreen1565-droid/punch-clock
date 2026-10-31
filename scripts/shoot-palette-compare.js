/**
 * 配色方案并排对照图（4 套 × 2 页）
 * 用法：node scripts/shoot-palette-compare.js
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

  const pals = [
    { id: 'blue', label: 'A 蓝（现状）' },
    { id: 'indigo', label: 'B 靛蓝' },
    { id: 'teal', label: 'C 青绿' },
    { id: 'amber', label: 'D 暖琥珀' },
  ];

  for (const p of pals) {
    if (!fs.existsSync(path.join(OUT, 'pal-' + p.id + '-records.png'))) {
      console.error('缺截图，请先跑 shoot-palette.js');
      process.exit(2);
    }
  }

  const uris = pals.map((p) =>
    'data:image/png;base64,' + fs.readFileSync(path.join(OUT, 'pal-' + p.id + '-records.png')).toString('base64')
  );

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1290, height: 950 }, deviceScaleFactor: 1.5 })).newPage();

  const html = `<body style="margin:0;background:#e8ebf0;font:13px/1.4 -apple-system,'Segoe UI','PingFang SC',sans-serif;display:flex;gap:14px;padding:18px;justify-content:center;align-items:flex-start">
${uris.map((u, i) => `<div style="text-align:center"><img src="${u}" style="width:290px;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,.14)"><div style="margin-top:9px;font-weight:600;color:#111827">${pals[i].label}</div></div>`).join('')}
</body>`;

  await page.setContent(html, 'utf8');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'pal-compare.png') });

  await browser.close();
  console.log('wrote docs/pal-compare.png');
})();
