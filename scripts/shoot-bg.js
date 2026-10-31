/**
 * 背景变体对比截图（?bg=0|1|2|3）
 * 用法：node scripts/shoot-bg.js
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
  const variants = [
    { bg: 0, name: 'bg0-clean' },
    { bg: 1, name: 'bg1-photo-light' },
    { bg: 2, name: 'bg2-photo-heavy' },
    { bg: 3, name: 'bg3-photo-full' },
    { bg: 4, name: 'bg4-grid' },
    { bg: 5, name: 'bg5-flat' },
  ];

  for (const v of variants) {
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

    const url = 'file:///' + path.join(ROOT, 'webapp', 'index.html').replace(/\\/g, '/') + '?bg=' + v.bg;
    await page.goto(url);
    await page.evaluate(() => localStorage.clear());
    await page.goto(url);
    await page.waitForTimeout(700);

    // 造一个"工作日进行中"的状态，避免拍到休息日空态
    await page.evaluate(() => {
      const R = window.PC.rules;
      const db = window.__pc.db();
      const L = window.PC.ledger;
      const todayKey = R.dayKeyOf(Date.now());
      let recs = db.records.filter((r) => r.dateKey !== todayKey);
      const inAt = Date.now() - 45 * 60000;
      recs = L.append(recs, {
        uid: db.boot.uid, dateKey: todayKey, type: 'in', at: inAt, clientAt: inAt,
        source: 'webapp', lat: 39.90871, lng: 116.397412, acc: 22, dist: 14,
        note: '', patchId: null, geoSkipped: false, shiftName: '标准班',
      }, Date.now());
      recs[recs.length - 1].id = L.makeId(db.boot.uid, inAt, recs[recs.length - 1].seq);
      db.records = recs;

      const rs = R.normalizeRuleSet(db.ruleSet);
      const wd = R.partsOf(Date.now()).weekday;
      if (rs.weekdays.indexOf(wd) < 0) {
        db.ruleSet = R.normalizeRuleSet(
          Object.assign({}, db.ruleSet, { weekdays: rs.weekdays.concat([wd]).sort((a, b) => a - b) })
        );
      }
      localStorage.setItem('pc_web_v2', JSON.stringify(db));
    });
    await page.goto(url);
    await page.waitForTimeout(800);

    await page.screenshot({ path: path.join(OUT, v.name + '.png') });
    console.log('shot ' + v.name, errs.length ? errs : '');
    await ctx.close();
  }

  await browser.close();
  console.log('done');
  process.exit(0);
})();
