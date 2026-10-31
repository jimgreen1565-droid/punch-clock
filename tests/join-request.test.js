/**
 * 加入审批流测试
 *
 * 需求 ②：管理员审批后才进公司。关键约束：
 *   · 提交申请**不授予任何权限**
 *   · 角色审批时**固定 member**（不接受申请里的 role）
 *   · 同一人只能有一条 pending
 *   · 被驳回要冷却，防骚扰
 *   · 审批人必须有权限（纵深防御）
 */
const test = require('node:test');
const assert = require('node:assert');

const storage = {};
global.wx = {
  getStorageSync: (k) => (storage[k] === undefined ? '' : storage[k]),
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
};

const company = require('../miniprogram/utils/company');
const joinRequest = require('../miniprogram/utils/joinRequest');
const P = require('../miniprogram/core/permissions');

function reset() {
  Object.keys(storage).forEach((k) => delete storage[k]);
}

function setup() {
  reset();
  const c = company.ensureCompany('Uowner', '管理员');
  return c;
}

test('新公司默认需要审批', () => {
  const c = setup();
  assert.equal(c.requireApproval, true, '真实团队应默认开审批');
});

test('★ 需要审批时，joinByInvite 直接加入被拒', () => {
  const c = setup();
  const r = company.joinByInvite(c.inviteCode, 'Uemp', '张三');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NEED_APPROVAL');
  // 关键：不能留下成员记录
  assert.equal(company.getMembers().length, 1, '被拒时不应新增成员');
});

test('★ 提交申请不授予任何权限', () => {
  const c = setup();
  const r = company.applyToJoin(c.inviteCode, 'Uemp', '张三', '想加入');
  assert.equal(r.ok, true);
  // 申请人仍不是成员
  assert.equal(company.roleOf('Uemp'), null, '申请阶段不应有任何角色');
  assert.equal(company.canDo('Uemp', 'punch.self'), false, '申请阶段不能打卡');
  assert.equal(company.getMembers().length, 1, '申请不写入成员表');
});

test('错误邀请码不能提交申请', () => {
  setup();
  const r = company.applyToJoin('ZZZZZZ', 'Uemp', '张三', 'x');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_CODE');
});

test('邀请码格式错误不能提交', () => {
  setup();
  const r = company.applyToJoin('abc', 'Uemp', '张三', 'x');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_FORMAT');
});

test('同一人不能重复提交 pending 申请', () => {
  const c = setup();
  const a = company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'x');
  assert.equal(a.ok, true);
  const b = company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'y');
  assert.equal(b.ok, false);
  assert.equal(b.code, 'ALREADY_PENDING');
  assert.equal(joinRequest.pendingList(c.id).length, 1, '不应产生两条 pending');
});

test('管理员能看到待审批列表，员工看不到', () => {
  const c = setup();
  company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'x');
  assert.equal(company.listPendingJoins('Uowner').length, 1);
  // 员工（非管理员）没有 member.invite 权限
  assert.equal(company.listPendingJoins('Uemp').length, 0, '非管理员不应看到待审批');
});

test('★ 审批通过：角色固定 member（不接受申请里的 role）', () => {
  const c = setup();
  const ap = company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'x');
  // 模拟申请里塞了 role 字段（恶意）
  const reqs = joinRequest.getRequests();
  reqs[reqs.length - 1].role = 'admin';

  const res = company.reviewJoin(ap.request.id, true, 'Uowner');
  assert.equal(res.ok, true);
  assert.equal(company.roleOf('Uemp'), 'member', '必须是 member，不能是 admin');
  assert.equal(company.canDo('Uemp', 'rule.edit'), false, '新成员不能改规则');
});

test('审批通过后能打卡', () => {
  const c = setup();
  const ap = company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'x');
  company.reviewJoin(ap.request.id, true, 'Uowner');
  assert.equal(company.canDo('Uemp', 'punch.self'), true);
  assert.equal(company.canDo('Uemp', 'patch.apply'), true);
});

test('无权限的人不能审批', () => {
  const c = setup();
  const ap = company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'x');
  // 用 member 角色尝试审批
  const res = company.reviewJoin(ap.request.id, true, 'Uother');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'FORBIDDEN');
});

test('驳回后状态正确、且不新增成员', () => {
  const c = setup();
  const ap = company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'x');
  const res = company.reviewJoin(ap.request.id, false, 'Uowner', '不通过');
  assert.equal(res.ok, true);
  assert.equal(joinRequest.getRequests().find((r) => r.id === ap.request.id).status, 'rejected');
  assert.equal(company.getMembers().length, 1, '驳回不应新增成员');
});

test('已处理的申请不能重复审批', () => {
  const c = setup();
  const ap = company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'x');
  company.reviewJoin(ap.request.id, true, 'Uowner');
  const again = company.reviewJoin(ap.request.id, false, 'Uowner');
  assert.equal(again.ok, false);
  assert.equal(again.code, 'ALREADY_REVIEWED');
});

test('被驳回后冷却期内不能再申请', () => {
  const c = setup();
  const ap = company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'x');
  company.reviewJoin(ap.request.id, false, 'Uowner');
  const retry = company.applyToJoin(c.inviteCode, 'Uemp', '张三', '再试');
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'COOLING');
});

test('申请人可以撤回自己的 pending 申请', () => {
  const c = setup();
  const ap = company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'x');
  const res = joinRequest.cancel(ap.request.id, 'Uemp');
  assert.equal(res.ok, true);
  assert.equal(joinRequest.pendingList(c.id).length, 0);
});

test('不能撤回别人的申请', () => {
  const c = setup();
  const ap = company.applyToJoin(c.inviteCode, 'Uemp', '张三', 'x');
  const res = joinRequest.cancel(ap.request.id, 'Uother');
  assert.equal(res.ok, false);
});

test('关闭审批后可以码即入（老行为）', () => {
  const c = setup();
  company.setRequireApproval(false);
  const r = company.joinByInvite(c.inviteCode, 'Uemp', '张三');
  assert.equal(r.ok, true);
  assert.equal(company.roleOf('Uemp'), 'member');
});

test('★ 关闭审批也不能绕过角色限制（仍是 member）', () => {
  const c = setup();
  company.setRequireApproval(false);
  company.joinByInvite(c.inviteCode, 'Uemp', '张三');
  assert.equal(company.canDo('Uemp', 'rule.edit'), false);
  assert.equal(company.canDo('Uemp', 'member.invite'), false);
});

test('stats 统计各状态', () => {
  const c = setup();
  const a = company.applyToJoin(c.inviteCode, 'U1', '甲', 'x');
  company.reviewJoin(a.request.id, true, 'Uowner');
  const b = company.applyToJoin(c.inviteCode, 'U2', '乙', 'x');
  company.reviewJoin(b.request.id, false, 'Uowner');
  const d = company.applyToJoin(c.inviteCode, 'U3', '丙', 'x');

  const st = joinRequest.stats(c.id);
  assert.equal(st.approved, 1);
  assert.equal(st.rejected, 1);
  assert.equal(st.pending, 1);
  assert.equal(st.total, 3);
});

test('审批链接：成员 + 审批流程互不干扰', () => {
  const c = setup();
  // 加两个人
  const a = company.applyToJoin(c.inviteCode, 'U1', '甲', 'x');
  company.reviewJoin(a.request.id, true, 'Uowner');
  const b = company.applyToJoin(c.inviteCode, 'U2', '乙', 'x');
  company.reviewJoin(b.request.id, true, 'Uowner');

  assert.equal(company.getMembers().filter((m) => m.status === 'active').length, 3); // owner + 2
  // 两个新成员都是 member
  assert.equal(company.roleOf('U1'), 'member');
  assert.equal(company.roleOf('U2'), 'member');
  // 只有 owner 能改规则
  assert.equal(company.canDo('U1', 'rule.edit'), false);
  assert.equal(company.canDo('Uowner', 'rule.edit'), true);
});
