/**
 * 手机 Web 版截图（真机尺寸 390x844，真实 geolocation）
 *
 * 为什么要在截图前"伪造一个工作日"：
 *   截图当天如果是周末，首页会走「休息日空态」，看不到时间轴/倒计时/异常提示这些
 *   真正需要评审的布局。所以这里先把 localStorage 里的今天改成工作日形状再拍。
 *
 * 用法：node scripts/shoot-web.js
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
  if (!chromium) { console.error('需要 playwright-core'); process.exit(2); }
  if (!fs.existsSync(CHROME)) { console.error('未找到 Chrome：' + CHROME); process.exit(2); }

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
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  const url = 'file:///' + path.join(ROOT, 'webapp', 'index.html').replace(/\\/g, '/');
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(800);

  // 造一个"工作日进行中"的状态：一条上班卡，没有下班卡
  await page.evaluate(() => {
    const db = window.__pc.db();
    const R = window.PC.rules;
    const L = window.PC.ledger;
    const todayKey = R.dayKeyOf(Date.now());

    // 清掉今天已有记录，避免演示数据里那条"今日上班卡"干扰
    let recs = db.records.filter((r) => r.dateKey !== todayKey);

    // 造一条今早 08:52 的上班卡
    // 用「当前时刻往前 45 分钟」，这样能拍到真实的"计时中"状态而不是 0m
    const inAt = Date.now() - 45 * 60000;
    recs = L.append(recs, {
      uid: db.boot.uid, dateKey: todayKey, type: 'in', at: inAt, clientAt: inAt,
      source: 'webapp', lat: 39.90871, lng: 116.397412, acc: 22, dist: 14,
      note: '', patchId: null, geoSkipped: false, shiftName: '标准班',
    }, Date.now());
    recs[recs.length - 1].id = L.makeId(db.boot.uid, inAt, recs[recs.length - 1].seq);

    db.records = recs;

    // 若今天本来就休息（周末），临时把工作日改成每天，让时间轴能显示出来
    const rs = R.normalizeRuleSet(db.ruleSet);
    // 只把"今天这个星期几"加进工作日，保留原本的周一至周五，
    // 这样"应出勤"天数不会被改成 31，出勤率仍然可读。
    const todayWeekday = R.partsOf(Date.now()).weekday;
    if (rs.weekdays.indexOf(todayWeekday) < 0) {
      const wd = rs.weekdays.concat([todayWeekday]).sort((a, b) => a - b);
      db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { weekdays: wd }));
    }
    localStorage.setItem('pc_web_v2', JSON.stringify(db));
  });
  await page.reload();
  await page.waitForTimeout(800);

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

  await page.evaluate(() => { window.__pc.rule('shift'); window.__pc.go('index'); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'web-index-shift.png') });
  console.log('shot-web-index-shift.png');

  await browser.close();

  if (errs.length) {
    console.error('页面错误:\n' + errs.join('\n'));
    process.exit(1);
  }
  console.log('done, no page errors');
  process.exit(0);
})();
