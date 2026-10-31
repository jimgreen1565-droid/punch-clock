/**
 * 生成方案对照图（4 个背景变体并排）
 * 用法：node scripts/shoot-compare.js
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

  const variants = [
    { n: 'bg0-clean', label: 'A 卡片式（现状）' },
    { n: 'bg1-photo-light', label: 'B 照片头部（读不清）' },
    { n: 'bg4-grid', label: 'C 极淡纹理（看不出）' },
    { n: 'bg5-flat', label: 'D 扁平分组 ★推荐' },
  ];

  // 先确保这四张存在
  for (const v of variants) {
    if (!fs.existsSync(path.join(OUT, v.n + '.png'))) {
      console.error('缺截图 ' + v.n + '.png，请先跑 node scripts/shoot-bg.js');
      process.exit(2);
    }
  }

  const imgs = variants.map((v) =>
    'data:image/png;base64,' + fs.readFileSync(path.join(OUT, v.n + '.png')).toString('base64')
  );

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1260, height: 940 }, deviceScaleFactor: 1.5 })).newPage();

  const html = `<body style="margin:0;background:#e8ebf0;font:13px/1.4 -apple-system,'Segoe UI','PingFang SC',sans-serif;display:flex;gap:14px;padding:18px;justify-content:center;align-items:flex-start">
${imgs.map((u, i) => `<div style="text-align:center"><img src="${u}" style="width:286px;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,.14)"><div style="margin-top:9px;font-weight:600;color:#111827">${variants[i].label}</div></div>`).join('')}
</body>`;

  await page.setContent(html, 'utf8');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'bg-compare.png') });

  await browser.close();
  console.log('wrote docs/bg-compare.png');
})();
