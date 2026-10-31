/**
 * 给 company.js 接入"加入申请审批流"
 *
 * 改动：
 *   1. 旧的 joinByInvite（直接加入）保留，但改为"需要审批"模式可切换
 *   2. 新增 applyToJoin（提交申请）/ approveJoin / rejectJoin / listPendingJoins
 *   3. 公司设置 requireApproval：true=需要审批，false=老行为（码即入）
 */
const fs = require('fs');
const path = require('path');

const f = path.resolve(__dirname, '..', 'miniprogram', 'utils', 'company.js');
let s = fs.readFileSync(f, 'utf8');
if (s.indexOf('\r\n') >= 0) s = s.replace(/\r\n/g, '\n');

// 1) require
if (!s.includes("require('./joinRequest')")) {
  s = s.replace(
    "const rules = require('../core/rules');",
    "const rules = require('../core/rules');\nconst joinRequest = require('./joinRequest');"
  );
}

// 2) ensureCompany 里加 requireApproval 默认 true（真实团队默认要审批）
s = s.replace(
    "    createdAt: now,\n    // 规则存在公司上，成员共享；个人不能改（见 permissions）\n    ruleSet: rules.defaultRuleSet(),",
    "    createdAt: now,\n    // 加入是否需要管理员审批。真实团队默认 true，避免邀请码外流后无人把关\n    requireApproval: true,\n    // 规则存在公司上，成员共享；个人不能改（见 permissions）\n    ruleSet: rules.defaultRuleSet(),"
);

// 3) 插入申请相关函数（放在 joinByInvite 之前）
const anchor = 'function joinByInvite(rawCode, uid, nickname) {';
const insert = `/**
 * 提交加入申请（不立即成为成员，等管理员审批）。
 * @returns {{ok, code, message, request}}
 */
function applyToJoin(rawCode, uid, nickname, reason) {
  const code = P.normalizeInviteCode(rawCode);
  if (!code) return { ok: false, code: 'BAD_FORMAT', message: '邀请码是 6 位字母数字' };

  const company = getCompany();
  if (!company) return { ok: false, code: 'NO_COMPANY', message: '本机还没有公司' };
  if (company.inviteCode !== code) return { ok: false, code: 'WRONG_CODE', message: '邀请码不正确' };

  // 已经是成员 → 不用申请
  if (getMembers().some((m) => m.uid === uid && m.status === 'active')) {
    return { ok: false, code: 'ALREADY_IN', message: '你已经是这家公司的成员' };
  }

  const r = joinRequest.submit({
    companyId: company.id,
    uid,
    nickname: String(nickname || '申请人'),
    reason: String(reason || ''),
    inviteCode: code,
  });
  return r;
}

/** 我在这家公司的申请状态 */
function myJoinStatus(uid) {
  const company = getCompany();
  if (!company) return null;
  if (getMembers().some((m) => m.uid === uid && m.status === 'active')) {
    return { status: 'approved', isMember: true };
  }
  const latest = joinRequest.myLatest(company.id, uid);
  return latest ? { status: latest.status, request: latest, isMember: false } : null;
}

/** 待审批的申请（仅能审批的角色） */
function listPendingJoins(operatorUid) {
  if (!P.can(roleOf(operatorUid), 'member.invite')) return [];
  const company = getCompany();
  if (!company) return [];
  return joinRequest.pendingList(company.id);
}

/**
 * 审批一条加入申请。通过时才真正写入成员，角色固定 member。
 * @returns {{ok, message, member?}}
 */
function reviewJoin(requestId, approve, operatorUid, note) {
  const operatorRole = roleOf(operatorUid);
  const r = joinRequest.review({
    requestId,
    approve,
    operatorUid,
    operatorRole,
    note,
  });
  if (!r.ok) return r;

  if (approve) {
    const req = r.request;
    // 纵深防御：再次确认不是成员，避免重复写入
    if (getMembers().some((m) => m.uid === req.uid && m.status === 'active')) {
      return { ok: false, message: '该用户已经是成员了' };
    }
    const members = getMembers();
    const member = {
      uid: req.uid,
      nickname: req.nickname,
      // 关键：角色**固定为 member**，不接受申请里传来的任何角色字段
      role: 'member',
      joinedAt: Date.now(),
      status: 'active',
      inviteCodeUsed: req.inviteCode,
      approvedBy: operatorUid,
    };
    members.push(member);
    writeJSON(K.members, members);
    return { ok: true, message: '已通过，' + req.nickname + ' 已成为员工', member: member };
  }

  return { ok: true, message: '已驳回' };
}

/** 开关"加入需要审批" */
function setRequireApproval(on) {
  const c = getCompany();
  if (!c) return null;
  c.requireApproval = !!on;
  return setCompany(c);
}

function joinByInvite(rawCode, uid, nickname) {`;

if (!s.includes('function applyToJoin')) {
  s = s.replace(anchor, insert);
}

// 4) joinByInvite 尊重 requireApproval：需要审批时拒绝直接加入，改为提示走申请
s = s.replace(
    `  const members = getMembers();
    const exist = members.find((m) => m.uid === uid);
    if (exist) {
      return { ok: false, code: 'ALREADY_IN', message: '你已经在这家公司里了', member: exist };
    }`,
    `  const members = getMembers();
    const exist = members.find((m) => m.uid === uid);
    if (exist) {
      return { ok: false, code: 'ALREADY_IN', message: '你已经在这家公司里了', member: exist };
    }

    // 需要审批时，不允许绕过审批直接加入（防止调用方跳过流程）
    if (company.requireApproval) {
      return {
        ok: false,
        code: 'NEED_APPROVAL',
        message: '这家公司需要管理员审批，请用"申请加入"',
      };
    }`
);

// 5) 导出
s = s.replace(
  "module.exports = {\n  K,\n  getCompany,",
  "module.exports = {\n  K,\n  applyToJoin,\n  myJoinStatus,\n  listPendingJoins,\n  reviewJoin,\n  setRequireApproval,\n  getCompany,"
);

fs.writeFileSync(f, s);
console.log('applyToJoin:', s.includes('function applyToJoin'));
console.log('NEED_APPROVAL:', s.includes('NEED_APPROVAL'));
console.log('exports:', s.includes('applyToJoin,\n  myJoinStatus'));
