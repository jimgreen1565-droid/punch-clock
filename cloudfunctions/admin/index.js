/**
 * 云函数：admin
 *
 * 管理端能力：补卡审批、异常打卡审核、月度汇总、员工管理。
 * 权限：必须有 pc_users.role ∈ {admin, manager}，否则一律拒绝（服务端判权，不信任前端）。
 */
const cloud = require('wx-server-sdk');
const C = require('./common');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COL_USER = 'pc_users';
const COL_PUNCH = 'pc_punches';
const COL_PATCH = 'pc_patches';
const COL_AUDIT = 'pc_audit';

async function requireAdmin(openid, need) {
  const r = await db.collection(COL_USER).where({ openid }).limit(1).get();
  const u = r.data && r.data[0];
  if (!u) return { ok: false, error: C.fail('NO_USER', '员工档案不存在') };
  const role = u.role || 'employee';
  const allowed = need === 'manager' ? ['admin', 'manager'] : ['admin'];
  if (!allowed.includes(role)) return { ok: false, error: C.fail('FORBIDDEN', '无权限，需要 ' + need + ' 角色') };
  return { ok: true, user: u };
}

function monthRange(month) {
  const [y, m] = String(month).split('-').map(Number);
  const startBj = Date.UTC(y, m - 1, 1) - 8 * 3600 * 1000;
  const endBj = Date.UTC(y, m, 1) - 8 * 3600 * 1000;
  return { start: startBj, end: endBj };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return C.fail('NO_OPENID', '只能在微信内调用');

  const { action, payload } = C.parseEvent(event);
  const now = Date.now();

  try {
    const gate = await requireAdmin(OPENID, action === 'setRole' || action === 'staff' ? 'admin' : 'manager');
    if (!gate.ok) return gate.error;

    switch (action) {
      /* -------- 待办列表：待审批补卡 + 异常打卡 -------- */
      case 'pending': {
        const month = payload.month || C.beijing(now).monthKey;
        const [patches, abnormal] = await Promise.all([
          db.collection(COL_PATCH).where({ status: 'pending' }).orderBy('createdAt', 'desc').limit(50).get(),
          db
            .collection(COL_PUNCH)
            .where({ month, hashFlags: _.in(['timeSkew', 'geoSkipped', 'outOfRange']) })
            .orderBy('at', 'desc')
            .limit(50)
            .get(),
        ]);
        return C.ok({ patches: patches.data || [], abnormal: abnormal.data || [] });
      }

      /* -------- 审批补卡：approve 时真实写入一条 patch 记录 -------- */
      case 'approvePatch': {
        const { patchId, approve, at, note } = payload;
        const pr = await db.collection(COL_PATCH).doc(patchId).get().catch(() => null);
        if (!pr || !pr.data) return C.fail('NOT_FOUND', '补卡申请不存在');
        if (pr.data.status !== 'pending') return C.fail('ALREADY_DONE', '该申请已处理');

        const status = approve ? 'approved' : 'rejected';
        await db.collection(COL_PATCH).doc(patchId).update({
          data: { status, reviewedBy: OPENID, reviewedAt: now, reviewNote: (note || '').slice(0, 100) },
        });

        if (approve) {
          // 审批通过 -> 生成一条 source=patch 的记录，续在链尾
          const r = await db.collection(COL_PUNCH).where({ openid: pr.data.openid }).orderBy('seq', 'desc').limit(1).get();
          const last = r.data && r.data[0];
          const seq = last ? Number(last.seq) + 1 : 1;
          const prevHash = last ? last.hash : 'genesis';
          const rec = {
            openid: pr.data.openid,
            uid: pr.data.openid,
            companyId: pr.data.companyId || 'default',
            month: String(pr.data.dateKey).slice(0, 7),
            dateKey: pr.data.dateKey,
            type: pr.data.type || 'in',
            at: Number(at) || Number(pr.data.at) || now,
            clientAt: Number(pr.data.at) || now,
            source: 'patch',
            lat: null,
            lng: null,
            acc: null,
            dist: null,
            note: '补卡审批通过：' + (pr.data.reason || ''),
            patchId,
            restDay: false,
            status: 'patched',
            lateMinutes: 0,
            earlyMinutes: 0,
            overtimeMinutes: 0,
            geoSkipped: true,
            geoReason: 'patch',
            hashFlags: ['patched'],
            seq,
            prevHash,
            reviewedBy: OPENID,
            createdAt: now,
          };
          rec.hash = C.hashRecord(rec, prevHash);
          const ins = await db.collection(COL_PUNCH).add({ data: rec });
          await db.collection(COL_AUDIT).add({ data: { openid: OPENID, kind: 'approvePatch', refId: ins._id, target: pr.data.openid, at: now } }).catch(() => null);
        }
        return C.ok({ status });
      }

      /* -------- 月度汇总（管理视角，按人聚合） -------- */
      case 'summary': {
        const month = payload.month || C.beijing(now).monthKey;
        const { start, end } = monthRange(month);
        const r = await db.collection(COL_PUNCH).where({ month }).limit(3000).get();
        const recs = r.data || [];
        const byUser = {};
        recs.forEach((x) => {
          const k = x.openid;
          const u = byUser[k] || { openid: k, count: 0, lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0, abnormal: 0, days: {} };
          u.count += 1;
          u.lateMinutes += x.lateMinutes || 0;
          u.earlyMinutes += x.earlyMinutes || 0;
          u.overtimeMinutes += x.overtimeMinutes || 0;
          if ((x.hashFlags || []).length) u.abnormal += 1;
          u.days[x.dateKey] = true;
          byUser[k] = u;
        });
        const users = Object.keys(byUser).map((k) => {
          const u = byUser[k];
          return Object.assign({}, u, { days: Object.keys(u.days).length });
        });
        return C.ok({ month, range: { start, end }, count: recs.length, users });
      }

      /* -------- 员工列表与角色 -------- */
      case 'staff': {
        const r = await db.collection(COL_USER).limit(200).get();
        return C.ok({ staff: r.data || [] });
      }

      case 'setRole': {
        const { openid, role } = payload;
        if (!['admin', 'manager', 'employee'].includes(role)) return C.fail('BAD_ROLE', '非法角色');
        await db.collection(COL_USER).where({ openid }).update({ data: { role } });
        return C.ok({ openid, role });
      }

      /* -------- 审计日志 -------- */
      case 'audit': {
        const r = await db.collection(COL_AUDIT).orderBy('at', 'desc').limit(100).get();
        return C.ok({ items: r.data || [] });
      }

      default:
        return C.fail('BAD_ACTION', '未知操作 ' + action);
    }
  } catch (e) {
    return C.fail('ADMIN_ERROR', (e && e.message) || 'admin error');
  }
};
