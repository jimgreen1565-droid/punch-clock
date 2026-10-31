/**
 * 公司与权限模型（纯函数，无 wx / 无 Node 依赖）
 *
 * 需求：一个人是管理员，其他人加入这家公司；普通用户只能打卡和查看自己的东西，
 *       不能改动考勤规则。
 *
 * 设计原则：
 *   1. **权限判断只有这一处实现**。页面、云函数、网页版全部调这里的 can()，
 *      不允许任何地方自己写 if (role === 'admin')。
 *   2. **前端权限只负责"不给入口"**，真正拦截在云函数（详见 cloudfunctions/company）。
 *      前端能改只是体验问题，云函数能改才是安全问题。
 *   3. 角色分四档而不是两档，因为"管理员"和"能审批的人"在真实团队里不是同一批人。
 */

const ROLES = [
  { id: 'owner', name: '创建者', desc: '公司的创建人，唯一可转让与解散的人' },
  { id: 'admin', name: '管理员', desc: '可改规则、管成员、看全员数据' },
  { id: 'manager', name: '主管', desc: '可审批补卡、看本组数据，不能改规则' },
  { id: 'member', name: '员工', desc: '只能打卡、申请补卡、看自己的记录' },
];

const ROLE_LEVEL = { owner: 4, admin: 3, manager: 2, member: 1 };

/** 权限清单：每个动作允许哪些角色 */
const ACTIONS = {
  // ---- 考勤规则（核心：只有 owner/admin 能动）----
  'rule.view': ['owner', 'admin', 'manager', 'member'],
  'rule.edit': ['owner', 'admin'],
  'rule.switchType': ['owner', 'admin'],
  'rule.editGeo': ['owner', 'admin'],
  'rule.editPatch': ['owner', 'admin'],
  'rule.editTemplate': ['owner', 'admin'],

  // ---- 打卡（所有人都能）----
  'punch.self': ['owner', 'admin', 'manager', 'member'],
  'punch.outside': ['owner', 'admin', 'manager', 'member'],

  // ---- 记录 ----
  'record.viewSelf': ['owner', 'admin', 'manager', 'member'],
  'record.viewAll': ['owner', 'admin', 'manager'],
  'record.export': ['owner', 'admin', 'manager', 'member'],
  'record.delete': ['owner', 'admin'],

  // ---- 补卡 ----
  'patch.apply': ['owner', 'admin', 'manager', 'member'],
  'patch.approve': ['owner', 'admin', 'manager'],

  // ---- 成员与公司 ----
  'member.view': ['owner', 'admin', 'manager'],
  'member.invite': ['owner', 'admin'],
  'member.remove': ['owner', 'admin'],
  'member.setRole': ['owner', 'admin'],
  'company.rename': ['owner', 'admin'],
  'company.dissolve': ['owner'],
  'company.transfer': ['owner'],

  // ---- 本机数据 ----
  'local.reset': ['owner', 'admin'],
};

/**
 * 判断某角色能否执行某动作。
 * @param {string} role
 * @param {string} action  形如 'rule.edit'
 * @returns {boolean}
 */
function can(role, action) {
  const allowed = ACTIONS[action];
  if (!allowed) return false; // 未声明的动作一律拒绝（fail-closed）
  return allowed.indexOf(role) >= 0;
}

/** 至少达到某等级（用于"主管及以上"这类判断） */
function atLeast(role, minRole) {
  return (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[minRole] || 99);
}

/** 角色中文名 */
function roleName(role) {
  const r = ROLES.find((x) => x.id === role);
  return r ? r.name : '未知';
}

/** 是否管理岗（能改规则的） */
function isAdminRole(role) {
  return atLeast(role, 'admin');
}

/** 是否审批岗（能批补卡的） */
function isManagerRole(role) {
  return atLeast(role, 'manager');
}

/* ------------------------------ 邀请码 ------------------------------ */

/**
 * 生成邀请码。用易读字符集避免「0/O、1/I/l」混淆（员工要在手机上手动输）。
 * 6 位，约 30^6 ≈ 7.3 亿组合，对一个公司足够。
 */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeInviteCode(seed) {
  const src = String(seed === undefined ? Date.now() : seed);
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += CODE_CHARS[h % CODE_CHARS.length];
    h = Math.floor(h / CODE_CHARS.length) + ((i + 7) * 2654435761 >>> 0);
    h = h >>> 0;
  }
  return out;
}

/** 校验邀请码格式（忽略大小写与空格，方便手输） */
function normalizeInviteCode(input) {
  const v = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return v.length === 6 ? v : null;
}

/** 公司 id：由创建者 uid + 时间生成，稳定且不易撞 */
function makeCompanyId(uid, atMs) {
  const s = String(uid) + '|' + String(atMs === undefined ? Date.now() : atMs);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return 'CO' + h.toString(36).toUpperCase().slice(0, 8);
}

module.exports = {
  ROLES,
  ROLE_LEVEL,
  ACTIONS,
  can,
  atLeast,
  roleName,
  isAdminRole,
  isManagerRole,
  CODE_CHARS,
  makeInviteCode,
  normalizeInviteCode,
  makeCompanyId,
};
