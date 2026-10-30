/**
 * 打卡记录的哈希链（防篡改）
 *
 * 为什么需要：
 *   本地存储 / 云数据库里的记录一旦能被客户端随意改写，"考勤"就没有证据价值。
 *   把每条记录与上一条的 hash 串成链，任何一条被改都能被 verifyChain 立刻发现。
 *
 * 注意：本模块只做"可发现篡改"，不等于"防伪造"。
 *   真正的防伪靠三件事：① 服务端授时（云函数 Date.now()）② 服务端 openid 归属
 *   ③ 服务端写入前复算 hash。客户端算的 hash 只能证明"这条没被本地改过"。
 */
const { sha256 } = require('./sha256');

/** 参与哈希的字段（保持稳定顺序，避免字段顺序影响结果） */
const HASH_FIELDS = [
  'uid',
  'dateKey',
  'type',
  'at',
  'clientAt',
  'source',
  'lat',
  'lng',
  'acc',
  'dist',
  'note',
  'patchId',
  'geoSkipped',
];

function pick(rec) {
  const out = {};
  HASH_FIELDS.forEach((k) => {
    const v = rec[k];
    out[k] = v === undefined || v === null ? null : v;
  });
  return out;
}

/** 归一化数值，保证 3 与 3.0 生成同一个 hash */
function normalize(rec) {
  const p = pick(rec);
  if (typeof p.lat === 'number') p.lat = Math.round(p.lat * 1e6) / 1e6;
  if (typeof p.lng === 'number') p.lng = Math.round(p.lng * 1e6) / 1e6;
  if (typeof p.acc === 'number') p.acc = Math.round(p.acc * 10) / 10;
  if (typeof p.dist === 'number') p.dist = Math.round(p.dist * 10) / 10;
  if (typeof p.at === 'number') p.at = Math.round(p.at);
  if (typeof p.clientAt === 'number') p.clientAt = Math.round(p.clientAt);
  return p;
}

/** 稳定 JSON：key 按字典序排序，无空格。必须与云端 common.js 的 stableStringify 完全一致 */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function payloadOf(rec, prevHash) {
  return stableStringify({ v: 1, prev: prevHash || 'genesis', rec: normalize(rec) });
}

/** 计算某条记录的 hash */
function hashOf(rec, prevHash) {
  return sha256(payloadOf(rec, prevHash));
}

/**
 * 追加一条记录到（按时间升序的）数组，自动填 seq / prevHash / hash。
 * 不修改入参，返回新数组。
 */
function append(list, rec, nowMs) {
  const src = list ? list.slice() : [];
  const last = src.length ? src[src.length - 1] : null;
  const prevHash = last ? last.hash : 'genesis';
  const next = Object.assign({}, rec);
  next.seq = src.length + 1;
  next.prevHash = prevHash;
  next.hash = hashOf(next, prevHash);
  next.createdAt = nowMs === undefined ? Date.now() : nowMs;
  src.push(next);
  return src;
}

/**
 * 校验整条链。
 * @returns {{ok:boolean, brokenAt:number|null, reason:string|null, count:number}}
 */
function verifyChain(list) {
  const src = Array.isArray(list) ? list : [];
  let prev = 'genesis';
  for (let i = 0; i < src.length; i++) {
    const rec = src[i];
    if (!rec || typeof rec !== 'object') {
      return { ok: false, brokenAt: i, reason: 'not-an-object', count: src.length };
    }
    if (rec.seq !== i + 1) {
      return { ok: false, brokenAt: i, reason: 'seq-mismatch', count: src.length };
    }
    if ((rec.prevHash || 'genesis') !== prev) {
      return { ok: false, brokenAt: i, reason: 'prev-hash-mismatch', count: src.length };
    }
    const expect = hashOf(rec, prev);
    if (expect !== rec.hash) {
      return { ok: false, brokenAt: i, reason: 'hash-mismatch', count: src.length };
    }
    prev = rec.hash;
  }
  return { ok: true, brokenAt: null, reason: null, count: src.length };
}

/** 生成一个不依赖随机数的可读 id（设备指纹 + 时间 + 序号） */
function makeId(uid, at, seq) {
  const base = String(uid || 'u') + '|' + String(at) + '|' + String(seq || 0);
  return 'R' + sha256(base).slice(0, 16);
}

module.exports = { HASH_FIELDS, hashOf, append, verifyChain, makeId, normalize, stableStringify, payloadOf };
