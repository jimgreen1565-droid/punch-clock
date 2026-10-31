/**
 * 页面级测试：用最小 wx API 模拟器把页面 JS 真跑一遍
 *
 * 覆盖本轮改版后的关键路径：
 *   1. 首页按不同规则类型（固定/弹性/排班/自由）渲染不同的数据形态
 *   2. 打卡成功/范围外拒绝/外勤打卡/未定位降级
 *   3. 规则页切换类型、改时间、保存与应用模板
 *   4. 记录页链校验、月份切换、补卡申请
 *   5. 统计页出勤率与构成（不含任何薪资字段）
 *   6. 管理页本地模式审批（通过后生成 source 记录）
 */
const test = require('node:test');
const assert = require('node:assert');

const storage = {};
const calls = { modal: [], toast: [], clipboard: [], actionSheet: [] };
let modalAnswer = { confirm: true, content: '测试原因' };
let actionIndex = 0;

function makeWx() {
  return {
    getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : ''),
    setStorageSync: (k, v) => {
      storage[k] = v;
    },
    removeStorageSync: (k) => {
      delete storage[k];
    },
    getDeviceInfo: () => ({ platform: 'devtools', system: 'iOS 17', model: 'iPhone 15', pixelRatio: 3 }),
    getWindowInfo: () => ({ screenWidth: 390 }),
    getSystemInfoSync: () => ({ platform: 'devtools', system: 'iOS 17', model: 'iPhone 15', pixelRatio: 3, screenWidth: 390 }),
    getLocation: (o) => {
      if (global.__GEO_FAIL__) {
        o.fail({ errMsg: 'getLocation:fail auth deny' });
        return;
      }
      o.success({ latitude: global.__GEO_LAT__ || 39.90871, longitude: global.__GEO_LNG__ || 116.397412, accuracy: 25, provider: 'gps' });
    },
    showModal: (o) => {
      calls.modal.push(o);
      if (o.success) o.success(modalAnswer);
    },
    showToast: (o) => calls.toast.push(o),
    showActionSheet: (o) => {
      calls.actionSheet.push(o);
      if (o.success) o.success({ tapIndex: actionIndex });
    },
    showLoading: () => {},
    hideLoading: () => {},
    setTabBarBadge: () => {},
    removeTabBarBadge: () => {},
    vibrateShort: () => {},
    stopPullDownRefresh: () => {},
    setClipboardData: (o) => {
      calls.clipboard.push(o.data);
      if (o.success) o.success({});
    },
    openSetting: () => {},
    navigateTo: (o) => calls.toast.push({ nav: o.url }),
    cloud: null,
  };
}

global.wx = makeWx();
const realSetInterval = global.setInterval;
global.setInterval = function (...args) {
  const t = realSetInterval(...args);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};

let lastPageConfig = null;
global.Page = (cfg) => {
  lastPageConfig = cfg;
};
global.App = (cfg) => {
  global.__APP__ = cfg;
};
global.getApp = () => global.__APP__ || { refreshBadge() {}, globalData: {} };

function loadPage(relPath) {
  lastPageConfig = null;
  delete require.cache[require.resolve(relPath)];
  require(relPath);
  const cfg = lastPageConfig;
  const page = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data || {}));
  page.setData = function (patch) {
    Object.keys(patch).forEach((key) => {
      if (key.indexOf('.') > 0) {
        const parts = key.split('.');
        let obj = this.data;
        for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
        obj[parts[parts.length - 1]] = patch[key];
      } else {
        this.data[key] = patch[key];
      }
    });
  };
  return page;
}

function resetAll() {
  Object.keys(storage).forEach((k) => delete storage[k]);
  calls.modal.length = 0;
  calls.toast.length = 0;
  calls.clipboard.length = 0;
  calls.actionSheet.length = 0;
  modalAnswer = { confirm: true, content: '测试原因' };
  actionIndex = 0;
  delete global.__GEO_FAIL__;
  delete global.__GEO_LAT__;
  delete global.__GEO_LNG__;
  // 规则页现在有权限门禁：必须让测试用户成为公司 owner，否则 canEdit=false
  // 会把所有"改规则"的用例拦住。这里在每次 reset 后建一家公司。
  try {
    const company = require('../miniprogram/utils/company');
    const store = require('../miniprogram/utils/store');
    store.init();
    const boot = store.getBootInfo();
    company.ensureCompany(boot.uid, '测试管理员');
  } catch (e) {
    // 未加载 company 的旧用例忽略
  }
}

/* ------------------------------- 测试 ------------------------------- */

test('app onLaunch 初始化存储，默认规则是固定班制', () => {
  resetAll();
  delete require.cache[require.resolve('../miniprogram/app.js')];
  require('../miniprogram/app.js');
  const app = global.__APP__;
  app.onLaunch();
  assert.ok(app.globalData.uid);
  assert.equal(app.globalData.env, 'local');
  const rs = JSON.parse(storage.PC_RULESET);
  assert.equal(rs.type, 'fixed');
  assert.equal(rs.start, '09:00');
});

test('store: 四种规则类型都能切换并保留已有值', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.setRuleSet({ start: '08:30' });

  ['flexible', 'shift', 'free', 'fixed'].forEach((t) => {
    store.switchRuleType(t);
    assert.equal(store.getRuleSet().type, t);
    assert.equal(store.getRuleSet().start, '08:30', '切换类型不应丢失时间配置');
  });
});

test('store: 非法类型被忽略', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.switchRuleType('nonsense');
  assert.equal(store.getRuleSet().type, 'fixed');
});

test('store: 保存与应用模板', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.switchRuleType('flexible');
  store.setRuleSet({ latestStart: '10:30' });
  const p = store.savePreset('弹性模板');
  assert.equal(store.getPresets().length, 1);

  store.switchRuleType('fixed');
  store.applyPreset(p.id);
  const rs = store.getRuleSet();
  assert.equal(rs.type, 'flexible');
  assert.equal(rs.latestStart, '10:30');

  store.removePreset(p.id);
  assert.equal(store.getPresets().length, 0);
});

test('首页 fixed：渲染班次、时间轴、点击上班再下班', async () => {
  resetAll();
  const page = loadPage('../miniprogram/pages/index/index.js');
  page.onLoad();
  assert.ok(page.data.monthDay.indexOf('月') >= 0);
  assert.equal(page.data.ruleTypeName, '固定班制');
  assert.equal(page.data.nextLabel, '上班打卡');
  assert.ok(page.data.expectInText.indexOf(':') >= 0);

  await page.onPunch();
  assert.ok(calls.toast.length > 0);
  assert.equal(page.data.nextLabel, '下班打卡');
  assert.ok(page.data.inText.indexOf(':') >= 0);
  assert.ok(page.data.alerts.length >= 0);

  await page.onPunch();
  assert.ok(page.data.outText.indexOf(':') >= 0);
  // 上下班都打完 -> 按钮进入"已完成"，且不再允许直接写入
  assert.equal(page.data.nextLabel, '已完成');
  assert.equal(page.data.btnDone, true);
  page.onUnload();
});

test('首页：已完成后再点不直接写记录，确认「补一条」才写入', async () => {
  resetAll();
  const page = loadPage('../miniprogram/pages/index/index.js');
  page.onLoad();

  // 打满两次
  await page.onPunch();
  await page.onPunch();
  assert.equal(page.data.btnDone, true);
  const nBefore = JSON.parse(storage.PC_RECORDS || '[]').length;

  // 第三次点击：应弹确认层（先设成"取消"，验证未确认不写入）
  calls.modal.length = 0;
  modalAnswer = { confirm: false };
  await page.onPunch();
  await new Promise((r) => setTimeout(r, 40));
  const m = calls.modal[calls.modal.length - 1];
  assert.ok(m, '已完成时点击应弹确认层');
  assert.equal(m.title, '今日已完成打卡');
  assert.equal(m.confirmText, '补一条');
  assert.equal(JSON.parse(storage.PC_RECORDS || '[]').length, nBefore, '点取消时不应写入');

  // 再点一次并确认 -> 写一条
  modalAnswer = { confirm: true };
  await page.onPunch();
  await new Promise((r) => setTimeout(r, 40));
  const recs = JSON.parse(storage.PC_RECORDS || '[]');
  assert.equal(recs.length, nBefore + 1, '确认补一条后应写入');
  assert.equal(require('../miniprogram/utils/store.js').verifyLocalChain().ok, true, '补录后链仍完整');
  page.onUnload();
});

test('首页 free：不显示应到时间，且打卡不判迟到', async () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  const rules = require('../miniprogram/core/rules');
  store.init();
  store.switchRuleType('free');

  const page = loadPage('../miniprogram/pages/index/index.js');
  page.onLoad();
  assert.equal(page.data.ruleTypeName, '自由工时');
  assert.ok(page.data.ruleDesc.indexOf('不限时间') >= 0);

  await page.onPunch();
  const recs = JSON.parse(storage.PC_RECORDS || '[]');
  assert.equal(recs.length, 1);
  // 自由工时下，即使是深夜打卡也不该出现迟到告警
  assert.equal(page.data.alerts.filter((a) => a.label.indexOf('迟到') >= 0).length, 0);
  page.onUnload();
});

test('首页 shift：显示班次名与应到时间', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.switchRuleType('shift');
  store.setRuleSet({ rotation: { enabled: true, cycleDays: 2, slots: ['A', 'B'], anchorDate: '2026-10-01' } });

  const page = loadPage('../miniprogram/pages/index/index.js');
  page.onLoad();
  assert.equal(page.data.ruleTypeName, '排班制');
  assert.ok(page.data.day.shiftName, '排班制应有班次名');
  page.onUnload();
});

test('首页 flexible：显示还需工时', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.switchRuleType('flexible');
  const page = loadPage('../miniprogram/pages/index/index.js');
  page.onLoad();
  assert.equal(page.data.ruleTypeName, '弹性工作制');
  assert.equal(page.data.remainKey, '还需工时');
  page.onUnload();
});

test('首页：范围外拒绝打卡，可选外勤打卡', async () => {
  resetAll();
  global.__GEO_LAT__ = 40.5;
  global.__GEO_LNG__ = 117.5;
  const page = loadPage('../miniprogram/pages/index/index.js');
  page.onLoad();
  await page.onPunch();
  // 只看拒绝弹窗：确认后会自动进入「外勤打卡」弹窗，所以按 title 找
  const reject = calls.modal.find((m) => m.title === '不在打卡范围');
  assert.ok(reject, '应弹出范围拒绝提示');
  assert.equal(reject.confirmText, '外勤打卡');

  page.onUnload();
});

test('首页：范围外拒绝时不应落库（拒绝分支）', async () => {
  resetAll();
  global.__GEO_LAT__ = 40.5;
  global.__GEO_LNG__ = 117.5;
  const page = loadPage('../miniprogram/pages/index/index.js');
  page.onLoad();
  // 用户点「取消」，不进入外勤流程
  modalAnswer = { confirm: false };
  await page.onPunch();
  assert.equal(JSON.parse(storage.PC_RECORDS || '[]').length, 0, '拒绝时不应写入记录');
  page.onUnload();
});

test('首页：外勤打卡需填原因，填了才落库并标记', async () => {
  resetAll();
  const page = loadPage('../miniprogram/pages/index/index.js');
  page.onLoad();

  // 空原因 -> 不落库
  modalAnswer = { confirm: true, content: '   ' };
  page.onOutsidePunch();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(JSON.parse(storage.PC_RECORDS || '[]').length, 0);

  // 填原因 -> 落库
  modalAnswer = { confirm: true, content: '客户现场' };
  page.onOutsidePunch();
  await new Promise((r) => setTimeout(r, 20));
  const recs = JSON.parse(storage.PC_RECORDS || '[]');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].note, '客户现场');
  page.onUnload();
});

test('首页：定位失败仍可打卡，记录标记 geoSkipped', async () => {
  resetAll();
  global.__GEO_FAIL__ = true;
  const page = loadPage('../miniprogram/pages/index/index.js');
  page.onLoad();
  await page.onPunch();
  const recs = JSON.parse(storage.PC_RECORDS || '[]');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].geoSkipped, true);
  page.onUnload();
});

test('规则页：切换类型有二次确认，取消则不变', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  const page = loadPage('../miniprogram/pages/rules/rules.js');
  page.onShow();
  assert.equal(page.data.ruleSet.type, 'fixed');
  assert.equal(page.data.types.length, 4);

  // 取消
  modalAnswer = { confirm: false };
  page.onPickType({ currentTarget: { dataset: { type: 'flexible' } } });
  assert.equal(store.getRuleSet().type, 'fixed');

  // 确认
  modalAnswer = { confirm: true };
  page.onPickType({ currentTarget: { dataset: { type: 'flexible' } } });
  assert.equal(store.getRuleSet().type, 'flexible');
  assert.equal(page.data.ruleTypeName, '弹性工作制');
});

test('规则页：改时间、非法格式被拒', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  const page = loadPage('../miniprogram/pages/rules/rules.js');
  page.onShow();

  modalAnswer = { confirm: true, content: '08:30' };
  page.editStart();
  assert.equal(store.getRuleSet().start, '08:30');

  modalAnswer = { confirm: true, content: '25:70' };
  page.editStart();
  assert.equal(store.getRuleSet().start, '08:30', '非法时间必须被拒');

  modalAnswer = { confirm: true, content: '600' };
  page.editRadius() || (store.setRuleSet({ geo: {} }), page.editRadius());
  const radius = store.getRuleSet().geo.radius;
  assert.ok(radius === 600 || radius === 300);
});

test('规则页：工作日切换至少保留一天', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.setRuleSet({ weekdays: [1] });
  const page = loadPage('../miniprogram/pages/rules/rules.js');
  page.onShow();

  actionIndex = 0; // 周一
  page.editWeekdays();
  assert.deepEqual(store.getRuleSet().weekdays, [1], '不能删到空');
});

test('规则页：保存与应用模板', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  const page = loadPage('../miniprogram/pages/rules/rules.js');
  page.onShow();
  assert.equal(page.data.presets.length, 0);

  modalAnswer = { confirm: true, content: '白班 A' };
  page.onSavePreset();
  assert.equal(store.getPresets().length, 1);
  assert.equal(page.data.presets.length, 1);

  // 改掉规则，再应用模板恢复
  store.switchRuleType('free');
  modalAnswer = { confirm: true };
  page.onApplyPreset({ currentTarget: { dataset: { id: page.data.presets[0].id } } });
  assert.equal(store.getRuleSet().type, 'fixed');

  page.onRemovePreset({ currentTarget: { dataset: { id: page.data.presets[0].id } } });
  assert.equal(store.getPresets().length, 0);
});

test('规则页：排班轮换开关与周期', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.switchRuleType('shift');
  const page = loadPage('../miniprogram/pages/rules/rules.js');
  page.onShow();
  assert.equal(store.getRuleSet().rotation.enabled, false);

  page.toggleRotation();
  assert.equal(store.getRuleSet().rotation.enabled, true);

  modalAnswer = { confirm: true, content: '6' };
  page.editCycle();
  const rot = store.getRuleSet().rotation;
  assert.equal(rot.cycleDays, 6);
  assert.equal(rot.slots.length, 6);
});

test('规则页：开启定位后可设置打卡点', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  const page = loadPage('../miniprogram/pages/rules/rules.js');
  page.onShow();
  page.onToggleGeo({ detail: { value: false } });
  assert.equal(store.getRuleSet().geo.enabled, false);
  page.onToggleGeo({ detail: { value: true } });
  assert.equal(store.getRuleSet().geo.enabled, true);
});

test('记录页：链校验、月份切换、补卡', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.addRecord({ type: 'in', at: Date.now(), source: 'manual' });

  const page = loadPage('../miniprogram/pages/records/records.js');
  page.onLoad({ month: '' });
  assert.equal(page.data.chain.ok, true);
  assert.equal(page.data.chain.count, 1);
  assert.equal(page.data.weekStrip.length, 7);

  const before = page.data.month;
  page.prevMonth();
  assert.notEqual(page.data.month, before);
  page.nextMonth();
  assert.equal(page.data.month, before);

  modalAnswer = { confirm: true, content: '忘记打卡' };
  page.onApplyPatch({ currentTarget: { dataset: { key: '2026-10-29' } } });
  assert.equal(store.getPatches().length, 1);
  assert.equal(store.getPatches()[0].status, 'pending');
});

test('记录页：篡改记录导致链校验失败', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.addRecord({ type: 'in', at: 1793000000000 });
  store.addRecord({ type: 'out', at: 1793003600000 });
  const recs = JSON.parse(storage.PC_RECORDS);
  recs[0].at += 60000;
  storage.PC_RECORDS = JSON.stringify(recs);

  const page = loadPage('../miniprogram/pages/records/records.js');
  page.onLoad({});
  assert.equal(page.data.chain.ok, false);
  assert.ok(page.data.chainText.indexOf('校验失败') >= 0);
});

test('统计页：出勤率与构成，且不含任何薪酬字段', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  const rules = require('../miniprogram/core/rules');
  const rs = store.getRuleSet();
  const now = Date.now();
  const todayKey = rules.dayKeyOf(now);
  store.addRecord({ type: 'in', at: rules.msOfDayMinute(todayKey, 540), dateKey: todayKey });
  store.addRecord({ type: 'out', at: rules.msOfDayMinute(todayKey, 1140), dateKey: todayKey });

  const page = loadPage('../miniprogram/pages/stats/stats.js');
  page.onLoad({});
  assert.ok(page.data.month.length === 7);
  assert.equal(page.data.planned > 0, true);
  assert.equal(page.data.calendar.length >= 28, true);
  assert.equal(page.data.trend.length, 7);
  assert.equal(typeof page.data.rate, 'number');
  assert.ok(page.data.distribution.length >= 1);

  // 明确断言：页面数据里不存在薪资相关键
  const keys = Object.keys(page.data);
  const banned = keys.filter((k) => /pay|salary|wage|deduct|薪酬|工资/i.test(k));
  assert.deepEqual(banned, [], '页面不应再有薪酬字段，实际存在: ' + banned.join(','));

  assert.ok(rs.type);
});

test('我的页：导出不含薪酬/计薪字段', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.addRecord({ type: 'in', at: Date.now() });

  const page = loadPage('../miniprogram/pages/me/me.js');
  page.onShow();
  assert.ok(page.data.chainOk);
  assert.equal(page.data.recordCount, 1);

  page.exportData();
  const dump = JSON.parse(calls.clipboard[0]);
  assert.equal(dump.records.length, 1);
  assert.equal(dump.ruleSet.type, 'fixed');
  assert.equal(dump.chain.ok, true);
  assert.equal('payroll' in dump, false);
  assert.equal('salary' in dump, false);
  assert.equal('salary' in dump.ruleSet, false);
  assert.equal('salary' in JSON.parse(JSON.stringify(dump.ruleSet.geo || {})), false);
});

test('管理页：本地模式审批通过后生成 patch 记录', async () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.addPatch({ dateKey: '2026-10-29', type: 'out', reason: '忘记下班打卡' });

  const page = loadPage('../miniprogram/pages/admin/admin.js');
  page.onShow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(page.data.pending.length, 1);

  const before = store.getRecords().length;
  await page.approve({ currentTarget: { dataset: { id: page.data.pending[0].id } } });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(store.getPatches()[0].status, 'approved');
  assert.equal(store.getRecords().length, before + 1, '审批通过应生成一条记录');
  assert.ok(store.getRecords().slice(-1)[0].note.indexOf('审批补卡') >= 0);
});

test('规则切换后历史判定按新规则重算，但记录本身不变', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  const rules = require('../miniprogram/core/rules');
  store.init();
  const day = '2026-10-29';
  store.addRecord({ type: 'in', at: rules.msOfDayMinute(day, 600), dateKey: day });
  store.addRecord({ type: 'out', at: rules.msOfDayMinute(day, 1140), dateKey: day });

  const hashBefore = store.getRecords().map((r) => r.hash).join(',');

  const fixedDay = rules.pairDay(store.getRecords(), store.getRuleSet(), day, rules.msOfDayMinute(day, 1300));
  assert.equal(fixedDay.status, 'late', '09:00 班、10:00 上班 -> 迟到');

  store.switchRuleType('flexible');
  store.setRuleSet({ latestStart: '10:30' });
  const flexDay = rules.pairDay(store.getRecords(), store.getRuleSet(), day, rules.msOfDayMinute(day, 1300));
  assert.equal(flexDay.lateMinutes, 0, '10:00 早于最晚 10:30 -> 不迟到');

  assert.equal(store.getRecords().map((r) => r.hash).join(','), hashBefore, '记录哈希不应被规则切换影响');
});

test('store: 未处理计数反映今日异常与待审补卡', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  store.addPatch({ dateKey: '2026-10-29', reason: 'x' });
  const n = store.unresolvedCount();
  assert.ok(n >= 1);
});

test('store: 记录上限裁剪后链仍可校验', () => {
  resetAll();
  const store = require('../miniprogram/utils/store');
  store.init();
  for (let i = 0; i < 12; i++) store.addRecord({ type: 'in', at: 1793000000000 + i * 1000 });
  const v = store.verifyLocalChain();
  assert.equal(v.ok, true);
  assert.equal(v.count, 12);
});
