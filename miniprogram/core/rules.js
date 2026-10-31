/**
 * 考勤规则引擎（纯函数，无 wx / 无 Node 依赖）
 *
 * 参照钉钉考勤的四种考勤组类型（钉钉里考勤组类型创建后不可改，这里做成可随时切换）：
 *
 *   1. fixed     固定班制 —— 每天同一时间上下班。最常用。
 *                 典型场景：写字楼、行政、客服白班
 *   2. flexible  弹性工作制 —— 只规定「最晚上班打卡」与「每日应满工时」，
 *                 早晚可浮动。典型场景：研发、设计
 *   3. shift     排班制 —— 按排班表上下班，支持多班次周期轮换（三班倒）。
 *                 典型场景：工厂、门店、医院
 *   4. free      自由工时 —— 不限定时间，只累计工作时长，不判迟到早退。
 *                 典型场景：家政、装修、外勤销售、物流
 *
 * 设计原则：
 * - 「今天/几点」一律基于绝对毫秒 + 固定时区（Asia/Shanghai, UTC+8），不跟随手机时区。
 * - 班次窗口用绝对毫秒表示（inAt/outAt），跨天班次（22:00-06:00）自然成立。
 * - 判定输出是纯数据，云端与本地演示共用同一份逻辑。
 * - 所有时间比较都走分钟差，宽限期只影响「是否算异常」，不影响分钟数（分钟数照实记）。
 */

const TZ_OFFSET_MIN = 480;
const DAY_MS = 86400000;
const MIN_MS = 60000;

const WEEKDAY_TEXT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEKDAY_SHORT = ['', '一', '二', '三', '四', '五', '六', '日'];

/** 四种规则类型的元信息（给 UI 用） */
const RULE_TYPES = [
  {
    id: 'fixed',
    name: '固定班制',
    icon: 'clock',
    desc: '每天固定时间上下班',
    detail: '迟到、早退、缺卡都按分钟判定，最常用',
    tag: '推荐',
  },
  {
    id: 'flexible',
    name: '弹性工作制',
    icon: 'flex',
    desc: '只卡最晚上班，工时要满',
    detail: '上班可晚到一会儿，下班按工时自动顺延',
    tag: '研发/设计',
  },
  {
    id: 'shift',
    name: '排班制',
    icon: 'grid',
    desc: '按排班表上下班',
    detail: '支持多班次周期轮换，三班倒也能排',
    tag: '门店/工厂',
  },
  {
    id: 'free',
    name: '自由工时',
    icon: 'spark',
    desc: '不限时间，只累计工时',
    detail: '不判迟到早退，任何时间打卡都计入',
    tag: '外勤/家政',
  },
];

/* ------------------------------ 基础时间工具 ------------------------------ */

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function partsOf(ms, offsetMin) {
  const off = (offsetMin === undefined ? TZ_OFFSET_MIN : offsetMin) * MIN_MS;
  const d = new Date(ms + off);
  const weekdayRaw = d.getUTCDay();
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    ss: d.getUTCSeconds(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: weekdayRaw === 0 ? 7 : weekdayRaw,
  };
}

function dayKeyOf(ms, offsetMin) {
  const p = partsOf(ms, offsetMin);
  return p.y + '-' + pad2(p.m) + '-' + pad2(p.d);
}

function hhmmOf(ms, offsetMin) {
  const p = partsOf(ms, offsetMin);
  return pad2(p.hh) + ':' + pad2(p.mm);
}

function hhmmssOf(ms, offsetMin) {
  const p = partsOf(ms, offsetMin);
  return pad2(p.hh) + ':' + pad2(p.mm) + ':' + pad2(p.ss);
}

function msOfDayMinute(dayKey, minute, offsetMin) {
  const seg = String(dayKey).split('-').map(Number);
  const off = (offsetMin === undefined ? TZ_OFFSET_MIN : offsetMin) * MIN_MS;
  return Date.UTC(seg[0], seg[1] - 1, seg[2]) + minute * MIN_MS - off;
}

function parseHHMM(v) {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!mt) return null;
  const h = Number(mt[1]);
  const m = Number(mt[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function hhmmOfMinute(minute) {
  const v = ((minute % 1440) + 1440) % 1440;
  return pad2(Math.floor(v / 60)) + ':' + pad2(v % 60);
}

function shiftDayKey(dayKey, deltaDays) {
  const seg = String(dayKey).split('-').map(Number);
  const t = Date.UTC(seg[0], seg[1] - 1, seg[2]) + deltaDays * DAY_MS;
  const d = new Date(t);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function dayDiff(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  return Math.round((Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / DAY_MS);
}

function monthInfo(month) {
  const seg = String(month).split('-').map(Number);
  const y = seg[0];
  const m = seg[1];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    y,
    m,
    days,
    firstDayKey: y + '-' + pad2(m) + '-01',
    lastDayKey: y + '-' + pad2(m) + '-' + pad2(days),
  };
}

function monthKeyOf(ms, offsetMin) {
  const p = partsOf(ms, offsetMin);
  return p.y + '-' + pad2(p.m);
}

function diffMinutes(a, b) {
  return Math.round((a - b) / MIN_MS);
}

function isWeekdayOn(dayKey, weekdayList) {
  return weekdayList.indexOf(partsOf(msOfDayMinute(dayKey, 720)).weekday) >= 0;
}

/* ------------------------------ 规则集规整 ------------------------------ */

/** 默认规则集：固定班制 09:00-18:00，周一至周五 */
function defaultRuleSet() {
  return {
    id: 'default',
    name: '标准考勤组',
    type: 'fixed',
    // 通用
    weekdays: [1, 2, 3, 4, 5],
    breakStart: '12:00',
    breakEnd: '13:00',
    lateGrace: 5,
    earlyGrace: 5,
    overtimeMin: 30,
    // fixed / shift 共用
    start: '09:00',
    end: '18:00',
    // flexible
    latestStart: '10:00',
    earliestEnd: '17:30',
    requiredMinutes: 480,
    // shift
    shifts: [
      { id: 'A', name: '早班', start: '08:00', end: '16:00', color: '#3b82f6' },
      { id: 'B', name: '中班', start: '16:00', end: '00:00', color: '#f59e0b' },
      { id: 'C', name: '夜班', start: '00:00', end: '08:00', color: '#8b5cf6' },
    ],
    rotation: { enabled: false, cycleDays: 4, slots: ['A', 'A', 'B', 'REST'], anchorDate: '' },
    // free
    dailyTargetMinutes: 480,
    // 打卡方式
    geo: { enabled: true, strict: true, radius: 300, lat: 39.908823, lng: 116.39747, name: '公司' },
    wifi: { enabled: false, ssids: [] },
    allowOutsideNote: true, // 范围外可打卡但填备注（外勤）
    patch: { allow: true, maxDays: 7, maxPerMonth: 3 },
    restDayRequiresApply: false,
  };
}

function normalizeShiftDef(raw, i) {
  const src = raw || {};
  const s = parseHHMM(src.start);
  const e = parseHHMM(src.end);
  const startMin = s === null ? 480 : s;
  const endMin = e === null ? 960 : e;
  return {
    id: src.id || 'S' + (i + 1),
    name: src.name || '班次' + (i + 1),
    start: hhmmOfMinute(startMin),
    end: hhmmOfMinute(endMin),
    startMin,
    endMin,
    crossDay: endMin <= startMin,
    color: src.color || '#3b82f6',
    breakStartMin: parseHHMM(src.breakStart),
    breakEndMin: parseHHMM(src.breakEnd),
  };
}

/** 取数字配置：字段缺省用 fallback，非法/负数用 0，超出范围夹边界 */
function pickNum(src, key, fallback, min, max) {
  const v = src ? src[key] : undefined;
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.max(min === undefined ? 0 : min, Math.min(max === undefined ? 1e9 : max, n));
}

/**
 * 把任意来源的配置规整成标准 ruleSet。缺字段一律填默认值，不抛错。
 */
function normalizeRuleSet(raw) {
  const d = defaultRuleSet();
  const src = raw || {};
  const type = RULE_TYPES.some((t) => t.id === src.type) ? src.type : 'fixed';

  const startMin = parseHHMM(src.start) === null ? 540 : parseHHMM(src.start);
  const endMin = parseHHMM(src.end) === null ? 1080 : parseHHMM(src.end);
  const latestStartMin = parseHHMM(src.latestStart) === null ? 600 : parseHHMM(src.latestStart);
  const earliestEndMin = parseHHMM(src.earliestEnd) === null ? 1050 : parseHHMM(src.earliestEnd);
  const breakStartRaw = src.breakStart === undefined ? d.breakStart : src.breakStart;
  const breakEndRaw = src.breakEnd === undefined ? d.breakEnd : src.breakEnd;
  const breakStartMin = parseHHMM(breakStartRaw);
  const breakEndMin = parseHHMM(breakEndRaw);

  const rawWeekdays = Array.isArray(src.weekdays) ? src.weekdays.map(Number).filter((x) => x >= 1 && x <= 7) : [];
  const weekdays = rawWeekdays.length
    ? rawWeekdays.sort((a, b) => a - b)
    : d.weekdays.slice();

  const shifts = (Array.isArray(src.shifts) && src.shifts.length ? src.shifts : d.shifts).map(normalizeShiftDef);
  const rot = Object.assign({}, d.rotation, src.rotation || {});
  const cycleDays = Math.max(1, Math.min(60, Number(rot.cycleDays) || 1));
  let slots = Array.isArray(rot.slots) ? rot.slots.slice(0, cycleDays) : [];
  while (slots.length < cycleDays) slots.push(slots.length === cycleDays - 1 ? 'REST' : shifts[0].id);

  const geo = Object.assign({}, d.geo, src.geo || {});
  geo.radius = Math.max(0, Number(geo.radius) || 0);

  return {
    id: src.id || d.id,
    name: src.name || d.name,
    type,
    weekdays,
    breakStart: breakStartMin === null ? '' : hhmmOfMinute(breakStartMin),
    breakEnd: breakEndMin === null ? '' : hhmmOfMinute(breakEndMin),
    breakStartMin,
    breakEndMin,
    breakMinutes: breakStartMin !== null && breakEndMin !== null && breakEndMin > breakStartMin ? breakEndMin - breakStartMin : 0,
    lateGrace: pickNum(src, 'lateGrace', d.lateGrace, 0, 120),
    earlyGrace: pickNum(src, 'earlyGrace', d.earlyGrace, 0, 120),
    overtimeMin: pickNum(src, 'overtimeMin', d.overtimeMin, 0, 240),

    start: hhmmOfMinute(startMin),
    end: hhmmOfMinute(endMin),
    startMin,
    endMin,
    crossDay: endMin <= startMin,

    latestStart: hhmmOfMinute(latestStartMin),
    latestStartMin,
    earliestEnd: hhmmOfMinute(earliestEndMin),
    earliestEndMin,
    requiredMinutes: Math.max(60, Math.min(1440, Number(src.requiredMinutes) || d.requiredMinutes)),

    shifts,
    rotation: { enabled: !!rot.enabled, cycleDays, slots, anchorDate: rot.anchorDate || '' },

    dailyTargetMinutes: Math.max(0, Math.min(1440, Number(src.dailyTargetMinutes) || d.dailyTargetMinutes)),

    geo: {
      enabled: geo.enabled !== false,
      strict: geo.strict !== false,
      radius: geo.radius,
      lat: Number(geo.lat) || d.geo.lat,
      lng: Number(geo.lng) || d.geo.lng,
      name: geo.name || d.geo.name,
    },
    wifi: {
      enabled: !!(src.wifi && src.wifi.enabled),
      ssids: (src.wifi && Array.isArray(src.wifi.ssids) ? src.wifi.ssids : []).map(String).filter(Boolean).slice(0, 10),
    },
    // 补卡规则（对齐飞书「管理员设置补卡规则」）
    //   allow: 是否允许申请补卡
    //   maxDays: 只能补过去 N 天（0 = 只能补当天）
    //   maxPerMonth: 每人每月最多补 N 次（0 = 不限）
    patch: {
      allow: src.patch && src.patch.allow === false ? false : true,
      maxDays: pickNum(src.patch, 'maxDays', 7, 0, 180),
      maxPerMonth: pickNum(src.patch, 'maxPerMonth', 3, 0, 999),
    },
    // 休息日打卡是否需要先提交加班/外出/出差申请（飞书有此开关）
    restDayRequiresApply: !!(src.restDayRequiresApply),
    allowOutsideNote: src.allowOutsideNote !== false,
  };
}

/**
 * 校验一次补卡申请是否合规（飞书规则口径）。
 * @param {object} args {ruleSet, targetDayKey, todayKey, alreadyCount}
 * @returns {{ok, reason}}
 */
function canApplyPatch(args) {
  const rs = normalizeRuleSet(args.ruleSet);
  if (!rs.patch.allow) return { ok: false, reason: 'disabled', message: '当前规则不允许补卡' };

  const days = dayDiff(args.todayKey, args.targetDayKey);
  if (days < 0) return { ok: false, reason: 'future', message: '不能补未来的日期' };
  if (days > rs.patch.maxDays) {
    return {
      ok: false,
      reason: 'too-old',
      message: rs.patch.maxDays === 0
        ? '只能补当天的卡'
        : '只能补 ' + rs.patch.maxDays + ' 天内的卡',
    };
  }
  if (rs.patch.maxPerMonth > 0 && (args.alreadyCount || 0) >= rs.patch.maxPerMonth) {
    return { ok: false, reason: 'quota', message: '本月补卡次数已用完（' + rs.patch.maxPerMonth + ' 次）' };
  }
  return { ok: true, reason: 'ok', message: '' };
}

/** 规则类型的中文名 */
function ruleTypeName(type) {
  const t = RULE_TYPES.find((x) => x.id === type);
  return t ? t.name : '固定班制';
}

/** 一句话描述当前规则（首页/我的页展示） */
function describeRule(rs) {
  const r = normalizeRuleSet(rs);
  if (r.type === 'fixed') {
    return r.start + ' - ' + r.end + ' · ' + weekdaysText(r.weekdays);
  }
  if (r.type === 'flexible') {
    return '最晚 ' + r.latestStart + ' 上班 · 每日满 ' + fmtMinuteText(r.requiredMinutes);
  }
  if (r.type === 'shift') {
    if (r.rotation.enabled) {
      return '周期轮换 ' + r.rotation.cycleDays + ' 天 · ' + r.rotation.slots.map(slotName(r)).join(' → ');
    }
    return '固定 ' + r.start + ' - ' + r.end;
  }
  return '不限时间 · 目标 ' + fmtMinuteText(r.dailyTargetMinutes);
}

function slotName(rs) {
  return function (slot) {
    if (!slot || slot === 'REST') return '休';
    const s = rs.shifts.find((x) => x.id === slot);
    return s ? s.name : slot;
  };
}

function weekdaysText(list) {
  if (!list || !list.length) return '无';
  if (list.length === 7) return '每天';
  if (list.length === 5 && list.join(',') === '1,2,3,4,5') return '周一至周五';
  if (list.length === 6 && list.join(',') === '1,2,3,4,5,6') return '周一至周六';
  return list.map((w) => WEEKDAY_TEXT[w]).join(' ');
}

function fmtMinuteText(min) {
  const m = Math.max(0, Math.round(min || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return r + ' 分钟';
  return r ? h + ' 小时 ' + r + ' 分' : h + ' 小时';
}

/* ------------------------------ 排班解析 ------------------------------ */

/**
 * 解析某一天的班次安排。
 * @returns {{rest:boolean, shift:object|null, name:string}} rest=true 表示休息日
 */
function shiftOfDay(ruleSet, dayKey) {
  const rs = ruleSet.id ? ruleSet : normalizeRuleSet(ruleSet);

  if (rs.type === 'free') {
    return { rest: false, shift: null, name: '自由工时' };
  }

  if (rs.type === 'shift') {
    if (!rs.rotation.enabled) {
      // 固定排班：工作日用 shifts[0]，其余休息
      if (!isWeekdayOn(dayKey, rs.weekdays)) return { rest: true, shift: null, name: '休息' };
      return { rest: false, shift: rs.shifts[0], name: rs.shifts[0].name };
    }
    const anchor = rs.rotation.anchorDate || dayKey;
    const idx = ((dayDiff(dayKey, anchor) % rs.rotation.cycleDays) + rs.rotation.cycleDays) % rs.rotation.cycleDays;
    const slot = rs.rotation.slots[idx];
    if (!slot || slot === 'REST') return { rest: true, shift: null, name: '休息' };
    const sh = rs.shifts.find((x) => x.id === slot) || rs.shifts[0];
    return { rest: false, shift: sh, name: sh.name };
  }

  // fixed / flexible：按星期几
  if (!isWeekdayOn(dayKey, rs.weekdays)) return { rest: true, shift: null, name: '休息' };
  return {
    rest: false,
    shift: {
      id: 'std',
      name: rs.type === 'flexible' ? '弹性班' : '标准班',
      start: rs.start,
      end: rs.end,
      startMin: rs.startMin,
      endMin: rs.endMin,
      crossDay: rs.type === 'flexible' ? false : rs.crossDay,
      color: '#3b82f6',
    },
    name: rs.type === 'flexible' ? '弹性班' : '标准班',
  };
}

/** 某天某班次的窗口（绝对毫秒） */
function shiftWindow(dayKey, shift) {
  const inAt = msOfDayMinute(dayKey, shift.startMin);
  const outAt = msOfDayMinute(dayKey, shift.endMin) + (shift.crossDay ? DAY_MS : 0);
  return { dateKey: dayKey, inAt, outAt, spanMin: (shift.endMin - shift.startMin + 1440) % 1440 || 1440 };
}

/**
 * 一次打卡归属哪个「班次日」。
 *
 * 判定分两级（顺序很重要）：
 *   1. 强匹配：打卡时刻落在某个班次的窗口内（inAt ≤ t ≤ outAt）。
 *      先看今天，再看昨天（跨天夜班的凌晨卡靠这条正确归到前一天）。
 *   2. 弱匹配：落在窗口外的容忍带（提前 30 分钟到延后 6 小时，覆盖早到与加班）。
 *      同样先今天后昨天。
 * 都不匹配则归今天。
 *
 * 为什么必须先做「强匹配」：如果今天有 08:00 的早班、昨天是 21:00-06:00 的夜班，
 * 凌晨 03:00 的打卡既落在今天的「提前容忍带」又落在昨天的「窗口内」。
 * 只按顺序试的话会错归到今天，导致夜班员工天天缺下班卡。
 */
function resolveShiftDay(ms, ruleSet) {
  const rs = ruleSet.id && ruleSet.shifts ? ruleSet : normalizeRuleSet(ruleSet);
  const todayKey = dayKeyOf(ms);
  if (rs.type === 'free') return todayKey;

  const TOL_BEFORE = 30 * MIN_MS;
  const TOL_AFTER = 6 * 60 * MIN_MS;

  const windowOf = (dk) => {
    const info = shiftOfDay(rs, dk);
    if (info.rest || !info.shift) return null;
    return { info, win: shiftWindow(dk, info.shift) };
  };

  const yKey = shiftDayKey(todayKey, -1);
  const t = windowOf(todayKey);
  const y = windowOf(yKey);

  // 1. 强匹配
  if (t && ms >= t.win.inAt && ms <= t.win.outAt) return todayKey;
  if (y && ms >= y.win.inAt && ms <= y.win.outAt) return yKey;

  // 2. 弱匹配（容忍带）
  if (t && ms >= t.win.inAt - TOL_BEFORE && ms <= t.win.outAt + TOL_AFTER) return todayKey;
  if (y && ms >= y.win.inAt - TOL_BEFORE && ms <= y.win.outAt + TOL_AFTER) return yKey;

  return todayKey;
}

/* ------------------------------ 打卡定级 ------------------------------ */

/**
 * 单次打卡定级（决定这条记录是 normal/late/early/overtime/outside 等）
 * @param {object} args {ms, type:'in'|'out', dayKey, ruleSet, dist, acc}
 */
function classifyPunch(args) {
  const rs = args.ruleSet.id && args.ruleSet.shifts ? args.ruleSet : normalizeRuleSet(args.ruleSet);
  const info = shiftOfDay(rs, args.dayKey);

  const base = {
    status: 'normal',
    restDay: info.rest,
    shiftName: info.name,
    lateMinutes: 0,
    earlyMinutes: 0,
    overtimeMinutes: 0,
    flags: [],
  };

  if (rs.type === 'free' || info.rest || !info.shift) {
    if (rs.type === 'free') return base;
    if (info.rest) return base; // 休息日打卡只算加班/到岗，不判异常
    return base;
  }

  const win = shiftWindow(args.dayKey, info.shift);

  if (rs.type === 'flexible') {
    const late = Math.max(0, diffMinutes(args.ms, msOfDayMinute(args.dayKey, rs.latestStartMin)));
    if (args.type === 'in') {
      if (late > rs.lateGrace) return Object.assign({}, base, { status: 'late', lateMinutes: late, flags: ['late'] });
      return base;
    }
    // 弹性班的下班只看工时是否满，见 pairDay
    return base;
  }

  const late = Math.max(0, diffMinutes(args.ms, win.inAt));
  const early = Math.max(0, diffMinutes(win.outAt, args.ms));
  const over = Math.max(0, diffMinutes(args.ms, win.outAt));

  if (args.type === 'in') {
    if (late > rs.lateGrace) return Object.assign({}, base, { status: 'late', lateMinutes: late, flags: ['late'] });
    return base;
  }
  if (early > rs.earlyGrace) {
    return Object.assign({}, base, { status: 'early', earlyMinutes: early, flags: ['early'] });
  }
  if (over > 0) {
    return Object.assign({}, base, { status: 'overtime', overtimeMinutes: over, flags: ['overtime'] });
  }
  return base;
}

/**
 * 一天的汇总判定。
 *
 * 输出字段（统一给四个页面用）：
 *   status: 'rest' 休息 | 'absent' 旷工 | 'missing' 缺卡 | 'late' 迟到 | 'early' 早退
 *         | 'under' 工时不足 | 'overtime' | 'normal'
 *   以及 lateMinutes / earlyMinutes / overtimeMinutes / shortMinutes / workMinutes
 */
function pairDay(records, ruleSet, dayKey, nowMs) {
  const rs = ruleSet.id && ruleSet.shifts ? ruleSet : normalizeRuleSet(ruleSet);
  const info = shiftOfDay(rs, dayKey);

  const list = (records || [])
    .filter((r) => r && r.dateKey === dayKey)
    .slice()
    .sort((a, b) => a.at - b.at);

  const ins = list.filter((r) => r.type === 'in');
  const outs = list.filter((r) => r.type === 'out');
  const inRec = ins.length ? ins[0] : null;
  const outRec = outs.length ? outs[outs.length - 1] : null;

  const now = nowMs === undefined ? Infinity : nowMs;

  // ---- 窗口与期望时间 ----
  let expectInAt = null;
  let expectOutAt = null;
  let restDay = info.rest;
  let shiftName = info.name;

  if (!restDay && info.shift) {
    const win = shiftWindow(dayKey, info.shift);
    if (rs.type === 'flexible') {
      expectInAt = msOfDayMinute(dayKey, rs.latestStartMin);
      // 弹性：应下班 = max(最早下班, 实际上班 + 应满工时 + 午休)
      const baseIn = inRec ? inRec.at : msOfDayMinute(dayKey, rs.latestStartMin);
      expectOutAt = Math.max(
        msOfDayMinute(dayKey, rs.earliestEndMin),
        baseIn + (rs.requiredMinutes + rs.breakMinutes) * MIN_MS
      );
    } else {
      expectInAt = win.inAt;
      expectOutAt = win.outAt;
    }
  }

  // ---- 工时（扣午休）----
  let workMs = 0;
  if (inRec && outRec && outRec.at > inRec.at) {
    workMs = outRec.at - inRec.at;
    if (rs.breakStartMin !== null && rs.breakEndMin !== null) {
      const bStart = msOfDayMinute(dayKey, rs.breakStartMin);
      const bEnd = msOfDayMinute(dayKey, rs.breakEndMin) + (rs.breakEndMin < rs.breakStartMin ? DAY_MS : 0);
      const overlap = Math.max(0, Math.min(outRec.at, bEnd) - Math.max(inRec.at, bStart));
      workMs = Math.max(0, workMs - overlap);
    }
  }
  const workMinutes = Math.floor(workMs / MIN_MS);

  // ---- 各项分钟差 ----
  let lateMinutes = 0;
  let earlyMinutes = 0;
  let overtimeMinutes = 0;
  let shortMinutes = 0;
  const flags = {};

  if (!restDay && rs.type !== 'free') {
    if (inRec && expectInAt !== null) lateMinutes = Math.max(0, diffMinutes(inRec.at, expectInAt));
    if (rs.type === 'flexible') {
      if (outRec && expectOutAt !== null) {
        const short = Math.max(0, diffMinutes(expectOutAt, outRec.at));
        // 工时不足超过 15 分钟才算异常，避免 ±10 分钟抖动
        if (short > 15) {
          shortMinutes = short;
          flags.under = true;
        }
      }
      if (outRec && expectOutAt !== null) overtimeMinutes = Math.max(0, diffMinutes(outRec.at, expectOutAt));
    } else {
      if (outRec && expectOutAt !== null) {
        earlyMinutes = Math.max(0, diffMinutes(expectOutAt, outRec.at));
        overtimeMinutes = Math.max(0, diffMinutes(outRec.at, expectOutAt));
      }
    }

    if (lateMinutes > rs.lateGrace) flags.late = true;
    if (earlyMinutes > rs.earlyGrace) flags.early = true;
    if (overtimeMinutes > 0 && rs.overtimeMin > 0 ? overtimeMinutes >= rs.overtimeMin : overtimeMinutes > 0) flags.overtime = true;
  } else if (restDay && inRec) {
    // 休息日到岗 = 加班
    if (outRec) overtimeMinutes = Math.floor((outRec.at - inRec.at) / MIN_MS);
    flags.restDayWork = true;
    if (overtimeMinutes > 0) flags.overtime = true;
  }

  // ---- 缺卡 / 旷工 ----
  const graceMin = 120;
  const missingIn = !restDay && rs.type !== 'free' && !inRec && now > (expectInAt || 0) + graceMin * MIN_MS;
  const missingOut = !restDay && rs.type !== 'free' && !!inRec && !outRec && now > (expectOutAt || 0) + graceMin * MIN_MS;

  // 全天无任何记录且已过下班 2 小时 -> 旷工（仅固定/排班）
  if (expectOutAt !== null) {
    flags.absent = !inRec && !outRec && !restDay && rs.type !== 'free' && now > expectOutAt + graceMin * MIN_MS;
  }

  // ---- 汇总 status ----
  let status = 'normal';
  if (restDay && !flags.restDayWork) status = 'rest';
  else if (flags.absent) status = 'absent';
  else if (missingIn || missingOut) status = 'missing';
  else if (flags.late) status = 'late';
  else if (flags.early) status = 'early';
  else if (flags.under) status = 'under';
  else if (flags.overtime) status = 'overtime';

  return {
    dateKey: dayKey,
    restDay,
    shiftName,
    type: rs.type,
    inRec,
    outRec,
    inAt: inRec ? inRec.at : null,
    outAt: outRec ? outRec.at : null,
    expectInAt,
    expectOutAt,
    workMinutes,
    lateMinutes,
    earlyMinutes,
    overtimeMinutes,
    shortMinutes,
    flags,
    missingIn,
    missingOut,
    hasAny: !!(inRec || outRec),
    status,
  };
}

/** 状态 -> 展示文案与色调 */
const STATUS_META = {
  normal: { label: '正常', tone: 'ok' },
  late: { label: '迟到', tone: 'warn' },
  early: { label: '早退', tone: 'warn' },
  missing: { label: '缺卡', tone: 'bad' },
  absent: { label: '旷工', tone: 'bad' },
  under: { label: '工时不足', tone: 'warn' },
  overtime: { label: '加班', tone: 'accent' },
  rest: { label: '休息', tone: 'mute' },
  outside: { label: '范围外', tone: 'warn' },
  free: { label: '工时', tone: 'accent' },
};

function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.normal;
}

/** 某月所有应出勤日 */
function plannedDays(month, ruleSet) {
  const rs = ruleSet.id && ruleSet.shifts ? ruleSet : normalizeRuleSet(ruleSet);
  const info = monthInfo(month);
  const out = [];
  for (let i = 1; i <= info.days; i++) {
    const dayKey = info.y + '-' + pad2(info.m) + '-' + pad2(i);
    const sh = shiftOfDay(rs, dayKey);
    if (!sh.rest) out.push(dayKey);
  }
  return out;
}

module.exports = {
  TZ_OFFSET_MIN,
  DAY_MS,
  MIN_MS,
  WEEKDAY_TEXT,
  WEEKDAY_SHORT,
  RULE_TYPES,
  STATUS_META,
  pad2,
  partsOf,
  dayKeyOf,
  hhmmOf,
  hhmmssOf,
  msOfDayMinute,
  parseHHMM,
  hhmmOfMinute,
  shiftDayKey,
  dayDiff,
  monthInfo,
  monthKeyOf,
  diffMinutes,
  defaultRuleSet,
  normalizeRuleSet,
  normalizeShiftDef,
  ruleTypeName,
  describeRule,
  weekdaysText,
  fmtMinuteText,
  slotName,
  shiftOfDay,
  shiftWindow,
  resolveShiftDay,
  classifyPunch,
  pairDay,
  canApplyPatch,
  statusMeta,
  plannedDays,
};
