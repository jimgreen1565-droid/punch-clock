/**
 * 公司与成员（本地存储层，云端同构）
 *
 * 数据结构：
 *   PC_COMPANY  { id, name, ownerUid, inviteCode, createdAt, settings }
 *   PC_MEMBERS  [{ uid, nickname, role, joinedAt, status, inviteCodeUsed }]
 *
 * 单人使用时的行为：第一次打开自动建一家"我的公司"，自己就是 owner。
 * 这样"一个人用"和"一个团队用"是同一套代码，不需要分叉。
 */
const P = require('../core/permissions');
const rules = require('../core/rules');

const K = {
  company: 'PC_COMPANY',
  members: 'PC_MEMBERS',
};

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

/* ------------------------------ 公司 ------------------------------ */

function getCompany() {
  return readJSON(K.company, null);
}

function setCompany(c) {
  writeJSON(K.company, c);
  return c;
}

/** 首次使用：自动创建公司，自己成为创建者 */
function ensureCompany(uid, nickname) {
  const cur = getCompany();
  if (cur && cur.id) return cur;

  const now = Date.now();
  const company = {
    id: P.makeCompanyId(uid, now),
    name: '我的公司',
    ownerUid: uid,
    inviteCode: P.makeInviteCode(String(uid) + '|' + now),
    createdAt: now,
    // 规则存在公司上，成员共享；个人不能改（见 permissions）
    ruleSet: rules.defaultRuleSet(),
  };
  setCompany(company);

  const members = getMembers();
  if (!members.some((m) => m.uid === uid)) {
    members.push({
      uid,
      nickname: nickname || '我',
      role: 'owner',
      joinedAt: now,
      status: 'active',
    });
    writeJSON(K.members, members);
  }
  return company;
}

function renameCompany(name) {
  const c = getCompany();
  if (!c) return null;
  c.name = String(name || '').slice(0, 24) || '未命名公司';
  return setCompany(c);
}

/** 刷新邀请码（旧码立即失效） */
function refreshInviteCode() {
  const c = getCompany();
  if (!c) return null;
  c.inviteCode = P.makeInviteCode(String(c.id) + '|' + Date.now());
  c.inviteCodeUpdatedAt = Date.now();
  return setCompany(c);
}

/**
 * 用邀请码加入公司。
 * @returns {{ok, code, message, member}}
 */
function joinByInvite(rawCode, uid, nickname) {
  const code = P.normalizeInviteCode(rawCode);
  if (!code) return { ok: false, code: 'BAD_FORMAT', message: '邀请码是 6 位字母数字，请检查后重试' };

  const company = getCompany();
  if (!company) return { ok: false, code: 'NO_COMPANY', message: '本机还没有公司，请先创建' };
  if (company.inviteCode !== code) {
    return { ok: false, code: 'WRONG_CODE', message: '邀请码不正确，请向管理员确认' };
  }

  const members = getMembers();
  const exist = members.find((m) => m.uid === uid);
  if (exist) {
    return { ok: false, code: 'ALREADY_IN', message: '你已经在这家公司里了', member: exist };
  }

  const member = {
    uid,
    nickname: String(nickname || '新成员').slice(0, 16),
    role: 'member',
    joinedAt: Date.now(),
    status: 'active',
    inviteCodeUsed: code,
  };
  members.push(member);
  writeJSON(K.members, members);
  return { ok: true, code: 'OK', message: '已加入', member };
}

/* ------------------------------ 成员 ------------------------------ */

function getMembers() {
  const list = readJSON(K.members, []);
  return Array.isArray(list) ? list : [];
}

function getMember(uid) {
  return getMembers().find((m) => m.uid === uid) || null;
}

/** 当前用户的角色；不在公司里返回 null */
function roleOf(uid) {
  const m = getMember(uid);
  return m && m.status === 'active' ? m.role : null;
}

/** 当前用户能否做某事（统一入口，页面只调这个） */
function canDo(uid, action) {
  const role = roleOf(uid);
  if (!role) return false;
  return P.can(role, action);
}

function addMember(nickname, role) {
  const members = getMembers();
  const m = {
    uid: 'U' + P.makeInviteCode(String(Date.now()) + nickname).toLowerCase().slice(0, 10),
    nickname: String(nickname || '新成员').slice(0, 16),
    role: role || 'member',
    joinedAt: Date.now(),
    status: 'active',
    inviteCodeUsed: 'MANUAL',
  };
  members.push(m);
  writeJSON(K.members, members);
  return m;
}

/** 改角色。不能改 owner；不能把自己降级到没有管理员 */
function setMemberRole(targetUid, newRole, operatorUid) {
  if (!P.can(roleOf(operatorUid), 'member.setRole')) {
    return { ok: false, message: '你没有改角色的权限' };
  }
  const company = getCompany();
  const members = getMembers();
  const target = members.find((m) => m.uid === targetUid);
  if (!target) return { ok: false, message: '成员不存在' };
  if (target.role === 'owner') return { ok: false, message: '创建者的角色不能修改，只能转让' };

  // 不允许把最后一个管理员降级（否则没人能改规则了）
  if (P.isAdminRole(target.role) && !P.isAdminRole(newRole)) {
    const admins = members.filter((m) => m.status === 'active' && P.isAdminRole(m.role) && m.uid !== targetUid);
    if (!admins.length) return { ok: false, message: '至少要保留一个管理员' };
  }

  target.role = newRole;
  writeJSON(K.members, members);
  return { ok: true, message: '已改为' + P.roleName(newRole), member: target };
}

function removeMember(targetUid, operatorUid) {
  if (!P.can(roleOf(operatorUid), 'member.remove')) return { ok: false, message: '你没有移除成员的权限' };
  const target = getMember(targetUid);
  if (!target) return { ok: false, message: '成员不存在' };
  if (target.role === 'owner') return { ok: false, message: '不能移除创建者' };
  const members = getMembers().filter((m) => m.uid !== targetUid);
  writeJSON(K.members, members);
  return { ok: true, message: '已移除' };
}

/** 转让创建者（只有 owner 能做） */
function transferOwnership(newOwnerUid, operatorUid) {
  const company = getCompany();
  if (!company) return { ok: false, message: '公司不存在' };
  if (company.ownerUid !== operatorUid) return { ok: false, message: '只有创建者可以转让' };
  const target = getMember(newOwnerUid);
  if (!target) return { ok: false, message: '目标成员不存在' };

  const members = getMembers();
  members.forEach((m) => {
    if (m.uid === operatorUid) m.role = 'admin';
    if (m.uid === newOwnerUid) m.role = 'owner';
  });
  company.ownerUid = newOwnerUid;
  writeJSON(K.members, members);
  setCompany(company);
  return { ok: true, message: '已转让' };
}

module.exports = {
  K,
  getCompany,
  setCompany,
  ensureCompany,
  renameCompany,
  refreshInviteCode,
  joinByInvite,
  getMembers,
  getMember,
  roleOf,
  canDo,
  addMember,
  setMemberRole,
  removeMember,
  transferOwnership,
};
