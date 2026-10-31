/**
 * 加入审批流 · 真实浏览器验证
 *
 * 覆盖：
 *   1. 管理员提交一条申请 → 成员数不变，只出现待审批
 *   2. 审批通过 → 角色固定 member，员工看不到待审批、改不了规则
 *   3. 驳回 → 成员数不变，且有冷却
 *   4. 关闭审批开关 → 凭邀请码直接加入
 */
import { chromium } from 'playwright-core';

const URL = 'file:///D:/ZW/Documents/deepseek-harness/default-workspace/punch-clock/webapp/index.html';
const OUT = 'D:/ZW/Documents/deepseek-harness/default-workspace/punch-clock/docs';

const b = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await p.goto(URL);
await p.evaluate(() => localStorage.clear());
await p.goto(URL);
await p.waitForTimeout(800);

let fails = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) fails++;
  console.log(`   ${ok ? '✔' : '✖'} ${label}: ${actual}${ok ? '' : '（应为 ' + expected + '）'}`);
}

/* ---------- 1. 管理员提交加入申请 ---------- */
const s1 = await p.evaluate(() => {
  const C = window.PC_COMPANY;
  const code = C.getCompany().inviteCode;
  const before = C.getMembers().length;
  const r = C.applyToJoin(code, '张三', '我是新同事');
  return {
    code,
    before,
    join: { ok: r.ok, msg: r.message, id: r.request ? r.request.id : null },
    after: C.getMembers().length,
    pending: C.listPendingJoins(C.currentUid()).length,
    requireApproval: C.getRequireApproval(),
  };
});
console.log('① 提交加入申请');
check('申请受理', s1.join.ok, true);
check('申请后成员数不变', s1.after, s1.before);
check('待审批条数', s1.pending, 1);
check('默认需要审批', s1.requireApproval, true);

/* ---------- 2. 管理团队页应出现待审批卡片 ---------- */
await p.evaluate(() => window.__pc.go('team'));
await p.waitForTimeout(500);
const s2 = await p.evaluate(() => ({
  approveBtns: document.querySelectorAll('[data-approve-join]').length,
  rejectBtns: document.querySelectorAll('[data-reject-join]').length,
  pendingCards: document.querySelectorAll('.join-reason').length,
  hasToggle: !!document.getElementById('approvalToggle'),
  toggleChecked: document.getElementById('approvalToggle') ? document.getElementById('approvalToggle').checked : null,
}));
console.log('\n② 管理团队页');
check('通过按钮', s2.approveBtns, 1);
check('驳回按钮', s2.rejectBtns, 1);
check('申请理由显示', s2.pendingCards, 1);
check('审批开关存在', s2.hasToggle, true);
check('开关为开', s2.toggleChecked, true);
await p.screenshot({ path: OUT + '/approval-admin-pending.png' });

/* ---------- 3. 审批通过 ---------- */
const s3 = await p.evaluate(() => {
  const C = window.PC_COMPANY;
  const id = document.querySelector('[data-approve-join]').getAttribute('data-approve-join');
  const r = C.reviewJoin(id, true, C.currentUid());
  const m = C.getMembers();
  return {
    ok: r.ok, msg: r.message,
    members: m.map((x) => x.nickname + ':' + x.role),
    empUid: m[1].uid,
    empCanEdit: C.canDo('rule.edit', m[1].uid),
    empCanPunch: C.canDo('punch.self', m[1].uid),
    pending: C.listPendingJoins(C.currentUid()).length,
  };
});
console.log('\n③ 审批通过');
check('审批成功', s3.ok, true);
check('成员含新员工', s3.members.length, 2);
check('新员工角色为 member', s3.members[1].split(':')[1], 'member');
check('员工不能改规则', s3.empCanEdit, false);
check('员工可以打卡', s3.empCanPunch, true);
check('待审批清空', s3.pending, 0);

/* ---------- 4. 员工视角：看不到待审批、改不了规则 ---------- */
await p.evaluate((uid) => window.PC_COMPANY.switchTo(uid), s3.empUid);
await p.waitForTimeout(300);
await p.evaluate(() => window.__pc.go('team'));
await p.waitForTimeout(500);
const s4 = await p.evaluate(() => ({
  approveBtns: document.querySelectorAll('[data-approve-join]').length,
  inviteVisible: !!document.getElementById('inviteCode'),
  canEdit: window.PC_COMPANY.canDo('rule.edit'),
}));
console.log('\n④ 员工打开团队页');
check('看不到审批按钮', s4.approveBtns, 0);
check('看不到邀请码', s4.inviteVisible, false);
check('改不了规则', s4.canEdit, false);
await p.screenshot({ path: OUT + '/approval-employee-team.png' });

await p.evaluate(() => window.__pc.go('rules'));
await p.waitForTimeout(500);
const s4b = await p.evaluate(() => ({
  readonlyNote: document.querySelector('.readonly-note') ? document.querySelector('.readonly-note').textContent.trim() : null,
  clickable: document.querySelectorAll('.row.tappable').length,
}));
console.log('\n⑤ 员工打开规则页');
check('有只读提示', s4b.readonlyNote !== null, true);
check('可编辑行数', s4b.clickable, 0);
await p.screenshot({ path: OUT + '/approval-employee-rules.png' });

/* ---------- 5. 切回管理员，驳回另一条 ---------- */
await p.evaluate(() => {
  const C = window.PC_COMPANY;
  const owner = C.getAccounts().filter((a) => C.memberOf(a.uid).role === 'owner')[0];
  C.switchTo(owner.uid);
});
await p.waitForTimeout(300);
const s5 = await p.evaluate(() => {
  const C = window.PC_COMPANY;
  const code = C.getCompany().inviteCode;
  const r = C.applyToJoin(code, '李四', '想加入');
  const before = C.getMembers().length;
  const rv = C.reviewJoin(r.request.id, false, C.currentUid(), '暂时不需要');
  const after = C.getMembers().length;
  // 冷却：立刻再申请
  const retry = C.applyToJoin(code, '李四', '再来一次');
  return {
    reviewOk: rv.ok,
    before, after,
    retryOk: retry.ok,
    retryCode: retry.code,
  };
});
console.log('\n⑥ 驳回与冷却');
check('驳回成功', s5.reviewOk, true);
check('驳回后成员数不变', s5.after, s5.before);
check('冷却拦截重复申请', s5.retryOk, false);
check('冷却错误码', s5.retryCode, 'COOLING');

/* ---------- 6. 关闭审批开关 → 凭码直接加入 ---------- */
await p.evaluate(() => window.__pc.go('team'));
await p.waitForTimeout(500);
await p.evaluate(() => {
  const t = document.getElementById('approvalToggle');
  t.checked = false;
  t.dispatchEvent(new Event('change', { bubbles: true }));
});
await p.waitForTimeout(400);
const s6 = await p.evaluate(() => {
  const C = window.PC_COMPANY;
  const before = C.getMembers().length;
  const r = C.joinByInvite(C.getCompany().inviteCode, '王五');
  const m = C.getMembers();
  return {
    requireApproval: C.getRequireApproval(),
    joinOk: r.ok,
    before, after: C.getMembers().length,
    newRole: m[m.length - 1].role,
    canEdit: C.canDo('rule.edit', m[m.length - 1].uid),
  };
});
console.log('\n⑦ 关闭审批后');
check('开关已关', s6.requireApproval, false);
check('凭码直接加入', s6.joinOk, true);
check('成员数 +1', s6.after, s6.before + 1);
check('新成员仍是 member', s6.newRole, 'member');
check('新成员不能改规则', s6.canEdit, false);
await p.screenshot({ path: OUT + '/approval-no-approval.png' });

console.log('\n页面错误:', errs.length ? errs : '无');
if (errs.length) fails++;
console.log(fails ? `\n✖ 有 ${fails} 项未通过` : '\n✔ 审批流全部通过');
await b.close();
process.exit(fails ? 1 : 0);
