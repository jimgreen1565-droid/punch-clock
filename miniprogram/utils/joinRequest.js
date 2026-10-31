/**
 * 加入申请（审批流）
 *
 * 上一版拿到邀请码就立刻成为成员。真实公司通常要管理员批一下，理由：
 *   · 邀请码可能被转发到公司外
 *   · 管理员需要在员工进来前就设好角色/部门
 *   · 有人用离职同事的码回流
 *
 * 状态机（严格单向，不允许跳步）：
 *   pending   → 已提交，等管理员处理
 *   approved  → 管理员已批准，已写入成员
 *   rejected  → 管理员已驳回（带原因）
 *   cancelled → 申请人自己撤回
 *
 * 关键设计：
 *   1. **申请本身不授予任何权限**。只有 approved 才产生 member 记录。
 *   2. **同一人同一公司只能有一条 pending 申请**，避免刷屏。
 *   3. **申请必须带申请理由**（可选但会展示给管理员）——纯"点一下就进"的流程
 *      在真实团队里会被人情压力滥用。
 *   4. 被驳回后可以再次申请，但有冷却时间，防止骚扰。
 */
const P = require('../core/permissions');
const rules = require('../core/rules');

const K_JOIN = 'PC_JOIN_REQUESTS';

const STATUS = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  cancelled: '已撤回',
};

/** 驳回后多久才能再次申请（毫秒） */
const RECHECK_COOLDOWN = 10 * 60 * 1000;

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

function getRequests() {
  const list = readJSON(K_JOIN, []);
  return Array.isArray(list) ? list : [];
}

function setRequests(list) {
  writeJSON(K_JOIN, list);
  return list;
}

/**
 * 提交加入申请。
 * @param {object} args {companyId, uid, nickname, reason, inviteCode}
 * @returns {{ok, code, message, request}}
 */
function submit(args) {
  const now = Date.now();
  const list = getRequests();

  // 已经有 pending 的申请 → 不重复提交
  const pending = list.find(
    (r) => r.companyId === args.companyId && r.uid === args.uid && r.status === 'pending'
  );
  if (pending) {
    return { ok: false, code: 'ALREADY_PENDING', message: '你已经提交过申请，请等待管理员处理', request: pending };
  }

  // 冷却检查：最近一次被驳回，且未过冷却期
  const lastRejected = list
    .filter((r) => r.companyId === args.companyId && r.uid === args.uid && r.status === 'rejected')
    .sort((a, b) => (b.reviewedAt || 0) - (a.reviewedAt || 0))[0];
  if (lastRejected && now - (lastRejected.reviewedAt || 0) < RECHECK_COOLDOWN) {
    const waitMin = Math.ceil((RECHECK_COOLDOWN - (now - (lastRejected.reviewedAt || 0))) / 60000);
    return { ok: false, code: 'COOLING', message: '刚被驳回，请等 ' + waitMin + ' 分钟后再申请' };
  }

  const req = {
    id: 'J' + now.toString(36) + String(list.length % 97),
    companyId: args.companyId,
    uid: args.uid,
    nickname: String(args.nickname || '申请人').slice(0, 16),
    reason: String(args.reason || '').slice(0, 100),
    inviteCode: args.inviteCode || null,
    status: 'pending',
    createdAt: now,
  };
  list.push(req);
  setRequests(list);
  return { ok: true, code: 'OK', message: '申请已提交，等待管理员审批', request: req };
}

/** 待审批列表（按提交时间升序，先到先审） */
function pendingList(companyId) {
  return getRequests()
    .filter((r) => r.companyId === companyId && r.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 我的申请状态（用于员工端展示"审核中"） */
function myLatest(companyId, uid) {
  return (
    getRequests()
      .filter((r) => r.companyId === companyId && r.uid === uid)
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null
  );
}

/**
 * 审批。**必须传 operatorRole**，由调用方从权限模块取，
 * 这里再做一次校验（纵深防御），避免调用方忘记传。
 */
function review(args) {
  const { requestId, approve, operatorUid, operatorRole, note } = args;

  if (!P.can(operatorRole, 'patch.approve') && !P.can(operatorRole, 'member.invite')) {
    return { ok: false, code: 'FORBIDDEN', message: '你没有审批加入申请的权限' };
  }

  const list = getRequests();
  const req = list.find((r) => r.id === requestId);
  if (!req) return { ok: false, code: 'NOT_FOUND', message: '申请不存在' };
  if (req.status !== 'pending') {
    return { ok: false, code: 'ALREADY_REVIEWED', message: '这条申请已经处理过了（' + STATUS[req.status] + '）' };
  }

  req.status = approve ? 'approved' : 'rejected';
  req.reviewedAt = Date.now();
  req.reviewedBy = operatorUid;
  req.reviewNote = String(note || '').slice(0, 100);
  setRequests(list);

  return {
    ok: true,
    code: 'OK',
    message: approve ? '已通过，对方可以开始打卡' : '已驳回',
    request: req,
  };
}

/** 申请人撤回 */
function cancel(requestId, uid) {
  const list = getRequests();
  const req = list.find((r) => r.id === requestId);
  if (!req) return { ok: false, message: '申请不存在' };
  if (req.uid !== uid) return { ok: false, message: '只能撤回自己的申请' };
  if (req.status !== 'pending') return { ok: false, message: '已经处理过的申请不能撤回' };
  req.status = 'cancelled';
  req.cancelledAt = Date.now();
  setRequests(list);
  return { ok: true, message: '已撤回' };
}

/** 统计（管理员看板用） */
function stats(companyId) {
  const list = getRequests().filter((r) => r.companyId === companyId);
  return {
    pending: list.filter((r) => r.status === 'pending').length,
    approved: list.filter((r) => r.status === 'approved').length,
    rejected: list.filter((r) => r.status === 'rejected').length,
    total: list.length,
  };
}

/** 清空（重置数据时用） */
function clearAll() {
  writeJSON(K_JOIN, []);
}

module.exports = {
  K_JOIN,
  STATUS,
  RECHECK_COOLDOWN,
  getRequests,
  submit,
  pendingList,
  myLatest,
  review,
  cancel,
  stats,
  clearAll,
};
