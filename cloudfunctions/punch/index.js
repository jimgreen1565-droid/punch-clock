/**
 * 云函数：punch
 *
 * 核心原则：时间、openid、围栏、哈希、迟到判定 全部在服务端复算。
 * 客户端传来的 ruleSet 只作为「配置来源」，判定结果一律以服务端为准。
 *
 * 支持四种考勤规则类型（fixed / flexible / shift / free），规则本身存在
 * pc_configs.ruleSet 里（按 companyId 区分），调用时可覆盖。
 */
const cloud = require('wx-server-sdk');
const C = require('./common');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COL_PUNCH = 'pc_punches';
const COL_CFG = 'pc_configs';
const COL_RATE = 'pc_rate';
const COL_USER = 'pc_users';
const COL_AUDIT = 'pc_audit';

const MAX_SKEW_MS = 90 * 1000;

async function loadConfig(companyId) {
  const fallback = {
    companyId: 'default',
    ruleSet: { type: 'fixed', start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], lateGrace: 5, earlyGrace: 5, breakStart: '12:00', breakEnd: '13:00' },
    geo: { enabled: true, strict: true, radius: 300, lat: 39.908823, lng: 116.39747, name: '公司' },
    allowSkipGeo: true,
  };
  try {
    // 优先读"公司"集合的规则（管理员设置的、全员共享的那一份）
    const cR = await db.collection('pc_companies').where({ id: companyId }).limit(1).get();
    if (cR.data && cR.data.length) {
      const c = cR.data[0];
      return {
        companyId,
        ruleSet: c.ruleSet || fallback.ruleSet,
        geo: Object.assign({}, fallback.geo, (c.ruleSet && c.ruleSet.geo) || {}),
        allowSkipGeo: true,
      };
    }
  } catch (e) { /* 集合不存在时继续往下试旧配置 */ }

  try {
    const r = await db.collection(COL_CFG).where({ companyId }).limit(1).get();
    if (r.data && r.data.length) {
      const doc = r.data[0];
      return {
        companyId,
        ruleSet: doc.ruleSet || fallback.ruleSet,
        geo: Object.assign({}, fallback.geo, doc.geo || (doc.ruleSet && doc.ruleSet.geo) || {}),
        allowSkipGeo: doc.allowSkipGeo !== false,
      };
    }
    return fallback;
  } catch (e) {
    return fallback;
  }
}

async function nextSeqAndPrev(openid) {
  const r = await db.collection(COL_PUNCH).where({ openid }).orderBy('seq', 'desc').limit(1).get();
  const last = r.data && r.data[0] ? r.data[0] : null;
  return { seq: last ? Number(last.seq || 0) + 1 : 1, prevHash: last ? last.hash : 'genesis' };
}

async function dayRecords(openid, dateKey) {
  const r = await db.collection(COL_PUNCH).where({ openid, dateKey }).orderBy('at', 'asc').limit(50).get();
  return r.data || [];
}

function decideType(recs) {
  const ins = recs.filter((r) => r.type === 'in');
  const outs = recs.filter((r) => r.type === 'out');
  if (!ins.length) return 'in';
  if (!outs.length) return 'out';
  return 'in';
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return C.fail('NO_OPENID', '只能在微信内调用');

  const { action, payload } = C.parseEvent(event);
  const serverNow = Date.now();

  try {
    /* ---------- 读：列表 ---------- */
    if (action === 'list') {
      const month = (payload && payload.month) || C.beijing(serverNow).monthKey;
      const r = await db.collection(COL_PUNCH).where({ openid: OPENID, month }).orderBy('at', 'asc').limit(200).get();
      return C.ok({ month, records: r.data || [], serverNow });
    }

    /* ---------- 读：全链校验 ---------- */
    if (action === 'verify') {
      const all = await db.collection(COL_PUNCH).where({ openid: OPENID }).orderBy('seq', 'asc').limit(1000).get();
      const list = all.data || [];
      let prev = 'genesis';
      for (let i = 0; i < list.length; i++) {
        if ((list[i].prevHash || 'genesis') !== prev) {
          return C.ok({ ok: false, brokenAt: i, reason: 'prev-hash-mismatch', count: list.length });
        }
        if (C.hashRecord(list[i], prev) !== list[i].hash) {
          return C.ok({ ok: false, brokenAt: i, reason: 'hash-mismatch', count: list.length });
        }
        prev = list[i].hash;
      }
      return C.ok({ ok: true, brokenAt: null, count: list.length });
    }

    if (!['punch', 'default', 'add'].includes(action)) {
      return C.fail('BAD_ACTION', '未知操作 ' + action);
    }

    /* ---------- 写：打卡 ---------- */

    const rl = await C.rateLimit(db, COL_RATE, OPENID, 'punch', 5, 60 * 1000);
    if (!rl.allowed) return C.fail('RATE_LIMITED', '打卡过于频繁，请稍后再试');

    const userR = await db.collection(COL_USER).where({ openid: OPENID }).limit(1).get();
    const user = userR.data && userR.data[0];
    if (user && user.status === 'disabled') return C.fail('ACCOUNT_DISABLED', '账号已停用');

    const companyId = (user && user.companyId) || 'default';
    const cfg = await loadConfig(companyId);

    /* ---------------------------------------------------------------
       规则来源：**只信服务端的公司规则，绝不信客户端传的 ruleSet**。

       上一版写法是 `C.normalizeRuleSet(payload.ruleSet || cfg.ruleSet)`，
       这是真实的越权漏洞：员工改前端代码就能传一个
       {start:'00:00', lateGrace:600} 的规则，迟到永远不判、围栏形同虚设。
       现在改为：规则只从 pc_companies.ruleSet 读；payload.ruleSet 仅在
       "公司还没配置规则"时作为初始值采纳一次，且之后以服务端为准。

       单机/演示场景（没有公司、companyId='default'）允许客户端传规则，
       因为那时本来就没有"管理他人"的需求。
       --------------------------------------------------------------- */
    let rs;
    if (companyId === 'default' || !cfg.ruleSet) {
      // 无公司归属：单机模式，允许客户端规则（只影响自己）
      rs = C.normalizeRuleSet((payload && payload.ruleSet) || cfg.ruleSet);
    } else {
      // 有公司归属：以服务端规则为准，忽略 payload.ruleSet
      rs = C.normalizeRuleSet(cfg.ruleSet);
      if (payload && payload.ruleSet) {
        // 如果客户端传了规则但不一致，记一笔审计（可能是越权尝试，也可能是版本不一致）
        try {
          const clientRs = C.normalizeRuleSet(payload.ruleSet);
          if (clientRs.type !== rs.type ||
              clientRs.startMin !== rs.startMin ||
              clientRs.endMin !== rs.endMin ||
              clientRs.geo.radius !== rs.geo.radius) {
            await db.collection(COL_AUDIT).add({
              data: {
                openid: OPENID,
                kind: 'punch.ruleMismatch',
                at: serverNow,
                note: '客户端规则与服务端不一致，已以服务端为准',
              },
            }).catch(() => null);
          }
        } catch (e) { /* 审计失败不影响打卡 */ }
      }
    }

    // 地理位置配置：优先客户端 ruleSet.geo，其次公司配置
    const geo = Object.assign({}, cfg.geo, { radius: rs.geo.radius || cfg.geo.radius, strict: rs.geo.strict });
    if (rs.geo.lat && rs.geo.lng) {
      geo.lat = rs.geo.lat;
      geo.lng = rs.geo.lng;
    }
    if (!rs.geo.enabled) geo.enabled = false;

    const clientAt = Number(payload.clientAt || serverNow);
    const skew = clientAt - serverNow;
    const timeSkew = Math.abs(skew) > MAX_SKEW_MS;

    const dateKey = C.resolveShiftDay(serverNow, rs);
    const month = dateKey.slice(0, 7);

    // ---- 位置复算 ----
    const lat = typeof payload.lat === 'number' ? payload.lat : null;
    const lng = typeof payload.lng === 'number' ? payload.lng : null;
    const acc = typeof payload.acc === 'number' ? payload.acc : 0;
    const geoSkipped = !!(payload.geoSkipped || lat === null || lng === null);

    let fence = { ok: true, dist: null, reason: 'disabled' };
    if (geo.enabled && !geoSkipped) fence = C.inFence(lat, lng, acc, geo);

    const outOfRange = geo.enabled && !geoSkipped && !fence.ok && !!payload.outOfRange;

    if (geo.enabled && !geoSkipped && !fence.ok && geo.strict && !outOfRange) {
      return C.fail('OUT_OF_RANGE', '距打卡点 ' + Math.round(fence.dist) + ' 米，超出 ' + geo.radius + ' 米范围', {
        geo: { dist: fence.dist, acc, reason: fence.reason, radius: geo.radius },
        canOutside: rs.allowOutsideNote,
      });
    }
    if (geoSkipped && cfg.allowSkipGeo === false) {
      return C.fail('GEO_REQUIRED', '未获取到定位，无法打卡');
    }

    // ---- 类型与定级 ----
    const recs = await dayRecords(OPENID, dateKey);
    const type = payload.type === 'in' || payload.type === 'out' ? payload.type : decideType(recs);
    const graded = C.classifyOnServer(serverNow, type, dateKey, rs);

    // ---- 续链 ----
    const chainInfo = await nextSeqAndPrev(OPENID);

    const hashFlags = [timeSkew ? 'timeSkew' : null, geoSkipped ? 'geoSkipped' : null, outOfRange || (geo.enabled && !geoSkipped && !fence.ok) ? 'outOfRange' : null].filter(Boolean);

    const rec = {
      openid: OPENID,
      uid: OPENID,
      companyId,
      ruleType: rs.type,
      month,
      dateKey,
      type,
      at: serverNow,
      clientAt,
      clientSkewMs: skew,
      source: payload.patchId ? 'patch' : 'cloud',
      lat,
      lng,
      acc: acc || null,
      dist: fence.dist,
      note: String(payload.note || '').slice(0, 60),
      patchId: payload.patchId || null,
      geoSkipped,
      geoReason: fence.reason,
      restDay: graded.restDay,
      shiftName: graded.shiftName,
      status: outOfRange ? 'outside' : graded.status,
      lateMinutes: graded.lateMinutes,
      earlyMinutes: graded.earlyMinutes,
      overtimeMinutes: graded.overtimeMinutes,
      hashFlags,
      seq: chainInfo.seq,
      prevHash: chainInfo.prevHash,
      createdAt: serverNow,
    };
    rec.hash = C.hashRecord(rec, chainInfo.prevHash);

    const ins = await db.collection(COL_PUNCH).add({ data: rec });

    try {
      await db.collection(COL_AUDIT).add({
        data: { openid: OPENID, kind: 'punch', refId: ins._id, dateKey, type, at: serverNow, hash: rec.hash, prevHash: rec.prevHash },
      });
      await db.collection(COL_RATE).add({ data: { openid: OPENID, action: 'punch', at: serverNow } });
    } catch (e) {
      // 审计失败不影响打卡
    }

    return C.ok({
      id: ins._id,
      type,
      at: serverNow,
      clientAt,
      timeSkew,
      dateKey,
      month,
      ruleType: rs.type,
      status: rec.status,
      lateMinutes: rec.lateMinutes,
      earlyMinutes: rec.earlyMinutes,
      overtimeMinutes: rec.overtimeMinutes,
      dist: rec.dist,
      acc,
      geoSkipped,
      outOfRange,
      hashFlags,
      seq: rec.seq,
      hash: rec.hash,
      prevHash: rec.prevHash,
      restDay: rec.restDay,
      shiftName: rec.shiftName,
      serverNow,
    });
  } catch (e) {
    return C.fail('PUNCH_ERROR', (e && e.message) || 'punch error');
  }
};
