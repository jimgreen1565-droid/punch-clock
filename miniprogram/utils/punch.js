/**
 * 打卡业务编排层
 *
 * 一次打卡要走完 8 步，每一步的失败都给出人能看懂的原因和下一步动作：
 *   1. 读规则集（决定今天是否上班、班次窗口）
 *   2. 取定位（失败可降级为「未定位打卡待审核」）
 *   3. 围栏判定（不在范围：严格模式拒绝 / 宽松模式要备注外勤）
 *   4. 判定本次是上班还是下班（按当天已有记录，不靠用户点哪个按钮）
 *   5. 规则定级（迟到/早退/工时不足/加班）
 *   6. 落库（本地哈希链 或 云端）
 *   7. 刷新红点
 *   8. 生成可读结果 + 下一步建议
 */
const store = require('./store');
const geo = require('./geo');
const cloud = require('./cloud');
const rules = require('../core/rules');

/** 根据当天已有记录决定这次是上班还是下班 */
function nextPunchType(records, ruleSet, dayKey, nowMs) {
  const day = rules.pairDay(records, ruleSet, dayKey, nowMs);
  if (!day.inRec) return { type: 'in', hint: '上班打卡' };
  if (!day.outRec) return { type: 'out', hint: '下班打卡' };
  // 上下班都齐了：允许补一条，按时间远近归类
  const toIn = Math.abs(nowMs - (day.inAt || 0));
  const toOut = Math.abs(nowMs - (day.outAt || 0));
  return {
    type: toIn < toOut ? 'in' : 'out',
    hint: '已打过上下班，本次作为补充记录',
    extra: true,
  };
}

/**
 * 执行打卡
 * @param {object} opts {note, force, skipGeo, outOfRange}
 */
async function doPunch(opts) {
  const options = opts || {};
  const rs = store.getRuleSet();
  const records = store.getRecords();
  const clientNow = Date.now();
  const dayKey = rules.resolveShiftDay(clientNow, rs);
  const dayInfo = rules.shiftOfDay(rs, dayKey);

  // 1. 休息日：允许打卡但标 restDayWork（算加班/到岗）
  // 2. 定位
  let pos = null;
  let geoError = '';
  if (!options.skipGeo && rs.geo.enabled) {
    const loc = await geo.getLocation();
    if (loc.ok) pos = { lat: loc.lat, lng: loc.lng, acc: loc.acc };
    else geoError = loc.error;
  }

  // 3. 围栏
  const fence = { lat: rs.geo.lat, lng: rs.geo.lng, radius: rs.geo.radius };
  const check = rs.geo.enabled ? geo.inFence(pos, fence) : { ok: true, dist: null, acc: null, effective: null, margin: null, radius: 0, reason: 'disabled' };
  const geoSkipped = rs.geo.enabled && !pos && !options.skipGeo;

  // 严格模式 + 不在范围 + 不是主动外勤 + 不是没定位 -> 拒绝
  if (rs.geo.enabled && rs.geo.strict && !check.ok && !options.force && !options.outOfRange && !geoSkipped) {
    return {
      ok: false,
      stage: 'geo',
      reason: check.reason,
      check,
      geoError,
      message: geoRejectMessage(check),
      canOutOfRange: rs.allowOutsideNote,
    };
  }

  // 4. 类型
  const next = nextPunchType(records, rs, dayKey, clientNow);
  // 5. 定级
  const graded = rules.classifyPunch({ ms: clientNow, type: next.type, dayKey, ruleSet: rs });
  const outOfRange = rs.geo.enabled && !check.ok && (options.outOfRange || options.force);

  // 6. 落库
  let result = null;
  if (cloud.isReady()) {
    const res = await cloud.call('punch', 'punch', {
      type: next.type,
      clientAt: clientNow,
      dateKey: dayKey,
      lat: pos ? pos.lat : null,
      lng: pos ? pos.lng : null,
      acc: pos ? pos.acc : null,
      dist: check.dist,
      note: options.note || '',
      geoSkipped,
      geoError,
      outOfRange,
      ruleSet: rs,
    });
    if (res && res.ok && res.data) result = res.data;
  }
  if (!result) {
    result = store.addRecord({
      type: next.type,
      at: clientNow,
      clientAt: clientNow,
      dateKey: dayKey,
      lat: pos ? pos.lat : null,
      lng: pos ? pos.lng : null,
      acc: pos ? pos.acc : null,
      dist: check.dist,
      note: options.note || '',
      geoSkipped,
      geoError,
      shiftId: dayInfo.shift ? dayInfo.shift.id : null,
      shiftName: dayInfo.name,
    });
  }

  try {
    const app = getApp();
    if (app && app.refreshBadge) app.refreshBadge();
  } catch (e) {
    // 非页面上下文（测试）忽略
  }

  const out = {
    ok: true,
    record: result,
    type: next.type,
    hint: next.hint,
    extra: !!next.extra,
    status: outOfRange ? 'outside' : graded.status,
    lateMinutes: graded.lateMinutes,
    earlyMinutes: graded.earlyMinutes,
    overtimeMinutes: graded.overtimeMinutes,
    restDay: graded.restDay,
    shiftName: graded.shiftName,
    check,
    geoSkipped,
    outOfRange,
    geoError,
    dayKey,
    at: clientNow,
    hhmm: rules.hhmmOf(clientNow),
    hhmmss: rules.hhmmssOf(clientNow),
    title: punchTitle(next.type, graded, outOfRange),
    message: punchMessage(next.type, graded, check, geoSkipped, outOfRange),
  };
  return out;
}

function geoRejectMessage(check) {
  if (!check) return '定位不可用，无法校验打卡范围';
  if (check.reason === 'disabled') return '未开启定位校验';
  if (check.reason === 'no-position') return '没有拿到定位。请允许微信使用位置权限后重试';
  if (check.reason === 'low-accuracy') {
    return '定位精度只有 ±' + Math.round(check.acc) + ' 米，无法确认你在' + '打卡范围内。请到窗边或室外重试';
  }
  if (check.reason === 'out-of-range') {
    return '距离打卡点 ' + Math.round(check.dist) + ' 米，超出 ' + check.radius + ' 米范围';
  }
  return '不在打卡范围';
}

function punchTitle(type, graded, outOfRange) {
  if (outOfRange) return '外勤打卡';
  if (graded.restDay) return type === 'in' ? '休息日到岗' : '休息日下班';
  if (type === 'in') return graded.status === 'late' ? '迟到打卡' : '上班打卡';
  if (graded.status === 'early') return '早退打卡';
  if (graded.status === 'under') return '工时不足';
  if (graded.overtimeMinutes > 0) return '下班打卡（含加班）';
  return '下班打卡';
}

function punchMessage(type, graded, check, geoSkipped, outOfRange) {
  const bits = [];
  if (type === 'in') {
    if (graded.status === 'late') bits.push('迟到 ' + graded.lateMinutes + ' 分钟');
    else bits.push(graded.restDay ? '休息日到岗' : '正常上班');
  } else {
    if (graded.status === 'early') bits.push('早退 ' + graded.earlyMinutes + ' 分钟');
    else if (graded.status === 'under') bits.push('工时不足 ' + graded.shortMinutes + ' 分钟');
    else bits.push('正常下班');
    if (graded.overtimeMinutes > 0) bits.push('加班 ' + graded.overtimeMinutes + ' 分钟');
  }
  if (geoSkipped) bits.push('未取到定位，已标记待审核');
  else if (outOfRange) bits.push('外勤打卡，已标记待审核');
  else if (check && check.ok && check.dist !== null && check.dist !== undefined) {
    bits.push('距打卡点 ' + Math.round(check.dist) + ' 米');
  }
  return bits.join(' · ');
}

/** 今天的状态汇总（首页大卡片用） */
function todaySummary(nowMs) {
  const now = nowMs || Date.now();
  const rs = store.getRuleSet();
  const records = store.getRecords();
  const dayKey = rules.resolveShiftDay(now, rs);
  const day = rules.pairDay(records, rs, dayKey, now);
  const dayInfo = rules.shiftOfDay(rs, dayKey);
  const win = dayInfo.shift ? rules.shiftWindow(dayKey, dayInfo.shift) : { inAt: null, outAt: null, spanMin: 0 };
  const nextType = !day.inRec ? 'in' : !day.outRec ? 'out' : 'in';

  // 今天还剩多少工时（弹性/自由工时用）
  let remainMinutes = null;
  if (rs.type === 'flexible' && day.inAt) {
    remainMinutes = Math.max(0, rules.diffMinutes(day.expectOutAt || 0, now));
  } else if (rs.type === 'free') {
    remainMinutes = Math.max(0, rs.dailyTargetMinutes - day.workMinutes);
  }

  const meta = rules.statusMeta(day.status);

  return {
    dayKey,
    ruleSet: rs,
    dayInfo,
    win,
    day,
    nextType,
    planMinutes: rs.type === 'flexible' ? rs.requiredMinutes : rs.type === 'free' ? rs.dailyTargetMinutes : dayInfo.shift ? dayInfo.shift.endMin - dayInfo.shift.startMin : 0,
    workMinutes: day.workMinutes,
    remainMinutes,
    inText: day.inAt ? rules.hhmmOf(day.inAt) : '--:--',
    outText: day.outAt ? rules.hhmmOf(day.outAt) : '--:--',
    expectInText: day.expectInAt ? rules.hhmmOf(day.expectInAt) : '--:--',
    expectOutText: day.expectOutAt ? rules.hhmmOf(day.expectOutAt) : '--:--',
    statusLabel: meta.label,
    statusTone: meta.tone,
    status: day.status,
    lateText: day.lateMinutes > 0 ? '迟到 ' + day.lateMinutes + ' 分钟' : '',
    earlyText: day.earlyMinutes > 0 ? '早退 ' + day.earlyMinutes + ' 分钟' : '',
    underText: day.shortMinutes > 0 ? '工时不足 ' + day.shortMinutes + ' 分钟' : '',
    overtimeText: day.overtimeMinutes > 0 ? '加班 ' + day.overtimeMinutes + ' 分钟' : '',
    isRest: day.restDay,
  };
}

module.exports = { doPunch, todaySummary, nextPunchType, geoRejectMessage };
