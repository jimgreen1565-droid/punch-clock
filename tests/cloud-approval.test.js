/**
 * 云函数审批流的**静态审查**测试。
 *
 * 目的：云函数代码无法在本地跑（需要微信云环境），但它的安全不变量
 * 必须能被验证。这里用源码审查的方式断言关键约束存在：
 *   · join 在需要审批时必须拒绝（不能绕过）
 *   · 审批通过时角色必须硬编码 member，不能来自 payload
 *   · 审批必须校验操作者权限
 *   · 申请不产生成员记录
 *   · 驳回冷却必须存在
 *   · 不能审批别的公司的申请
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'cloudfunctions', 'company', 'index.js'),
  'utf8'
);

function block(action) {
  const start = SRC.indexOf("action === '" + action + "'");
  assert.ok(start >= 0, 'cloud function must handle action ' + action);
  // 取该 action 块：从它开始到下一个 "if (action ===" 之前
  const next = SRC.indexOf("if (action === '", start + 10);
  return SRC.slice(start, next > 0 ? next : SRC.length);
}

test('云函数支持审批相关的 6 个 action', () => {
  ['join', 'applyJoin', 'pendingList', 'myJoin', 'reviewJoin', 'cancelJoin', 'setApproval'].forEach(
    (a) => {
      assert.ok(SRC.includes("action === '" + a + "'"), '缺少 action: ' + a);
    }
  );
});

test('★ join 在公司需要审批时必须拒绝', () => {
  const b = block('join');
  assert.ok(b.includes('NEED_APPROVAL'), 'join 必须识别 NEED_APPROVAL');
  assert.ok(
    /requireApproval\s*!==\s*false[\s\S]*NEED_APPROVAL/.test(b),
    'join 必须在 requireApproval 为真时返回 NEED_APPROVAL'
  );
});

test('★ join 的角色必须硬编码为 member', () => {
  const b = block('join');
  assert.ok(/role:\s*'member'/.test(b), 'join 必须写死 role: member');
  assert.ok(
    !/role:\s*payload\./.test(b),
    'join 绝不能使用 payload 里的 role'
  );
});

test('★ 审批通过时角色必须硬编码 member', () => {
  const b = block('reviewJoin');
  assert.ok(/role:\s*'member'/.test(b), 'reviewJoin 必须写死 role: member');
  assert.ok(
    !/role:\s*(payload|req)\.(role)/.test(b),
    'reviewJoin 绝不能采用申请里的 role'
  );
});

test('★ 审批必须走 requireAction 权限门禁', () => {
  const b = block('reviewJoin');
  assert.ok(
    b.includes("requireAction(OPENID, 'member.invite')"),
    'reviewJoin 必须校验 member.invite 权限'
  );
});

test('★ 不能审批其他公司的申请', () => {
  const b = block('reviewJoin');
  assert.ok(
    b.includes('req.companyId !== me.companyId'),
    'reviewJoin 必须校验 companyId 归属'
  );
});

test('★ 申请阶段不写成员表', () => {
  const b = block('applyJoin');
  assert.ok(
    !/COL_MEMBER\)\.add/.test(b),
    'applyJoin 绝不能往 pc_members 插入记录'
  );
  assert.ok(/COL_JOIN\)\.add/.test(b), 'applyJoin 应写入 pc_join_requests');
});

test('★ 同一人不能重复提交 pending 申请', () => {
  const b = block('applyJoin');
  assert.ok(b.includes('ALREADY_PENDING'), 'applyJoin 必须拒绝重复申请');
  assert.ok(
    /status:\s*'pending'/.test(b),
    'applyJoin 必须按 pending 查询重复'
  );
});

test('★ 驳回冷却必须存在且有明确时长', () => {
  assert.ok(SRC.includes('RECHECK_COOLDOWN'), '必须定义 RECHECK_COOLDOWN');
  const b = block('applyJoin');
  assert.ok(b.includes('COOLING'), 'applyJoin 必须实现冷却拦截');
  const m = SRC.match(/const RECHECK_COOLDOWN = (\d+) \* 60 \* 1000/);
  assert.ok(m, '冷却时间必须以分钟为单位显式定义');
  assert.ok(Number(m[1]) > 0, '冷却时间必须大于 0');
});

test('★ 撤回只能撤自己的申请', () => {
  const b = block('cancelJoin');
  assert.ok(b.includes('req.openid !== OPENID'), 'cancelJoin 必须校验申请人身份');
});

test('★ 开关审批必须校验权限并留痕', () => {
  const b = block('setApproval');
  assert.ok(
    b.includes("requireAction(OPENID, 'member.invite')"),
    'setApproval 必须校验权限'
  );
  assert.ok(b.includes('pc_audit'), 'setApproval 必须写审计');
});

test('★ pendingList 只有能邀请的角色能读', () => {
  const b = block('pendingList');
  assert.ok(
    b.includes("requireAction(OPENID, 'member.invite')"),
    'pendingList 必须校验权限'
  );
});

test('★ 审批通过必须同步用户档案的 companyId/role', () => {
  const b = block('reviewJoin');
  assert.ok(
    /COL_USER\)\.where\(\{\s*openid:\s*req\.openid\s*\}\)\.update/.test(b),
    'reviewJoin 必须更新 pc_users 的 companyId 与 role'
  );
  assert.ok(/role:\s*'member'/.test(b), 'pc_users.role 必须是 member');
});

test('★ 审批动作必须写审计', () => {
  const b = block('reviewJoin');
  assert.ok(b.includes('pc_audit'), 'reviewJoin 必须写审计');
  assert.ok(b.includes('company.approveJoin'), '审批通过要有独立审计 kind');
  assert.ok(b.includes('company.rejectJoin'), '驳回要有独立审计 kind');
});
