/**
 * 云函数公共工具（由 scripts/sync-shared.js 复制到每个云函数目录）
 *
 * 云函数之间不能互相 require，所以每个函数目录各带一份。保持零依赖 + 幂等。
 *
 * 这里同时承载「服务端版规则引擎」：云端必须能独立复算班次窗口与迟到，
 * 不能信任客户端传上来的判定结果。
 */
const crypto = require('crypto');

const DAY_MS = 86400000;
const MIN_MS = 60000;
const TZ_OFFSET_MIN = 480;

function ok(data) {
  return { ok: true, data: data === undefined ? null : data, ts: Date.now() };
}

function fail(code, message, extra) {
  return Object.assign({ ok: false, error: { code, message } }, extra || {});
}

function parseEvent(event) {
  const e = event || {};
  if (e && typeof e.action === 'string') {
    return { action: e.action, payload: e.payload && typeof e.payload === 'object' ? e.payload : {} };
  }
  return { action: e.action || 'default', payload: e };
}

/* --------------------------- JSON / 哈希 --------------------------- */

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function sha256(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

/** 参与哈希的字段白名单（必须与小程序 core/ledger.js 完全一致） */
const HASH_FIELDS = ['uid', 'dateKey', 'type', 'at', 'clientAt', 'source', 'lat', 'lng', 'acc', 'dist', 'note', 'patchId', 'geoSkipped'];

function hashRecord(rec, prevHash) {
  const picked = {};
  HASH_FIELDS.forEach((k) => {
    const v = rec[k];
    picked[k] = v === undefined || v === null ? null : v;
  });
  if (typeof picked.lat === 'number') picked.lat = Math.round(picked.lat * 1e6) / 1e6;
  if (typeof picked.lng === 'number') picked.lng = Math.round(picked.lng * 1e6) / 1e6;
  if (typeof picked.acc === 'number') picked.acc = Math.round(picked.acc * 10) / 10;
  if (typeof picked.dist === 'number') picked.dist = Math.round(picked.dist * 10) / 10;
  if (typeof picked.at === 'number') picked.at = Math.round(picked.at);
  if (typeof picked.clientAt === 'number') picked.clientAt = Math.round(picked.clientAt);
  return sha256(stableStringify({ v: 1, prev: prevHash || 'genesis', rec: picked }));
}

/* --------------------------- 时间 --------------------------- */

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function beijing(ms) {
  const d = new Date((ms === undefined ? Date.now() : ms) + TZ_OFFSET_MIN * MIN_MS);
  const w = d.getUTCDay();
  return {
    dateKey: d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()),
    monthKey: d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1),
    hhmm: pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()),
    hhmmss: pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: w === 0 ? 7 : w,
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
  };
}

function parseHHMM(v) {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!mt) return null;
  const h = Number(mt[1]);
  const m = Number(mt[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function msOfDayMinute(dayKey, minute) {
  const seg = String(dayKey).split('-').map(Number);
  return Date.UTC(seg[0], seg[1] - 1, seg[2]) + minute * MIN_MS - TZ_OFFSET_MIN * MIN_MS;
}

function shiftDayKey(dayKey, delta) {
  const seg = String(dayKey).split('-').map(Number);
  const d = new Date(Date.UTC(seg[0], seg[1] - 1, seg[2]) + delta * DAY_MS);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function dayDiff(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  return Math.round((Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / DAY_MS);
}

function diffMinutes(a, b) {
  return Math.round((a - b) / MIN_MS);
}

function hhmmOfMinute(minute) {
  const v = ((minute % 1440) + 1440) % 1440;
  return pad2(Math.floor(v / 60)) + ':' + pad2(v % 60);
}

/* --------------------------- 服务端规则引擎 --------------------------- */

const RULE_TYPES = ['fixed', 'flexible', 'shift', 'free'];

/** 数字夹逼：非有限值或非法则回落 fallback */
/** 取数字配置：缺省用 fallback，负数归 0，超出夹边界（与客户端 pickNum 同口径） */
function pickNum(v, fallback, min, max) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.max(min, Math.min(max, n));
}

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback === undefined ? min : fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * 把客户端传来的 ruleSet 规整成安全值。任何非法字段一律回落默认，
 * 防止客户端传 `weekdays: []` 之类的脏数据把云端判定搞崩。
 */
function normalizeRuleSet(raw) {
  const src = raw || {};
  const type = RULE_TYPES.indexOf(src.type) >= 0 ? src.type : 'fixed';
  const startMin = parseHHMM(src.start);
  const endMin = parseHHMM(src.end);
  const latestStartMin = parseHHMM(src.latestStart);

  const weekdaysRaw = Array.isArray(src.weekdays) ? src.weekdays.map(Number).filter((x) => x >= 1 && x <= 7) : [];
  const weekdays = weekdaysRaw.length ? weekdaysRaw.sort((a, b) => a - b) : [1, 2, 3, 4, 5];

  const breakStartMin = parseHHMM(src.breakStart);
  const breakEndMin = parseHHMM(src.breakEnd);

  const geo = src.geo || {};
  const radius = Math.max(0, Number(geo.radius) || 0);

  return {
    type,
    weekdays,
    startMin: startMin === null ? 540 : startMin,
    endMin: endMin === null ? 1080 : endMin,
    crossDay: (endMin === null ? 1080 : endMin) <= (startMin === null ? 540 : startMin),
    latestStartMin: latestStartMin === null ? 600 : latestStartMin,
    earliestEndMin: parseHHMM(src.earliestEnd) === null ? 1050 : parseHHMM(src.earliestEnd),
    requiredMinutes: clamp(Number(src.requiredMinutes) || 480, 60, 1440),
    dailyTargetMinutes: clamp(Number(src.dailyTargetMinutes) || 480, 0, 1440),
    // 与客户端 core/rules.js 同一口径：缺省用默认 5/5/30，显式 0 才是 0，负数归 0
    lateGrace: pickNum(src.lateGrace, 5, 0, 120),
    earlyGrace: pickNum(src.earlyGrace, 5, 0, 120),
    overtimeMin: pickNum(src.overtimeMin, 30, 0, 240),
    breakStartMin,
    breakEndMin,
    breakMinutes: breakStartMin !== null && breakEndMin !== null && breakEndMin > breakStartMin ? breakEndMin - breakStartMin : 0,
    shifts: (Array.isArray(src.shifts) && src.shifts.length ? src.shifts : [{ id: 'std', name: '标准班' }]).map((s, i) => ({
      id: s.id || 'S' + (i + 1),
      name: s.name || '班次' + (i + 1),
      startMin: parseHHMM(s.start) === null ? 540 : parseHHMM(s.start),
      endMin: parseHHMM(s.end) === null ? 1080 : parseHHMM(s.end),
      crossDay: (parseHHMM(s.end) === null ? 1080 : parseHHMM(s.end)) <= (parseHHMM(s.start) === null ? 540 : parseHHMM(s.start)),
    })),
    rotation: {
      enabled: !!(src.rotation && src.rotation.enabled),
      cycleDays: Math.max(1, Math.min(60, Number(src.rotation && src.rotation.cycleDays) || 1)),
      slots: (src.rotation && Array.isArray(src.rotation.slots) ? src.rotation.slots : ['REST']).map(String),
      anchorDate: (src.rotation && src.rotation.anchorDate) || '',
    },
    geo: {
      enabled: geo.enabled !== false,
      strict: geo.strict !== false,
      radius,
      lat: Number(geo.lat) || 0,
      lng: Number(geo.lng) || 0,
    },
    allowOutsideNote: src.allowOutsideNote !== false,
  };
}

/** 某天的班次安排 */
function shiftOfDay(rs, dayKey) {
  if (rs.type === 'free') return { rest: false, shift: null, name: '自由工时' };

  if (rs.type === 'shift' && rs.rotation.enabled) {
    const anchor = rs.rotation.anchorDate || dayKey;
    const idx = ((dayDiff(dayKey, anchor) % rs.rotation.cycleDays) + rs.rotation.cycleDays) % rs.rotation.cycleDays;
    const slot = rs.rotation.slots[idx];
    if (!slot || slot === 'REST') return { rest: true, shift: null, name: '休息' };
    const sh = rs.shifts.find((x) => x.id === slot) || rs.shifts[0];
    return { rest: false, shift: sh, name: sh.name };
  }

  const wk = beijing(msOfDayMinute(dayKey, 720)).weekday;
  if (rs.weekdays.indexOf(wk) < 0) return { rest: true, shift: null, name: '休息' };

  if (rs.type === 'shift') {
    const sh = rs.shifts[0];
    return { rest: false, shift: sh, name: sh.name };
  }
  return {
    rest: false,
    shift: { id: 'std', name: rs.type === 'flexible' ? '弹性班' : '标准班', startMin: rs.startMin, endMin: rs.endMin, crossDay: rs.crossDay },
    name: rs.type === 'flexible' ? '弹性班' : '标准班',
  };
}

function shiftWindow(dayKey, shift) {
  const inAt = msOfDayMinute(dayKey, shift.startMin);
  const outAt = msOfDayMinute(dayKey, shift.endMin) + (shift.crossDay ? DAY_MS : 0);
  return { dateKey: dayKey, inAt, outAt };
}

/**
 * 打卡归属的班次日。与小程序 core/rules.js 保持完全相同的两级判定：
 * 先强匹配（窗口内），再弱匹配（容忍带），都先今天后昨天。
 */
function resolveShiftDay(ms, rs) {
  const todayKey = beijing(ms).dateKey;
  if (rs.type === 'free') return todayKey;

  const TOL_BEFORE = 30 * MIN_MS;
  const TOL_AFTER = 6 * 60 * MIN_MS;

  const windowOf = (dk) => {
    const info = shiftOfDay(rs, dk);
    if (info.rest || !info.shift) return null;
    return shiftWindow(dk, info.shift);
  };

  const yKey = shiftDayKey(todayKey, -1);
  const t = windowOf(todayKey);
  const y = windowOf(yKey);

  if (t && ms >= t.inAt && ms <= t.outAt) return todayKey;
  if (y && ms >= y.inAt && ms <= y.outAt) return yKey;

  if (t && ms >= t.inAt - TOL_BEFORE && ms <= t.outAt + TOL_AFTER) return todayKey;
  if (y && ms >= y.inAt - TOL_BEFORE && ms <= y.outAt + TOL_AFTER) return yKey;

  return todayKey;
}

/** 服务端定级：只信任自己算出来的分钟数 */
function classifyOnServer(serverNow, type, dayKey, rs) {
  const info = shiftOfDay(rs, dayKey);
  const base = { status: 'normal', restDay: info.rest, shiftName: info.name, lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0 };
  if (rs.type === 'free' || info.rest || !info.shift) return base;

  if (rs.type === 'flexible') {
    if (type === 'in') {
      const late = Math.max(0, diffMinutes(serverNow, msOfDayMinute(dayKey, rs.latestStartMin)));
      return late > rs.lateGrace ? Object.assign({}, base, { status: 'late', lateMinutes: late }) : base;
    }
    return base;
  }

  const win = shiftWindow(dayKey, info.shift);
  if (type === 'in') {
    const late = Math.max(0, diffMinutes(serverNow, win.inAt));
    return late > rs.lateGrace ? Object.assign({}, base, { status: 'late', lateMinutes: late }) : base;
  }
  const early = Math.max(0, diffMinutes(win.outAt, serverNow));
  const over = Math.max(0, diffMinutes(serverNow, win.outAt));
  if (early > rs.earlyGrace) return Object.assign({}, base, { status: 'early', earlyMinutes: early });
  if (over > 0) return Object.assign({}, base, { status: 'overtime', overtimeMinutes: over });
  return base;
}

/* --------------------------- 地理 --------------------------- */

function distance(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function inFence(lat, lng, acc, geo) {
  if (lat === null || lng === null) return { ok: false, dist: null, reason: 'no-position' };
  const dist = distance(lat, lng, geo.lat, geo.lng);
  const accVal = Math.max(0, Number(acc) || 0);
  const effective = dist - accVal;
  const inRange = effective <= geo.radius && accVal <= geo.radius;
  return {
    ok: inRange,
    dist: Math.round(dist * 10) / 10,
    acc: accVal,
    effective: Math.round(effective * 10) / 10,
    reason: inRange ? 'ok' : accVal > geo.radius ? 'low-accuracy' : 'out-of-range',
  };
}

/* --------------------------- 限流 --------------------------- */

async function rateLimit(db, collection, openid, action, limit, windowMs) {
  const now = Date.now();
  const from = now - windowMs;
  try {
    const r = await db.collection(collection).where({ openid, action, at: db.command.gte(from) }).count();
    return { allowed: r.total < limit, used: r.total, limit };
  } catch (e) {
    return { allowed: true, used: 0, limit, degraded: true };
  }
}

module.exports = {
  DAY_MS,
  MIN_MS,
  TZ_OFFSET_MIN,
  RULE_TYPES,
  ok,
  fail,
  parseEvent,
  stableStringify,
  sha256,
  hashRecord,
  HASH_FIELDS,
  pad2,
  beijing,
  parseHHMM,
  msOfDayMinute,
  shiftDayKey,
  dayDiff,
  diffMinutes,
  hhmmOfMinute,
  normalizeRuleSet,
  shiftOfDay,
  shiftWindow,
  resolveShiftDay,
  classifyOnServer,
  distance,
  inFence,
  rateLimit,
};
