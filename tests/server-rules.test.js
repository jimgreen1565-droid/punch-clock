/**
 * 服务端规则引擎测试（四种考勤类型在云端独立复算）
 *
 * 为什么单独测：云端是"可信判定"的唯一来源，如果服务端算迟到算错了，
 * 客户端显示得再对也没用。这里直接测 common.js 的纯函数，不依赖数据库。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const C = require(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'common.js'));

const DAY = '2026-10-30'; // 周五

function at(dayKey, minute) {
  return C.msOfDayMinute(dayKey, minute);
}

test('normalizeRuleSet 缺省宽限必须是 5/5/30，不能变 0（与客户端同口径回归）', () => {
  const rs = C.normalizeRuleSet({});
  assert.equal(rs.lateGrace, 5);
  assert.equal(rs.earlyGrace, 5);
  assert.equal(rs.overtimeMin, 30);

  // 09:05 上班在 5 分钟宽限内
  assert.equal(C.classifyOnServer(at(DAY, 545), 'in', DAY, rs).status, 'normal');

  // 显式 0 才生效
  const zero = C.normalizeRuleSet({ lateGrace: 0 });
  assert.equal(zero.lateGrace, 0);
  assert.equal(C.classifyOnServer(at(DAY, 541), 'in', DAY, zero).status, 'late');
});

test('normalizeRuleSet 对脏数据回落安全默认', () => {
  const rs = C.normalizeRuleSet(null);
  assert.equal(rs.type, 'fixed');
  assert.equal(rs.startMin, 540);
  assert.deepEqual(rs.weekdays, [1, 2, 3, 4, 5]);

  const dirty = C.normalizeRuleSet({ type: 'evil', weekdays: [0, 99], start: '99:99', geo: null });
  assert.equal(dirty.type, 'fixed', '非法 type 必须回落');
  assert.deepEqual(dirty.weekdays, [1, 2, 3, 4, 5], '全非法 weekdays 必须回落');
  assert.equal(dirty.startMin, 540);
  assert.equal(dirty.geo.enabled, true);
  assert.equal(dirty.geo.radius, 0);
});

test('normalizeRuleSet 限制极端数字，防止配置炸裂', () => {
  const rs = C.normalizeRuleSet({ requiredMinutes: 99999, dailyTargetMinutes: -5, rotation: { cycleDays: 999, enabled: true } });
  assert.equal(rs.requiredMinutes, 1440, '应被夹在 1440');
  assert.equal(rs.dailyTargetMinutes, 0, '负数被夹到 0');
  assert.equal(rs.rotation.cycleDays, 60, '应被夹在 60');
});

test('fixed: 迟到只由服务端时间决定', () => {
  const rs = C.normalizeRuleSet({ type: 'fixed', start: '09:00', end: '18:00', lateGrace: 5 });
  assert.equal(C.classifyOnServer(at(DAY, 543), 'in', DAY, rs).status, 'normal');
  const r = C.classifyOnServer(at(DAY, 560), 'in', DAY, rs);
  assert.equal(r.status, 'late');
  assert.equal(r.lateMinutes, 20);
});

test('fixed: 早退与加班', () => {
  const rs = C.normalizeRuleSet({ type: 'fixed', start: '09:00', end: '18:00', earlyGrace: 5 });
  const early = C.classifyOnServer(at(DAY, 1045), 'out', DAY, rs);
  assert.equal(early.status, 'early');
  assert.equal(early.earlyMinutes, 35);
  const ot = C.classifyOnServer(at(DAY, 1130), 'out', DAY, rs);
  assert.equal(ot.overtimeMinutes, 50);
  assert.equal(ot.status, 'overtime');
});

test('flexible: 按最晚上班时间判迟到', () => {
  const rs = C.normalizeRuleSet({ type: 'flexible', latestStart: '10:00', lateGrace: 5 });
  assert.equal(C.classifyOnServer(at(DAY, 595), 'in', DAY, rs).status, 'normal');
  const late = C.classifyOnServer(at(DAY, 615), 'in', DAY, rs);
  assert.equal(late.status, 'late');
  assert.equal(late.lateMinutes, 15);
  // 弹性班的下班不判早退（只看工时）
  assert.equal(C.classifyOnServer(at(DAY, 900), 'out', DAY, rs).status, 'normal');
});

test('shift: 轮换班次，服务端与客户端算出同一个班次日', () => {
  const rs = C.normalizeRuleSet({
    type: 'shift',
    rotation: { enabled: true, cycleDays: 3, slots: ['A', 'B', 'N'], anchorDate: '2026-10-01' },
    shifts: [
      { id: 'A', name: '早班', start: '08:00', end: '16:00' },
      { id: 'B', name: '中班', start: '16:00', end: '00:00' },
      { id: 'N', name: '夜班', start: '21:00', end: '06:00' },
    ],
  });
  // 2026-10-30 与 10-01 差 29 天，29 % 3 = 2 -> 夜班
  assert.equal(C.shiftOfDay(rs, DAY).name, '夜班');
  // 夜班凌晨 03:00 打卡 -> 归 10-30
  const at3am = at('2026-10-31', 180);
  assert.equal(C.resolveShiftDay(at3am, rs), DAY);
});

test('shift: 休息日不判迟到', () => {
  const rs = C.normalizeRuleSet({
    type: 'shift',
    rotation: { enabled: true, cycleDays: 2, slots: ['A', 'REST'], anchorDate: '2026-10-01' },
    shifts: [{ id: 'A', name: '早班', start: '08:00', end: '16:00' }],
  });
  // 10-30 差 29，29%2=1 -> REST
  const info = C.shiftOfDay(rs, DAY);
  assert.equal(info.rest, true);
  const r = C.classifyOnServer(at(DAY, 600), 'in', DAY, rs);
  assert.equal(r.restDay, true);
  assert.equal(r.lateMinutes, 0);
});

test('free: 不判迟到早退，任何时间都算正常', () => {
  const rs = C.normalizeRuleSet({ type: 'free' });
  assert.equal(C.classifyOnServer(at(DAY, 1300), 'in', DAY, rs).status, 'normal');
  assert.equal(C.classifyOnServer(at(DAY, 60), 'out', DAY, rs).status, 'normal');
  assert.equal(C.classifyOnServer(at(DAY, 60), 'in', DAY, rs).restDay, false);
});

test('inFence: 精度参与判定，超精度直接不算进圈', () => {
  const geo = { lat: 39.908823, lng: 116.39747, radius: 300, enabled: true, strict: true };
  // 就在点上，精度 ±600 -> 拒绝
  const low = C.inFence(39.908823, 116.39747, 600, geo);
  assert.equal(low.ok, false);
  assert.equal(low.reason, 'low-accuracy');
  // 就在点上，精度 ±20 -> 通过
  const good = C.inFence(39.908823, 116.39747, 20, geo);
  assert.equal(good.ok, true);
  // 400 米外 -> 拒绝
  const far = C.inFence(39.912400, 116.39747, 20, geo);
  assert.equal(far.ok, false);
  assert.equal(far.reason, 'out-of-range');
  assert.ok(far.dist > 300);
  // 无定位
  assert.equal(C.inFence(null, null, 0, geo).reason, 'no-position');
});

test('inFence: 精度圆恰好等于半径仍算通过（边界）', () => {
  const geo = { lat: 39.908823, lng: 116.39747, radius: 300, enabled: true, strict: true };
  const r = C.inFence(39.908823, 116.3974701, 300, geo);
  assert.equal(r.ok, true, 'acc == radius 且 dist 极小，应通过');
});

test('服务端与客户端规则引擎对同一组输入给出一致结论', () => {
  // 用 JSON 传配置，模拟真实链路（客户端 -> 云端）
  const clientRules = require('../miniprogram/core/rules');
  const cfg = {
    type: 'fixed', start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5],
    lateGrace: 5, earlyGrace: 5, overtimeMin: 30, breakStart: '12:00', breakEnd: '13:00',
  };
  const crs = clientRules.normalizeRuleSet(cfg);
  const srs = C.normalizeRuleSet(JSON.parse(JSON.stringify(cfg)));

  [540, 548, 560, 600].forEach((min) => {
    const c = clientRules.classifyPunch({ ms: at(DAY, min), type: 'in', dayKey: DAY, ruleSet: crs });
    const s = C.classifyOnServer(at(DAY, min), 'in', DAY, srs);
    assert.equal(c.status, s.status, 'status mismatch at minute ' + min);
    assert.equal(c.lateMinutes, s.lateMinutes, 'lateMinutes mismatch at minute ' + min);
  });

  [1020, 1076, 1090, 1140].forEach((min) => {
    const c = clientRules.classifyPunch({ ms: at(DAY, min), type: 'out', dayKey: DAY, ruleSet: crs });
    const s = C.classifyOnServer(at(DAY, min), 'out', DAY, srs);
    assert.equal(c.status, s.status, 'out status mismatch at minute ' + min);
    assert.equal(c.earlyMinutes, s.earlyMinutes, 'early mismatch at ' + min);
    assert.equal(c.overtimeMinutes, s.overtimeMinutes, 'ot mismatch at ' + min);
  });
});

test('resolveShiftDay 与客户端一致（含跨天边界）', () => {
  const clientRules = require('../miniprogram/core/rules');
  const cfg = { type: 'shift', rotation: { enabled: true, cycleDays: 1, slots: ['N'], anchorDate: '2026-10-01' }, shifts: [{ id: 'N', name: '夜班', start: '21:00', end: '06:00' }] };
  const crs = clientRules.normalizeRuleSet(cfg);
  const srs = C.normalizeRuleSet(JSON.parse(JSON.stringify(cfg)));

  // 从 18:00 到次日 09:00 逐小时比对归属
  for (let h = 18; h <= 33; h++) {
    const dayKey = h < 24 ? DAY : '2026-10-31';
    const min = (h % 24) * 60;
    const ms = at(dayKey, min);
    assert.equal(clientRules.resolveShiftDay(ms, crs), C.resolveShiftDay(ms, srs), 'undefined day: h=' + h);
  }
});
