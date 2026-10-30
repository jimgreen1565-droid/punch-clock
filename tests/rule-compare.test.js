/**
 * 四种规则对同一组打卡行为的判定差异（对照测试）
 *
 * 这个文件的意义：规则引擎最容易出错的地方不是单个函数，而是「同一时刻
 * 换一种规则，结论应该怎么变」。用同一份打卡数据横切四种规则，一眼能看出
 * 差异是否符合钉钉的产品语义。
 *
 * 场景固定为：09:10 上班、17:40 下班，站点 300 米内。
 * 固定班制 09:00-18:00：迟到 10 分钟 + 早退 20 分钟
 * 弹性 10:00 最晚 + 满 8h：不迟到，但工时不足（09:10→17:40 = 7h30m，扣午休更少）
 * 排班 早班 08:00-16:00：迟到 70 分钟、下班晚 100 分钟（算加班）
 * 自由工时：既不迟到也不早退，只记录时长
 */
const test = require('node:test');
const assert = require('node:assert');
const rules = require('../miniprogram/core/rules');

const DAY = '2026-10-30'; // 周五

function recs(inMin, outMin) {
  return [
    { dateKey: DAY, type: 'in', at: rules.msOfDayMinute(DAY, inMin) },
    { dateKey: DAY, type: 'out', at: rules.msOfDayMinute(DAY, outMin) },
  ];
}

const IN = 550; // 09:10
const OUT = 1060; // 17:40

test('fixed 09:00-18:00：迟到 10 分钟 + 早退 20 分钟', () => {
  const rs = rules.normalizeRuleSet({ type: 'fixed', start: '09:00', end: '18:00', lateGrace: 5, earlyGrace: 5, breakStart: '12:00', breakEnd: '13:00' });
  const d = rules.pairDay(recs(IN, OUT), rs, DAY, rules.msOfDayMinute(DAY, 1260));
  assert.equal(d.lateMinutes, 10);
  assert.equal(d.earlyMinutes, 20);
  assert.equal(d.status, 'late', '迟到优先于早退（一天只有一个主状态）');
  // 09:10 -> 17:40 是 8h30m，扣 1h 午休 = 7h30m
  assert.equal(d.workMinutes, 450);
});

test('flexible 最晚 10:00 + 满 8h：不迟到，但工时不足', () => {
  const rs = rules.normalizeRuleSet({ type: 'flexible', latestStart: '10:00', earliestEnd: '17:30', requiredMinutes: 480, breakStart: '12:00', breakEnd: '13:00' });
  const d = rules.pairDay(recs(IN, OUT), rs, DAY, rules.msOfDayMinute(DAY, 1260));
  assert.equal(d.lateMinutes, 0, '09:10 早于最晚 10:00，不算迟到');
  assert.equal(d.earlyMinutes, 0, '弹性班不判早退');
  assert.equal(d.status, 'under');
  assert.ok(d.shortMinutes > 0);
  // 应下班 = max(17:30, 09:10 + 480 + 60 = 18:10) = 18:10 -> 17:40 不足 30 分钟
  assert.equal(d.shortMinutes, 30);
  assert.equal(rules.hhmmOf(d.expectOutAt), '18:10');
});

test('shift 早班 08:00-16:00：迟到 70 分钟、多待 100 分钟算加班', () => {
  const rs = rules.normalizeRuleSet({
    type: 'shift',
    rotation: { enabled: true, cycleDays: 1, slots: ['A'], anchorDate: DAY },
    shifts: [{ id: 'A', name: '早班', start: '08:00', end: '16:00' }],
    lateGrace: 5,
    breakStart: '12:00',
    breakEnd: '13:00',
  });
  const d = rules.pairDay(recs(IN, OUT), rs, DAY, rules.msOfDayMinute(DAY, 1260));
  assert.equal(d.lateMinutes, 70);
  assert.equal(d.earlyMinutes, 0, '17:40 晚于 16:00，不算早退');
  assert.equal(d.overtimeMinutes, 100);
  assert.equal(d.status, 'late', '迟到仍是主状态，加班只体现在分钟数');
});

test('free：既不迟到也不早退，只记录时长', () => {
  const rs = rules.normalizeRuleSet({ type: 'free', breakStart: '12:00', breakEnd: '13:00' });
  const d = rules.pairDay(recs(IN, OUT), rs, DAY, rules.msOfDayMinute(DAY, 1260));
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.earlyMinutes, 0);
  assert.equal(d.status, 'normal');
  assert.equal(d.workMinutes, 450);
  assert.equal(d.restDay, false);
});

test('同一个 09:10 上班卡，四种规则的 lateMinutes 完全不同', () => {
  const mk = (type, extra) => rules.normalizeRuleSet(Object.assign({ type }, extra || {}));
  const now = rules.msOfDayMinute(DAY, 1200);

  const results = {
    fixed: rules.pairDay(recs(IN, OUT), mk('fixed', { start: '09:00', end: '18:00' }), DAY, now).lateMinutes,
    flexible: rules.pairDay(recs(IN, OUT), mk('flexible', { latestStart: '10:00' }), DAY, now).lateMinutes,
    shift: rules.pairDay(recs(IN, OUT), mk('shift', { rotation: { enabled: true, cycleDays: 1, slots: ['A'], anchorDate: DAY }, shifts: [{ id: 'A', name: '早班', start: '08:00', end: '16:00' }] }), DAY, now).lateMinutes,
    free: rules.pairDay(recs(IN, OUT), mk('free'), DAY, now).lateMinutes,
  };

  assert.deepEqual(results, { fixed: 10, flexible: 0, shift: 70, free: 0 });
});

test('同一组数据，四种规则的工作日数量不同（决定月出勤率的分母）', () => {
  const counts = {
    fixed: rules.plannedDays('2026-10', rules.normalizeRuleSet({ type: 'fixed', weekdays: [1, 2, 3, 4, 5] })).length,
    free: rules.plannedDays('2026-10', rules.normalizeRuleSet({ type: 'free' })).length,
    shift3: rules.plannedDays('2026-10', rules.normalizeRuleSet({ type: 'shift', rotation: { enabled: true, cycleDays: 3, slots: ['A', 'B', 'REST'], anchorDate: '2026-10-01' }, shifts: [{ id: 'A', name: 'A', start: '08:00', end: '16:00' }, { id: 'B', name: 'B', start: '16:00', end: '00:00' }] })).length,
  };
  assert.equal(counts.fixed, 22);
  assert.equal(counts.free, 31, '自由工时每天都算');
  assert.ok(counts.shift3 > 0 && counts.shift3 < 31);
});

test('弹性班的应下班随实际到岗时间滑动（关键差异）', () => {
  const rs = rules.normalizeRuleSet({ type: 'flexible', latestStart: '10:00', earliestEnd: '17:30', requiredMinutes: 480, breakStart: '', breakEnd: '' });
  const cases = [
    { inMin: 540, expect: '17:30' }, // 09:00 + 480 = 17:00 -> max(17:30) = 17:30
    { inMin: 570, expect: '17:30' }, // 09:30 + 480 = 17:30
    { inMin: 600, expect: '18:00' }, // 10:00 + 480 = 18:00
    { inMin: 630, expect: '18:30' }, // 10:30 晚于最晚上班，仍按 10:30 算
  ];
  cases.forEach((c) => {
    const d = rules.pairDay([{ dateKey: DAY, type: 'in', at: rules.msOfDayMinute(DAY, c.inMin) }], rs, DAY, rules.msOfDayMinute(DAY, 1300));
    assert.equal(rules.hhmmOf(d.expectOutAt), c.expect, 'inMin=' + c.inMin);
  });
});

test('自由工时一天多次进出，工时按「最早上班→最晚下班」累计（含多次外出）', () => {
  const rs = rules.normalizeRuleSet({ type: 'free', breakStart: '', breakEnd: '' });
  const list = [
    { dateKey: DAY, type: 'in', at: rules.msOfDayMinute(DAY, 570) },
    { dateKey: DAY, type: 'out', at: rules.msOfDayMinute(DAY, 700) },
    { dateKey: DAY, type: 'in', at: rules.msOfDayMinute(DAY, 740) },
    { dateKey: DAY, type: 'out', at: rules.msOfDayMinute(DAY, 1080) },
  ];
  const d = rules.pairDay(list, rs, DAY, rules.msOfDayMinute(DAY, 1200));
  assert.equal(d.workMinutes, 510, '570->1080 = 8h30m');
  assert.equal(d.hasAny, true);
});
