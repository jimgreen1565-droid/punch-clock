/**
 * Web 版交互回归测试（真实 Chrome + 真实 geolocation）
 *
 * 为什么必须有：Web 版没有小程序框架，弹层、按钮、确认回调全部手写，
 * 这类代码最容易出现「按钮点了没反应」这种静默 bug——它不会抛错，
 * 只会让功能悄悄失效。开发中真踩了一个：closeSheet() 把回调置空，
 * 导致所有「确定」按钮全部无效（外勤打卡、规则切换、补卡、改时间全废）。
 *
 * 运行：node tests/web.test.js
 * 需要：本机 Chrome + playwright-core（脚本会自动向上找）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.join(__dirname, '..');
const ENTRY = 'file:///' + path.join(ROOT, 'webapp', 'index.html').replace(/\\/g, '/');

let chromium = null;
for (const c of ['playwright-core', path.join(ROOT, '..', 'node_modules', 'playwright-core')]) {
  try { chromium = require(c).chromium; break; } catch (e) { /* next */ }
}

const skip = !chromium || !fs.existsSync(CHROME)
  ? '需要 playwright-core 与 Chrome（' + CHROME + '）'
  : false;

async function open(opts) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext(
    Object.assign(
      {
        viewport: { width: 390, height: 844 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        geolocation: { latitude: 39.90871, longitude: 116.397412, accuracy: 22 },
        permissions: ['geolocation'],
      },
      opts || {}
    )
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(ENTRY, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  return { browser, page, errors };
}

/** 弹层是否展开 */
function sheetOpen(page) {
  return page.evaluate(() => document.getElementById('mask').classList.contains('show'));
}

/** 点确认并等弹层关闭 */
async function confirmSheet(page) {
  await page.click('#sheetConfirm');
  await page.waitForTimeout(350);
}

test('页面加载无报错，core 模块齐全，默认固定班制', { skip }, async () => {
  const { browser, page, errors } = await open();
  try {
    const info = await page.evaluate(() => ({
      keys: Object.keys(window.PC || {}),
      title: document.getElementById('navTitle').textContent,
      label: document.querySelector('.btn-label') && document.querySelector('.btn-label').textContent,
      chain: window.PC.ledger.verifyChain(window.__pc.db().records).ok,
      rules: window.PC.rules.normalizeRuleSet(window.__pc.db().ruleSet).type,
    }));
    assert.deepEqual(info.keys.sort(), ['geo', 'ledger', 'rules', 'sha256']);
    assert.equal(info.title, '考勤打卡');
    assert.equal(info.rules, 'fixed');
    assert.equal(info.chain, true, '示例数据的哈希链必须完整');
    assert.ok(info.label, '打卡按钮要有文案');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('★ 弹层「确定」回调必须生效（曾是静默失效的 bug）', { skip }, async () => {
  const { browser, page, errors } = await open();
  try {
    const before = await page.evaluate(() => window.__pc.db().records.length);

    // 打卡 -> 可能弹「未定位」层 -> 确定后必须真的写进记录
    await page.click('#punchBtn');
    await page.waitForTimeout(350);
    if (await sheetOpen(page)) await confirmSheet(page);

    await page.click('#punchBtn');
    await page.waitForTimeout(350);
    if (await sheetOpen(page)) await confirmSheet(page);

    const after = await page.evaluate(() => window.__pc.db().records.length);
    assert.ok(after > before, '确认按钮必须真的写入记录，实际 ' + before + ' -> ' + after);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('已完成状态：按钮显示已完成，点击弹确认而非直接写入', { skip }, async () => {
  const { browser, page } = await open();
  try {
    for (let i = 0; i < 2; i++) {
      await page.click('#punchBtn');
      await page.waitForTimeout(350);
      if (await sheetOpen(page)) await confirmSheet(page);
    }
    const st = await page.evaluate(() => ({
      label: document.querySelector('.btn-label').textContent,
      done: document.querySelector('.punch-btn').classList.contains('is-done'),
      n: window.__pc.db().records.length,
    }));
    assert.equal(st.label, '已完成');
    assert.equal(st.done, true);

    await page.click('#punchBtn');
    await page.waitForTimeout(300);
    const sheet = await page.evaluate(() => ({
      open: document.getElementById('mask').classList.contains('show'),
      title: document.getElementById('sheetTitle').textContent,
      n: window.__pc.db().records.length,
    }));
    assert.equal(sheet.open, true, '已完成时应弹确认层');
    assert.equal(sheet.title, '今日已完成打卡');
    assert.equal(sheet.n, st.n, '未确认前不应写入记录');

    // 取消不写入
    await page.click('#sheetCancel');
    await page.waitForTimeout(250);
    const afterCancel = await page.evaluate(() => window.__pc.db().records.length);
    assert.equal(afterCancel, st.n, '取消不应写入');

    // 确认可补一条
    await page.click('#punchBtn');
    await page.waitForTimeout(250);
    await confirmSheet(page);
    const afterAdd = await page.evaluate(() => ({
      n: window.__pc.db().records.length,
      chain: window.PC.ledger.verifyChain(window.__pc.db().records).ok,
    }));
    assert.equal(afterAdd.n, st.n + 1, '确认后应补一条');
    assert.equal(afterAdd.chain, true, '补一条后链仍完整');
  } finally {
    await browser.close();
  }
});

test('四种规则切换，首页文案都正确且不报错', { skip }, async () => {
  const { browser, page, errors } = await open();
  try {
    // 先把"今天"设成工作日：否则遇到周末首页会走休息日空态，压根没有指标卡可断言。
    // 这不是测试作弊，而是让断言不依赖"测试当天是不是周末"这种外部变量。
    await page.evaluate(() => {
      const R = window.PC.rules;
      const db = window.__pc.db();
      const wd = R.partsOf(Date.now()).weekday;
      const cur = R.normalizeRuleSet(db.ruleSet).weekdays;
      db.ruleSet = R.normalizeRuleSet(
        Object.assign({}, db.ruleSet, { weekdays: cur.concat([wd]).sort((a, b) => a - b) })
      );
      localStorage.setItem('pc_web_v2', JSON.stringify(db));
      window.__pc.go('index');
    });
    await page.waitForTimeout(300);

    const cases = [
      { type: 'flexible', chip: '弹性工作制', key: '还需工时' },
      { type: 'shift', chip: '排班制', key: /应满工时|实际工时/ },
      { type: 'free', chip: '自由工时', key: /目标工时|已满/ },
      { type: 'fixed', chip: '固定班制', key: /应满工时|实际工时/ },
    ];
    for (const c of cases) {
      await page.evaluate((t) => window.__pc.rule(t), c.type);
      await page.waitForTimeout(250);
      const got = await page.evaluate(() => {
        const chip = document.querySelector('.rule-chip');
        const keys = document.querySelectorAll('.m-key');
        return {
          chip: chip ? chip.textContent.replace('›', '').replace(/^\s*/, '').trim() : '',
          key: keys[1] ? keys[1].textContent : '',
          caption: document.querySelector('.caption-text') ? document.querySelector('.caption-text').textContent : '',
        };
      });
      assert.match(got.chip, new RegExp(c.chip), c.type + ' 的规则名');
      if (c.key instanceof RegExp) assert.match(got.key, c.key, c.type + ' 的工时可指标签');
      else assert.equal(got.key, c.key, c.type + ' 的工时可指标签');
      assert.ok(got.caption.length > 0, c.type + ' 应有说明文案');
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('规则页：切换规则要二次确认，取消则不变', { skip }, async () => {
  const { browser, page } = await open();
  try {
    await page.evaluate(() => window.__pc.go('rules'));
    await page.waitForTimeout(300);

    await page.click('[data-type="flexible"]');
    await page.waitForTimeout(300);
    assert.equal(await sheetOpen(page), true, '切换规则应弹确认');

    await page.click('#sheetCancel');
    await page.waitForTimeout(250);
    const unchanged = await page.evaluate(() => window.PC.rules.normalizeRuleSet(window.__pc.db().ruleSet).type);
    assert.equal(unchanged, 'fixed', '取消后不应切换');

    await page.click('[data-type="flexible"]');
    await page.waitForTimeout(300);
    await confirmSheet(page);
    const changed = await page.evaluate(() => ({
      type: window.PC.rules.normalizeRuleSet(window.__pc.db().ruleSet).type,
      chip: document.querySelector('.cur-badge').textContent,
    }));
    assert.equal(changed.type, 'flexible');
    assert.equal(changed.chip, '弹性工作制');
  } finally {
    await browser.close();
  }
});

test('规则页：改时间必须校验格式（非法输入被拒）', { skip }, async () => {
  const { browser, page } = await open();
  try {
    await page.evaluate(() => window.__pc.go('rules'));
    await page.waitForTimeout(300);

    // 合法
    await page.click('[data-act="edit"][data-field="start"]');
    await page.waitForTimeout(300);
    await page.fill('#sheetInput', '08:30');
    await confirmSheet(page);
    let start = await page.evaluate(() => window.PC.rules.normalizeRuleSet(window.__pc.db().ruleSet).start);
    assert.equal(start, '08:30');

    // 非法
    await page.click('[data-act="edit"][data-field="start"]');
    await page.waitForTimeout(300);
    await page.fill('#sheetInput', '25:99');
    await confirmSheet(page);
    start = await page.evaluate(() => window.PC.rules.normalizeRuleSet(window.__pc.db().ruleSet).start);
    assert.equal(start, '08:30', '非法时间必须被拒，不能写进配置');
  } finally {
    await browser.close();
  }
});

test('外勤打卡：范围外填原因才允许写入', { skip }, async () => {
  const { browser, page } = await open({
    geolocation: { latitude: 40.5, longitude: 117.5, accuracy: 30 },
  });
  try {
    const before = await page.evaluate(() => window.__pc.db().records.length);

    await page.click('#outside');
    await page.waitForTimeout(300);
    // 空原因 -> 不写入
    await page.fill('#sheetInput', '   ');
    await confirmSheet(page);
    let n = await page.evaluate(() => window.__pc.db().records.length);
    assert.equal(n, before, '空原因不应写入');

    await page.click('#outside');
    await page.waitForTimeout(300);
    await page.fill('#sheetInput', '客户现场');
    await confirmSheet(page);
    const res = await page.evaluate(() => ({
      n: window.__pc.db().records.length,
      note: window.__pc.db().records.slice(-1)[0].note,
      dist: window.__pc.db().records.slice(-1)[0].dist,
    }));
    assert.equal(res.n, before + 1, '填了原因应写入');
    assert.equal(res.note, '客户现场');
    assert.ok(res.dist > 300, '外勤记录的距离应超过范围半径');
  } finally {
    await browser.close();
  }
});

test('记录页：链校验、月份切换、补卡申请', { skip }, async () => {
  const { browser, page } = await open();
  try {
    await page.evaluate(() => window.__pc.go('records'));
    await page.waitForTimeout(350);

    const c = await page.evaluate(() => ({
      title: document.querySelector('.chain-title').textContent,
      sub: document.querySelector('.chain-sub').textContent,
      week: document.querySelectorAll('.wb-day').length,
    }));
    assert.equal(c.title, '记录完整');
    assert.equal(c.week, 7);
    assert.ok(c.sub.indexOf('条记录完整') >= 0);

    const m0 = await page.evaluate(() => window.__pc.state.month);
    await page.click('[data-nav="-1"]');
    await page.waitForTimeout(300);
    const m1 = await page.evaluate(() => window.__pc.state.month);
    assert.notEqual(m1, m0, '上月应切换');

    // 展开一天并申请补卡（回到当月后必须重新渲染，否则 DOM 还停在别的月份）
    await page.evaluate(() => {
      window.__pc.state.month = window.PC.rules.monthKeyOf(Date.now());
      window.__pc.go('records');
    });
    await page.waitForTimeout(350);
    await page.evaluate(() => { const d = document.querySelectorAll('[data-day]'); if (d.length) d[0].click(); });
    await page.waitForTimeout(350);

    const dayKey = await page.evaluate(() => {
      const rows = document.querySelectorAll('[data-patch]');
      return rows.length ? rows[0].getAttribute('data-patch') : null;
    });
    assert.ok(dayKey, '展开后应有补卡入口');

    await page.click('[data-patch]');
    await page.waitForTimeout(300);
    await page.fill('#sheetInput', '忘记打卡');
    await confirmSheet(page);

    const patches = await page.evaluate(() => window.__pc.db().patches.filter((p) => p.status === 'pending').length);
    assert.ok(patches >= 1, '补卡申请应进入待审批');
  } finally {
    await browser.close();
  }
});

test('哈希链：外部篡改 localStorage 后校验必须失败', { skip }, async () => {
  const { browser, page } = await open();
  try {
    await page.evaluate(() => {
      const d = JSON.parse(localStorage.getItem('pc_web_v2'));
      d.records[0].dist = 5;                     // 改一个参与哈希的字段
      localStorage.setItem('pc_web_v2', JSON.stringify(d));
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__pc.go('records'));
    await page.waitForTimeout(300);

    const c = await page.evaluate(() => ({
      title: document.querySelector('.chain-title').textContent,
      sub: document.querySelector('.chain-sub').textContent,
      ok: window.PC.ledger.verifyChain(window.__pc.db().records).ok,
    }));
    assert.equal(c.ok, false, '篡改后校验必须失败');
    assert.equal(c.title, '记录被改动');
    assert.ok(c.sub.indexOf('校验失败') >= 0);
  } finally {
    await browser.close();
  }
});

test('我的页：导出 JSON 不含任何薪酬字段', { skip }, async () => {
  const { browser, page } = await open();
  try {
    await page.evaluate(() => window.__pc.go('me'));
    await page.waitForTimeout(300);
    const dump = await page.evaluate(() => {
      const d = window.__pc.db();
      return JSON.stringify({
        boot: d.boot, ruleSet: d.ruleSet, records: d.records, patches: d.patches, presets: d.presets,
      });
    });
    const banned = ['salary', 'payroll', 'wage', 'deduct', '"pay"'];
    banned.forEach((k) => {
      assert.equal(dump.indexOf(k), -1, '导出内容不应包含 ' + k);
    });
    const menus = await page.evaluate(() => document.querySelectorAll('.menu-item').length);
    assert.ok(menus >= 5, '我的页应有菜单项');
  } finally {
    await browser.close();
  }
});
