/**
 * 规则引擎单元测试（node --test 兼容，也可直接 node 跑）
 * 覆盖钉钉四种考勤模型的判定差异，这是最容易写错的部分。
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const rules = require('../miniprogram/core/rules');
const { sha256 } = require('../miniprogram/core/sha256');

/* --------------------------- SHA-256 / 时间基础 --------------------------- */

test('sha256 matches node crypto (ascii/unicode/surrogate/长串)', () => {
  const cases = ['', 'abc', '打卡上班 😀 测试', 'a'.repeat(1000), 'ｱｲｳｴｵ全角'];
  for (const s of cases) {
    assert.equal(sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), 'mismatch: ' + s.slice(0, 12));
  }
  for (let i = 0; i < 150; i++) {
    let s = '';
    const n = Math.floor(Math.random() * 200);
    for (let j = 0; j < n; j++) s += String.fromCharCode(32 + Math.floor(Math.random() * 0x2fff));
    assert.equal(sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});

test('dayKeyOf 固定 UTC+8，不跟随本地时区', () => {
  assert.equal(rules.dayKeyOf(Date.UTC(2026, 9, 30, 15, 59)), '2026-10-30'); // 23:59 北京
  assert.equal(rules.dayKeyOf(Date.UTC(2026, 9, 30, 16, 0)), '2026-10-31'); // 00:00 北京
  assert.equal(rules.hhmmOf(Date.UTC(2026, 9, 30, 16, 5)), '00:05');
  assert.equal(rules.partsOf(Date.UTC(2026, 9, 30, 16, 0)).weekday, 6); // 周六
});

test('monthInfo 处理 31/30/29/28 天', () => {
  assert.equal(rules.monthInfo('2026-10').days, 31);
  assert.equal(rules.monthInfo('2026-11').days, 30);
  assert.equal(rules.monthInfo('2026-02').days, 28);
  assert.equal(rules.monthInfo('2024-02').days, 29);
});

/* --------------------------- 规则集规整 --------------------------- */

test('normalizeRuleSet 对空/坏输入不抛错并填默认值', () => {
  const rs = rules.normalizeRuleSet(null);
  assert.equal(rs.type, 'fixed');
  assert.equal(rs.start, '09:00');
  assert.equal(rs.end, '18:00');
  assert.deepEqual(rs.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(rs.breakMinutes, 60);

  const bad = rules.normalizeRuleSet({ type: 'unknown', start: '25:99', weekdays: [0, 9], geo: null });
  assert.equal(bad.type, 'fixed', '非法 type 回落 fixed');
  assert.equal(bad.start, '09:00', '非法时间回落默认');
  assert.deepEqual(bad.weekdays, [1, 2, 3, 4, 5]);
});

test('normalizeRuleSet 保留四种合法 type', () => {
  ['fixed', 'flexible', 'shift', 'free'].forEach((t) => {
    assert.equal(rules.normalizeRuleSet({ type: t }).type, t);
  });
});

test('weekdaysText / describeRule 生成人话', () => {
  const rs = rules.normalizeRuleSet({});
  assert.equal(rules.weekdaysText([1, 2, 3, 4, 5]), '周一至周五');
  assert.equal(rules.weekdaysText([1, 2, 3, 4, 5, 6]), '周一至周六');
  assert.equal(rules.weekdaysText([1, 2, 3, 4, 5, 6, 7]), '每天');
  assert.ok(rules.describeRule(rs).indexOf('09:00') >= 0);
  assert.ok(rules.describeRule({ type: 'free' }).indexOf('不限时间') >= 0);
});

/* --------------------------- 固定班制 --------------------------- */

test('fixed: 迟到在宽限内算正常，超出算迟到并记分钟', () => {
  const rs = rules.normalizeRuleSet({ type: 'fixed', start: '09:00', end: '18:00', lateGrace: 5 });
  const day = '2026-10-30';
  assert.equal(rules.classifyPunch({ ms: rules.msOfDayMinute(day, 543), type: 'in', dayKey: day, ruleSet: rs }).status, 'normal');
  const r = rules.classifyPunch({ ms: rules.msOfDayMinute(day, 552), type: 'in', dayKey: day, ruleSet: rs });
  assert.equal(r.status, 'late');
  assert.equal(r.lateMinutes, 12);
});

test('fixed: 早退与加班判定', () => {
  const rs = rules.normalizeRuleSet({ type: 'fixed', start: '09:00', end: '18:00', earlyGrace: 5, overtimeMin: 30 });
  const day = '2026-10-30';
  assert.equal(rules.classifyPunch({ ms: rules.msOfDayMinute(day, 1076), type: 'out', dayKey: day, ruleSet: rs }).status, 'normal');
  const early = rules.classifyPunch({ ms: rules.msOfDayMinute(day, 1050), type: 'out', dayKey: day, ruleSet: rs });
  assert.equal(early.status, 'early');
  assert.equal(early.earlyMinutes, 30);
  const ot = rules.classifyPunch({ ms: rules.msOfDayMinute(day, 1120), type: 'out', dayKey: day, ruleSet: rs });
  assert.equal(ot.overtimeMinutes, 40);
});

test('fixed: 周末不判迟到，算休息日到岗', () => {
  const rs = rules.normalizeRuleSet({ type: 'fixed', weekdays: [1, 2, 3, 4, 5] });
  const sat = '2026-10-31'; // 周六
  const r = rules.pairDay([{ dateKey: sat, type: 'in', at: rules.msOfDayMinute(sat, 600) }], rs, sat, rules.msOfDayMinute(sat, 780));
  assert.equal(r.restDay, true);
  assert.equal(r.lateMinutes, 0);
  assert.ok(r.flags.restDayWork);
});

/* --------------------------- 弹性工作制 --------------------------- */

test('flexible: 只要不晚于最晚上班时间就不算迟到', () => {
  const rs = rules.normalizeRuleSet({ type: 'flexible', latestStart: '10:00', requiredMinutes: 480, lateGrace: 5 });
  const day = '2026-10-30';
  assert.equal(rules.classifyPunch({ ms: rules.msOfDayMinute(day, 595), type: 'in', dayKey: day, ruleSet: rs }).status, 'normal');
  const late = rules.classifyPunch({ ms: rules.msOfDayMinute(day, 610), type: 'in', dayKey: day, ruleSet: rs });
  assert.equal(late.status, 'late');
  assert.equal(late.lateMinutes, 10);
});

test('flexible: 应下班时间随实际上班时间顺延', () => {
  const rs = rules.normalizeRuleSet({ type: 'flexible', latestStart: '10:00', earliestEnd: '17:30', requiredMinutes: 480, breakStart: '12:00', breakEnd: '13:00' });
  const day = '2026-10-30';
  // 09:00 上班 -> 应下班 = max(17:30, 09:00 + 480 工时 + 60 午休 = 18:00) = 18:00
  const recs = [{ dateKey: day, type: 'in', at: rules.msOfDayMinute(day, 540) }];
  const d1 = rules.pairDay(recs, rs, day, rules.msOfDayMinute(day, 1200));
  assert.equal(rules.hhmmOf(d1.expectOutAt), '18:00');

  // 10:00 上班 -> 19:00
  const recs2 = [{ dateKey: day, type: 'in', at: rules.msOfDayMinute(day, 600) }];
  const d2 = rules.pairDay(recs2, rs, day, rules.msOfDayMinute(day, 1200));
  assert.equal(rules.hhmmOf(d2.expectOutAt), '19:00');
});

test('flexible: 工时不足 15 分钟以内不判异常，超出判 under', () => {
  const rs = rules.normalizeRuleSet({ type: 'flexible', latestStart: '10:00', earliestEnd: '17:30', requiredMinutes: 480, breakStart: '', breakEnd: '' });
  const day = '2026-10-30';
  const inAt = rules.msOfDayMinute(day, 540); // 09:00
  const expectOut = inAt + 480 * 60000; // 17:00 -> 但 max(17:30) => 17:30
  // 17:45 下班，应 17:30 -> 晚了，不算不足
  const ok = rules.pairDay(
    [{ dateKey: day, type: 'in', at: inAt }, { dateKey: day, type: 'out', at: rules.msOfDayMinute(day, 1065) }],
    rs,
    day,
    rules.msOfDayMinute(day, 1200)
  );
  assert.equal(ok.shortMinutes, 0);
  assert.notEqual(ok.status, 'under');

  // 16:50 下班，应 17:30 -> 不足 40 分钟
  const short = rules.pairDay(
    [{ dateKey: day, type: 'in', at: inAt }, { dateKey: day, type: 'out', at: rules.msOfDayMinute(day, 1010) }],
    rs,
    day,
    rules.msOfDayMinute(day, 1200)
  );
  assert.equal(short.shortMinutes, 40);
  assert.equal(short.status, 'under');
  assert.ok(expectOut > 0);
});

/* --------------------------- 排班制 --------------------------- */

test('shift: 周期轮换按锚点日期算班次', () => {
  const rs = rules.normalizeRuleSet({
    type: 'shift',
    rotation: { enabled: true, cycleDays: 4, slots: ['A', 'A', 'B', 'REST'], anchorDate: '2026-10-01' },
    shifts: [
      { id: 'A', name: '早班', start: '08:00', end: '16:00' },
      { id: 'B', name: '中班', start: '16:00', end: '00:00' },
    ],
  });
  assert.equal(rules.shiftOfDay(rs, '2026-10-01').name, '早班');
  assert.equal(rules.shiftOfDay(rs, '2026-10-02').name, '早班');
  assert.equal(rules.shiftOfDay(rs, '2026-10-03').name, '中班');
  assert.equal(rules.shiftOfDay(rs, '2026-10-04').rest, true);
  // 循环回来
  assert.equal(rules.shiftOfDay(rs, '2026-10-05').name, '早班');
  assert.equal(rules.shiftOfDay(rs, '2026-10-08').rest, true);
});

test('shift: 跨天班次（16:00-00:00）下班卡归当天', () => {
  const rs = rules.normalizeRuleSet({
    type: 'shift',
    rotation: { enabled: true, cycleDays: 2, slots: ['B', 'B'], anchorDate: '2026-10-01' },
    shifts: [{ id: 'B', name: '中班', start: '16:00', end: '00:00' }],
  });
  assert.equal(rules.shiftOfDay(rs, '2026-10-01').shift.crossDay, true);
  // 23:59 打卡 -> 属于 10-01
  const ms = rules.msOfDayMinute('2026-10-01', 1439);
  assert.equal(rules.resolveShiftDay(ms, rs), '2026-10-01');
});

test('shift: 夜班 21:00-06:00 凌晨 3 点归前一天', () => {
  const rs = rules.normalizeRuleSet({
    type: 'shift',
    rotation: { enabled: true, cycleDays: 1, slots: ['N'], anchorDate: '2026-10-01' },
    shifts: [{ id: 'N', name: '夜班', start: '21:00', end: '06:00' }],
  });
  const at3am = rules.msOfDayMinute('2026-10-02', 180); // 10-02 03:00
  assert.equal(rules.dayKeyOf(at3am), '2026-10-02');
  assert.equal(rules.resolveShiftDay(at3am, rs), '2026-10-01', '凌晨应归前一天的夜班');
  // 21:30 上班归当天
  assert.equal(rules.resolveShiftDay(rules.msOfDayMinute('2026-10-02', 1290), rs), '2026-10-02');
});

test('shift: 未开轮换时按星期几决定工作日', () => {
  const rs = rules.normalizeRuleSet({ type: 'shift', rotation: { enabled: false }, weekdays: [1, 2, 3, 4, 5], start: '08:00', end: '16:00' });
  assert.equal(rules.shiftOfDay(rs, '2026-10-30').rest, false); // 周五
  assert.equal(rules.shiftOfDay(rs, '2026-10-31').rest, true); // 周六
});

/* --------------------------- 自由工时 --------------------------- */

test('free: 任何时间打卡都不判迟到早退', () => {
  const rs = rules.normalizeRuleSet({ type: 'free' });
  const day = '2026-10-30';
  const r = rules.classifyPunch({ ms: rules.msOfDayMinute(day, 1300), type: 'in', dayKey: day, ruleSet: rs }); // 21:40
  assert.equal(r.status, 'normal');
  assert.equal(r.lateMinutes, 0);
  assert.equal(r.restDay, false, '自由工时没有休息日概念');
  assert.equal(rules.shiftOfDay(rs, '2026-10-31').rest, false);
});

test('free: 一天多次打卡取最早上班与最晚下班累计工时', () => {
  const rs = rules.normalizeRuleSet({ type: 'free', breakStart: '', breakEnd: '' });
  const day = '2026-10-30';
  const recs = [
    { dateKey: day, type: 'in', at: rules.msOfDayMinute(day, 600) },
    { dateKey: day, type: 'out', at: rules.msOfDayMinute(day, 720) },
    { dateKey: day, type: 'in', at: rules.msOfDayMinute(day, 800) },
    { dateKey: day, type: 'out', at: rules.msOfDayMinute(day, 1100) },
  ];
  const d = rules.pairDay(recs, rs, day, rules.msOfDayMinute(day, 1200));
  assert.equal(d.inAt, rules.msOfDayMinute(day, 600));
  assert.equal(d.outAt, rules.msOfDayMinute(day, 1100));
  assert.equal(d.workMinutes, 500);
  assert.equal(d.status, 'normal');
});

/* --------------------------- 日汇总 --------------------------- */

test('pairDay 扣午休，8h32m', () => {
  const rs = rules.normalizeRuleSet({ type: 'fixed', start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' });
  const day = '2026-10-30';
  const recs = [
    { dateKey: day, type: 'in', at: rules.msOfDayMinute(day, 538) },
    { dateKey: day, type: 'out', at: rules.msOfDayMinute(day, 1110) },
  ];
  const d = rules.pairDay(recs, rs, day, rules.msOfDayMinute(day, 1200));
  assert.equal(d.workMinutes, 8 * 60 + 32);
});

test('pairDay 缺卡：上班窗口后 2 小时才判缺', () => {
  const rs = rules.normalizeRuleSet({ type: 'fixed' });
  const day = '2026-10-30';
  assert.equal(rules.pairDay([], rs, day, rules.msOfDayMinute(day, 600)).missingIn, false); // 10:00 还没到
  assert.equal(rules.pairDay([], rs, day, rules.msOfDayMinute(day, 720)).missingIn, true); // 12:00 已过
});

test('pairDay 全天无记录 -> absent（旷工）', () => {
  const rs = rules.normalizeRuleSet({ type: 'fixed' });
  const day = '2026-10-30';
  const d = rules.pairDay([], rs, day, rules.msOfDayMinute(day, 1260)); // 21:00
  assert.equal(d.status, 'absent');
  assert.equal(d.flags.absent, true);
});

test('pairDay 休息日绝不判缺卡/旷工', () => {
  const rs = rules.normalizeRuleSet({ type: 'fixed', weekdays: [1, 2, 3, 4, 5] });
  const sat = '2026-10-31';
  const d = rules.pairDay([], rs, sat, rules.msOfDayMinute(sat, 1300));
  assert.equal(d.restDay, true);
  assert.equal(d.status, 'rest');
  assert.equal(d.missingIn, false);
  assert.equal(d.missingOut, false);
  assert.equal(d.flags.absent, undefined);
});

/* --------------------------- 应出勤日 --------------------------- */

test('plannedDays 只列工作日，fixed 22 天', () => {
  const rs = rules.normalizeRuleSet({ type: 'fixed', weekdays: [1, 2, 3, 4, 5] });
  const days = rules.plannedDays('2026-10', rs);
  assert.equal(days.length, 22);
});

test('plannedDays 自由工时每天都算出勤', () => {
  const rs = rules.normalizeRuleSet({ type: 'free' });
  assert.equal(rules.plannedDays('2026-10', rs).length, 31);
});

test('plannedDays 排班制按排班表算', () => {
  const rs = rules.normalizeRuleSet({
    type: 'shift',
    rotation: { enabled: true, cycleDays: 4, slots: ['A', 'A', 'B', 'REST'], anchorDate: '2026-10-01' },
    shifts: [{ id: 'A', name: '早班', start: '08:00', end: '16:00' }, { id: 'B', name: '中班', start: '16:00', end: '00:00' }],
  });
  const days = rules.plannedDays('2026-10', rs);
  assert.equal(days.length, 24); // 31 天、4 天一轮休 1 天 -> 休 7 天，出勤 24 天
});

/* --------------------------- 规则集默认值（回归） --------------------------- */

test('缺省配置必须拿到默认宽限，不能变成 0（真实 bug 回归）', () => {
  // 曾经的写法 Number(src.lateGrace) === undefined ? 默认 : ... 永远走 else 分支，
  // 导致所有默认宽限变 0 —— 09:05 上班会被判迟到 5 分钟。
  const d = rules.normalizeRuleSet({});
  assert.equal(d.lateGrace, 5);
  assert.equal(d.earlyGrace, 5);
  assert.equal(d.overtimeMin, 30);
  assert.equal(d.requiredMinutes, 480);
  assert.equal(d.dailyTargetMinutes, 480);

  const day = '2026-10-30';
  // 09:05 上班，默认 5 分钟宽限 -> 应正常
  const r = rules.classifyPunch({ ms: rules.msOfDayMinute(day, 545), type: 'in', dayKey: day, ruleSet: d });
  assert.equal(r.status, 'normal', '09:05 在 5 分钟宽限内，必须是 normal');
  // classifyPunch 只在判为 late 时才回填分钟数；日常分钟数由 pairDay 负责（见下一条断言）
  assert.equal(r.lateMinutes, 0);

  // pairDay 记分钟数、但按宽限不判异常
  const pd = rules.pairDay(
    [
      { dateKey: day, type: 'in', at: rules.msOfDayMinute(day, 545) },
      { dateKey: day, type: 'out', at: rules.msOfDayMinute(day, 1080) },
    ],
    d,
    day,
    rules.msOfDayMinute(day, 1200)
  );
  assert.equal(pd.lateMinutes, 5, '分钟数照实记');
  assert.equal(pd.flags.late, undefined, '5 分钟在宽限内不标迟到');
  assert.notEqual(pd.status, 'late');
});

test('显式传 0 宽限时确实生效（不能把 0 当成缺省）', () => {
  const rs = rules.normalizeRuleSet({ lateGrace: 0, earlyGrace: 0, overtimeMin: 0 });
  assert.equal(rs.lateGrace, 0);
  assert.equal(rs.earlyGrace, 0);
  const day = '2026-10-30';
  assert.equal(rules.classifyPunch({ ms: rules.msOfDayMinute(day, 541), type: 'in', dayKey: day, ruleSet: rs }).status, 'late');
});

test('宽限与加班起算被夹在合理区间', () => {
  const rs = rules.normalizeRuleSet({ lateGrace: -5, earlyGrace: 999, overtimeMin: 999 });
  assert.equal(rs.lateGrace, 0, '负数 -> 0');
  assert.equal(rs.earlyGrace, 120, '超上限夹到 120');
  assert.equal(rs.overtimeMin, 240, '超上限夹到 240');
});

/* --------------------------- 状态元信息 --------------------------- */

test('statusMeta 覆盖所有状态', () => {
  ['normal', 'late', 'early', 'missing', 'absent', 'under', 'overtime', 'rest'].forEach((s) => {
    const m = rules.statusMeta(s);
    assert.ok(m.label, s + ' should have label');
    assert.ok(m.tone, s + ' should have tone');
  });
});
