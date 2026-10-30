/**
 * 本地存储层（云端不可用时的完整数据层）
 *
 * 与上一版的变化：
 *   - 去掉「薪资/计薪」相关的一切配置与计算（本项目不统计薪酬）
 *   - 规则从「单一班次」升级为「规则集 ruleSet」，支持固定/弹性/排班/自由四种
 *   - 记录里新增 geoNote（范围外原因备注）、wifiSsid
 *
 * 存储键（前缀 PC_）：
 *   PC_BOOT     { uid, nickname, env, deviceId, createdAt }
 *   PC_RULESET  当前考勤规则集（含 geo/wifi/宽限/排班表）
 *   PC_PRESETS  用户保存的规则模板（可多套切换）
 *   PC_RECORDS  打卡记录数组（哈希链，按 at 升序）
 *   PC_LEAVES   请假/调休
 *   PC_PATCHES  补卡申请
 *   PC_META     安装信息
 */
const { append, verifyChain, makeId, hashOf } = require('../core/ledger');
const rules = require('../core/rules');

const K = {
  boot: 'PC_BOOT',
  ruleSet: 'PC_RULESET',
  presets: 'PC_PRESETS',
  records: 'PC_RECORDS',
  leaves: 'PC_LEAVES',
  patches: 'PC_PATCHES',
  meta: 'PC_META',
};

const MAX_RECORDS = 2000;

function readJSON(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    if (v === '' || v === undefined || v === null) return fallback;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    wx.setStorageSync(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

/** 设备指纹（不采集隐私字段，只用平台/系统/机型/屏幕做盐） */
function makeDeviceId() {
  let salt = 'fallback';
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    salt = [info.platform || '', info.system || '', info.model || '', info.pixelRatio || '', win.screenWidth || ''].join('|');
  } catch (e) {
    salt = 'fallback';
  }
  return 'D' + hashOf({ device: salt }, 'genesis').slice(0, 12);
}

/* ------------------------------ 初始化 ------------------------------ */

function init() {
  if (!readJSON(K.meta, null)) writeJSON(K.meta, { installedAt: Date.now(), version: 2 });

  if (!readJSON(K.boot, null)) {
    const deviceId = makeDeviceId();
    writeJSON(K.boot, {
      uid: 'U' + hashOf({ deviceId, t: Date.now() }, 'genesis').slice(0, 12),
      nickname: '',
      deviceId,
      env: 'local',
      createdAt: Date.now(),
    });
  }

  if (!readJSON(K.ruleSet, null)) {
    writeJSON(K.ruleSet, rules.defaultRuleSet());
  } else {
    // 老版本升级：把旧的 shift 结构迁移成 ruleSet
    const old = readJSON(K.ruleSet, {});
    if (!old.type) writeJSON(K.ruleSet, rules.normalizeRuleSet(old));
  }

  if (!readJSON(K.presets, null)) writeJSON(K.presets, []);
  if (!readJSON(K.records, null)) writeJSON(K.records, []);
  if (!readJSON(K.leaves, null)) writeJSON(K.leaves, []);
  if (!readJSON(K.patches, null)) writeJSON(K.patches, []);
}

/* ------------------------------ 身份 ------------------------------ */

function getBootInfo() {
  return readJSON(K.boot, { uid: 'U000000000000', nickname: '', env: 'local' });
}

function setNickname(name) {
  const boot = getBootInfo();
  boot.nickname = String(name || '').slice(0, 20);
  writeJSON(K.boot, boot);
  return boot;
}

function setEnv(env) {
  const boot = getBootInfo();
  boot.env = env;
  writeJSON(K.boot, boot);
}

/* ------------------------------ 规则集 ------------------------------ */

function getRuleSetRaw() {
  return readJSON(K.ruleSet, rules.defaultRuleSet());
}

function getRuleSet() {
  return rules.normalizeRuleSet(getRuleSetRaw());
}

/** 局部更新规则集（深合并 geo/wifi/rotation） */
function setRuleSet(patch) {
  const cur = getRuleSetRaw();
  const next = Object.assign({}, cur, patch || {});
  if (patch && patch.geo) next.geo = Object.assign({}, cur.geo || {}, patch.geo);
  if (patch && patch.wifi) next.wifi = Object.assign({}, cur.wifi || {}, patch.wifi);
  if (patch && patch.rotation) next.rotation = Object.assign({}, cur.rotation || {}, patch.rotation);
  next.updatedAt = Date.now();
  writeJSON(K.ruleSet, rules.normalizeRuleSet(next));
  return getRuleSet();
}

/** 切换规则类型（保留已有的时间/地点等值） */
function switchRuleType(type) {
  if (!rules.RULE_TYPES.some((t) => t.id === type)) return getRuleSet();
  return setRuleSet({ type });
}

/** 重置为某类型默认值 */
function resetRuleType(type) {
  const d = rules.defaultRuleSet();
  d.type = type;
  writeJSON(K.ruleSet, rules.normalizeRuleSet(d));
  return getRuleSet();
}

/* ------------------------------ 规则模板 ------------------------------ */

function getPresets() {
  const list = readJSON(K.presets, []);
  return Array.isArray(list) ? list : [];
}

function savePreset(name) {
  const list = getPresets();
  const rs = getRuleSet();
  const preset = {
    id: 'PR' + Date.now().toString(36),
    name: String(name || rs.name || '未命名规则').slice(0, 20),
    ruleSet: rs,
    createdAt: Date.now(),
  };
  list.unshift(preset);
  writeJSON(K.presets, list.slice(0, 20));
  return preset;
}

function applyPreset(id) {
  const p = getPresets().find((x) => x.id === id);
  if (!p) return getRuleSet();
  writeJSON(K.ruleSet, rules.normalizeRuleSet(p.ruleSet));
  return getRuleSet();
}

function removePreset(id) {
  writeJSON(K.presets, getPresets().filter((x) => x.id !== id));
}

/* ------------------------------ 记录 ------------------------------ */

function getRecords() {
  const list = readJSON(K.records, []);
  return Array.isArray(list) ? list : [];
}

function getRecordsByDay(dayKey) {
  return getRecords().filter((r) => r.dateKey === dayKey);
}

/**
 * 追加打卡记录。
 * @param {object} input {type, at, clientAt, source, lat, lng, acc, dist, note, patchId, dateKey, geoSkipped, geoReason, wifiSsid, shiftId, shiftName, outOfRange}
 */
function addRecord(input) {
  const uid = getBootInfo().uid;
  const list = getRecords();
  const at = Number(input.at) || Date.now();
  const trimmed = list.length >= MAX_RECORDS ? list.slice(list.length - MAX_RECORDS + 1) : list;

  const rec = {
    uid,
    dateKey: input.dateKey || rules.dayKeyOf(at),
    type: input.type === 'out' ? 'out' : 'in',
    at,
    clientAt: Number(input.clientAt) || at,
    source: input.source || 'miniprogram',
    lat: typeof input.lat === 'number' ? input.lat : null,
    lng: typeof input.lng === 'number' ? input.lng : null,
    acc: typeof input.acc === 'number' ? input.acc : null,
    dist: typeof input.dist === 'number' ? input.dist : null,
    note: String(input.note || '').slice(0, 60),
    patchId: input.patchId || null,
    geoSkipped: !!input.geoSkipped,
    wifiSsid: input.wifiSsid || null,
    shiftId: input.shiftId || null,
    shiftName: input.shiftName || null,
  };

  const next = append(trimmed, rec, Date.now());
  const written = next[next.length - 1];
  written.id = makeId(uid, at, written.seq);
  writeJSON(K.records, next);
  return written;
}

function deleteRecord(id) {
  const list = getRecords().filter((r) => r.id !== id);
  const rebuilt = list.reduce((acc, r) => {
    const prev = acc.length ? acc[acc.length - 1].hash : 'genesis';
    const copy = Object.assign({}, r, { seq: acc.length + 1, prevHash: prev });
    copy.hash = hashOf(copy, prev);
    acc.push(copy);
    return acc;
  }, []);
  writeJSON(K.records, rebuilt);
  return rebuilt.length;
}

function verifyLocalChain() {
  return verifyChain(getRecords());
}

/** 需要处理的条数（今日异常 + 待审补卡） */
function unresolvedCount(nowMs) {
  const rs = getRuleSet();
  const now = nowMs || Date.now();
  const dayKey = rules.resolveShiftDay(now, rs);
  const day = rules.pairDay(getRecords(), rs, dayKey, now);
  let n = 0;
  if (!day.restDay && (day.missingIn || day.missingOut || day.status === 'absent')) n += 1;
  if (!day.restDay && (day.status === 'late' || day.status === 'early')) n += 1;
  n += getPatches().filter((p) => p.status === 'pending').length;
  return n;
}

/* ------------------------------ 请假 / 补卡 ------------------------------ */

function uniqueId(prefix, list) {
  const base = prefix + Date.now().toString(36);
  let id = base;
  let n = 1;
  const taken = {};
  (list || []).forEach((x) => {
    if (x && x.id) taken[x.id] = true;
  });
  while (taken[id]) id = base + '-' + ++n;
  return id;
}

function getLeaves() {
  const list = readJSON(K.leaves, []);
  return Array.isArray(list) ? list : [];
}

function addLeave(leave) {
  const list = getLeaves();
  list.push(Object.assign({ createdAt: Date.now() }, leave, { id: uniqueId('L', list) }));
  list.sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
  writeJSON(K.leaves, list);
  return list;
}

function removeLeave(id) {
  const list = getLeaves().filter((l) => l.id !== id);
  writeJSON(K.leaves, list);
  return list;
}

function getPatches() {
  const list = readJSON(K.patches, []);
  return Array.isArray(list) ? list : [];
}

function addPatch(patch) {
  const list = getPatches();
  list.push(Object.assign({ status: 'pending' }, patch, { id: uniqueId('P', list), createdAt: Date.now() }));
  writeJSON(K.patches, list);
  return list;
}

function resolvePatch(id, status) {
  const list = getPatches().map((p) => (p.id === id ? Object.assign({}, p, { status, reviewedAt: Date.now() }) : p));
  writeJSON(K.patches, list);
  return list;
}

function resetAll() {
  Object.keys(K).forEach((k) => {
    try {
      wx.removeStorageSync(K[k]);
    } catch (e) {
      // ignore
    }
  });
  init();
}

module.exports = {
  K,
  init,
  getBootInfo,
  setNickname,
  setEnv,
  getRuleSetRaw,
  getRuleSet,
  setRuleSet,
  switchRuleType,
  resetRuleType,
  getPresets,
  savePreset,
  applyPreset,
  removePreset,
  getRecords,
  getRecordsByDay,
  addRecord,
  deleteRecord,
  verifyLocalChain,
  unresolvedCount,
  getLeaves,
  addLeave,
  removeLeave,
  getPatches,
  addPatch,
  resolvePatch,
  resetAll,
};
