/**
 * 权限系统测试
 *
 * 这一层的价值在于：**任何"员工能改规则"的回归都必须被测试拦住**。
 * 权限是安全边界，不能靠人工点一遍页面来验证。
 */
const test = require('node:test');
const assert = require('node:assert');

const P = require('../miniprogram/core/permissions');

const ALL = ['owner', 'admin', 'manager', 'member'];

/* ------------------------------ 角色层级 ------------------------------ */

test('四个角色、等级单调递增', () => {
  assert.equal(P.ROLES.length, 4);
  assert.deepEqual(P.ROLES.map((r) => r.id), ['owner', 'admin', 'manager', 'member']);
  assert.equal(P.ROLE_LEVEL.owner > P.ROLE_LEVEL.admin, true);
  assert.equal(P.ROLE_LEVEL.admin > P.ROLE_LEVEL.manager, true);
  assert.equal(P.ROLE_LEVEL.manager > P.ROLE_LEVEL.member, true);
});

test('atLeast 正确判断层级', () => {
  assert.equal(P.atLeast('owner', 'admin'), true);
  assert.equal(P.atLeast('admin', 'admin'), true);
  assert.equal(P.atLeast('manager', 'admin'), false);
  assert.equal(P.atLeast('member', 'admin'), false);
  assert.equal(P.atLeast('member', 'member'), true);
  // 未知角色不应通过任何层级要求
  assert.equal(P.atLeast('hacker', 'member'), false);
  assert.equal(P.atLeast(undefined, 'member'), false);
});

/* ------------------------------ 核心：谁能改规则 ------------------------------ */

test('★ 只有 owner/admin 能改考勤规则（这是本需求的核心约束）', () => {
  assert.equal(P.can('owner', 'rule.edit'), true);
  assert.equal(P.can('admin', 'rule.edit'), true);
  assert.equal(P.can('manager', 'rule.edit'), false, '主管不应能改规则');
  assert.equal(P.can('member', 'rule.edit'), false, '员工不应能改规则');
});

test('规则相关动作全部只给 owner/admin', () => {
  ['rule.edit', 'rule.switchType', 'rule.editGeo', 'rule.editPatch', 'rule.editTemplate'].forEach((a) => {
    assert.equal(P.can('manager', a), false, a + ' 不应给 manager');
    assert.equal(P.can('member', a), false, a + ' 不应给 member');
    assert.equal(P.can('admin', a), true, a + ' 应给 admin');
  });
});

test('所有角色都能查看规则（只读不拦）', () => {
  ALL.forEach((r) => assert.equal(P.can(r, 'rule.view'), true, r + ' 应能查看规则'));
});

/* ------------------------------ 打卡与记录 ------------------------------ */

test('所有角色都能打卡', () => {
  ALL.forEach((r) => {
    assert.equal(P.can(r, 'punch.self'), true, r + ' 应能打卡');
    assert.equal(P.can(r, 'punch.outside'), true, r + ' 应能外勤打卡');
  });
});

test('看全员数据只给 manager 及以上', () => {
  assert.equal(P.can('owner', 'record.viewAll'), true);
  assert.equal(P.can('admin', 'record.viewAll'), true);
  assert.equal(P.can('manager', 'record.viewAll'), true);
  assert.equal(P.can('member', 'record.viewAll'), false, '员工只能看自己的');
});

test('删记录只给 owner/admin', () => {
  assert.equal(P.can('manager', 'record.delete'), false);
  assert.equal(P.can('member', 'record.delete'), false);
});

/* ------------------------------ 补卡 ------------------------------ */

test('补卡：谁都能申请，manager 及以上能审批', () => {
  ALL.forEach((r) => assert.equal(P.can(r, 'patch.apply'), true, r + ' 应能申请补卡'));
  assert.equal(P.can('member', 'patch.approve'), false, '员工不能审批自己的补卡');
  assert.equal(P.can('manager', 'patch.approve'), true);
  assert.equal(P.can('admin', 'patch.approve'), true);
});

/* ------------------------------ 成员管理 ------------------------------ */

test('邀请/移除/改角色只给 owner/admin', () => {
  ['member.invite', 'member.remove', 'member.setRole'].forEach((a) => {
    assert.equal(P.can('manager', a), false, a + ' 不应给 manager');
    assert.equal(P.can('member', a), false, a + ' 不应给 member');
    assert.equal(P.can('admin', a), true, a + ' 应给 admin');
  });
});

test('只有 owner 能解散与转让', () => {
  assert.equal(P.can('owner', 'company.dissolve'), true);
  assert.equal(P.can('admin', 'company.dissolve'), false);
  assert.equal(P.can('owner', 'company.transfer'), true);
  assert.equal(P.can('admin', 'company.transfer'), false);
});

/* ------------------------------ fail-closed ------------------------------ */

test('未声明的动作一律拒绝（fail-closed）', () => {
  ['shell.exec', '', null, 'rule.hack', 'admin.*'].forEach((a) => {
    ALL.forEach((r) => assert.equal(P.can(r, a), false, r + ' 不应能执行未声明动作 ' + a));
  });
});

test('未知角色不能做任何事', () => {
  Object.keys(P.ACTIONS).forEach((a) => {
    assert.equal(P.can('hacker', a), false, 'hacker 不应能执行 ' + a);
    assert.equal(P.can(null, a), false);
    assert.equal(P.can(undefined, a), false);
  });
});

/* ------------------------------ 邀请码 ------------------------------ */

test('邀请码 6 位、只用易读字符集（无 0/O/1/I/l）', () => {
  for (let i = 0; i < 200; i++) {
    const code = P.makeInviteCode('seed' + i);
    assert.equal(code.length, 6, '应为 6 位: ' + code);
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/, '字符集不符: ' + code);
  }
});

test('邀请码不同种子几乎不重复', () => {
  const set = new Set();
  for (let i = 0; i < 500; i++) set.add(P.makeInviteCode('s' + i + '|' + i * 7));
  assert.ok(set.size > 480, '500 个种子至少应产生 480 个不同码，实际 ' + set.size);
});

test('normalizeInviteCode 容忍大小写、空格、连字符', () => {
  assert.equal(P.normalizeInviteCode(' ab-cd12 '), 'ABCD12');
  assert.equal(P.normalizeInviteCode('AB CD 12'), 'ABCD12');
  assert.equal(P.normalizeInviteCode('abcd12'), 'ABCD12');
  assert.equal(P.normalizeInviteCode('abc'), null, '长度不对应拒绝');
  assert.equal(P.normalizeInviteCode(''), null);
  assert.equal(P.normalizeInviteCode(null), null);
});

test('公司 id 稳定可复现', () => {
  const a = P.makeCompanyId('Uabc', 1700000000000);
  const b = P.makeCompanyId('Uabc', 1700000000000);
  assert.equal(a, b, '同输入应得同 id');
  assert.notEqual(a, P.makeCompanyId('Uabcd', 1700000000000));
  assert.match(a, /^CO[A-Z0-9]+$/);
});

/* ------------------------------ 端到端语义 ------------------------------ */

test('★ 模拟真实场景：员工加入后什么都改不了，但能打卡', () => {
  // 角色矩阵：员工能做什么、不能做什么
  const memberCan = Object.keys(P.ACTIONS).filter((a) => P.can('member', a));
  const memberCannot = Object.keys(P.ACTIONS).filter((a) => !P.can('member', a));

  // 必须能做
  ['punch.self', 'punch.outside', 'patch.apply', 'rule.view', 'record.viewSelf', 'record.export']
    .forEach((a) => assert.ok(memberCan.includes(a), '员工应能做 ' + a));

  // 一件都不能碰
  ['rule.edit', 'rule.switchType', 'member.invite', 'member.setRole', 'member.remove',
   'patch.approve', 'record.viewAll', 'record.delete', 'company.dissolve', 'company.transfer']
    .forEach((a) => assert.ok(memberCannot.includes(a), '员工不应能做 ' + a));

  assert.ok(memberCannot.length >= 10, '员工被拒绝的动作应足够多，实际 ' + memberCannot.length);
});

test('roleName 覆盖所有角色', () => {
  ALL.forEach((r) => assert.ok(P.roleName(r), r + ' 应有中文名'));
  assert.equal(P.roleName('member'), '员工');
  assert.equal(P.roleName('owner'), '创建者');
  assert.ok(P.roleName('unknown'));
});

test('isAdminRole / isManagerRole', () => {
  assert.equal(P.isAdminRole('owner'), true);
  assert.equal(P.isAdminRole('admin'), true);
  assert.equal(P.isAdminRole('manager'), false);
  assert.equal(P.isManagerRole('manager'), true);
  assert.equal(P.isManagerRole('member'), false);
});
