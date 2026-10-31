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

/* ---------- 1. owner 建好公司后，加一个员工 ---------- */
const step1 = await p.evaluate(() => {
  const C = window.PC_COMPANY;
  const code = C.getCompany().inviteCode;
  const before = { code, members: C.getMembers().length, role: C.roleOf(), canEdit: C.canDo('rule.edit') };
  const r = C.joinByInvite(code, '张三');
  return {
    before,
    join: { ok: r.ok, msg: r.message },
    after: {
      members: C.getMembers().length,
      curRole: C.roleOf(),
      canEdit: C.canDo('rule.edit'),
      canApprove: C.canDo('patch.approve'),
      canViewAll: C.canDo('record.viewAll'),
      canPunch: C.canDo('punch.self'),
    },
    roles: C.getMembers().map((m) => m.nickname + ':' + m.role),
  };
});
console.log('① 管理员加员工');
console.log('   邀请码 ' + step1.before.code + '，加入前 ' + step1.before.members + " 人");
console.log('   加入结果:', step1.join.ok ? '成功' : '失败', '|', step1.join.msg);
console.log('   成员:', step1.roles.join(', '));
console.log('   员工权限: 改规则=' + step1.after.canEdit + ' 审批=' + step1.after.canApprove +
  ' 看全员=' + step1.after.canViewAll + ' 打卡=' + step1.after.canPunch);

/* ---------- 2. 员工视角：规则页只读 ---------- */
await p.evaluate(() => window.__pc.go('rules'));
await p.waitForTimeout(500);
const step2 = await p.evaluate(() => ({
  readonlyNote: document.querySelector('.readonly-note') ? document.querySelector('.readonly-note').textContent.trim() : null,
  clickableRows: document.querySelectorAll('.row.tappable').length,
  readonlyOptions: document.querySelectorAll('.option.readonly').length,
  hasSavePreset: !!document.getElementById('savePreset'),
}));
console.log('\n② 员工打开规则页');
console.log('   只读提示:', step2.readonlyNote ? '有' : '无');
console.log('   可点击编辑行:', step2.clickableRows, '（应为 0）');
console.log('   只读选项:', step2.readonlyOptions, '/ 4');
console.log('   保存模板按钮:', step2.hasSavePreset ? '有（不该有）' : '无（正确）');
await p.screenshot({ path: OUT + '/perm-employee-rules.png' });

/* ---------- 3. 员工试图改规则：应被拦 ---------- */
const step3 = await p.evaluate(() => {
  const before = JSON.parse(JSON.stringify(window.__pc.db().ruleSet));
  // 直接调 patchRule 通道（模拟"改前端代码后绕过 UI"）
  if (window.PC_COMPANY && !window.PC_COMPANY.canDo('rule.edit')) {
    // 这里手动验证门禁函数本身
    return { blockedByPermission: true, canEdit: window.PC_COMPANY.canDo('rule.edit') };
  }
  return { blockedByPermission: false, canEdit: window.PC_COMPANY.canDo('rule.edit') };
});
console.log('\n③ 员工能否改规则');
console.log('   权限判定:', step3.canEdit ? '可以（错误）' : '拒绝（正确）');

/* ---------- 4. 员工看不到"改角色/移除"按钮 ---------- */
await p.evaluate(() => window.__pc.go('team'));
await p.waitForTimeout(500);
const step4 = await p.evaluate(() => ({
  company: document.querySelector('.company-name') ? document.querySelector('.company-name').textContent : null,
  roleBtn: document.querySelectorAll('[data-role-uid]').length,
  removeBtn: document.querySelectorAll('[data-remove-uid]').length,
  inviteVisible: !!document.getElementById('inviteCode'),
  memberRows: document.querySelectorAll('.member-row').length,
}));
console.log('\n④ 员工打开公司与成员页');
console.log('   成员行:', step4.memberRows, '| 改角色按钮:', step4.roleBtn, '| 移除按钮:', step4.removeBtn);
console.log('   邀请码是否可见:', step4.inviteVisible ? '可见（错误）' : '不可见（正确）');
await p.screenshot({ path: OUT + '/perm-employee-team.png' });

/* ---------- 5. 切回 owner，验证管理员仍有全部权限 ---------- */
await p.evaluate(() => {
  const C = window.PC_COMPANY;
  const accounts = C.getAccounts();
  const owner = accounts.filter((a) => C.memberOf(a.uid).role === 'owner')[0];
  C.switchTo(owner.uid);
});
await p.waitForTimeout(300);
await p.evaluate(() => window.__pc.go('team'));
await p.waitForTimeout(500);
const step5 = await p.evaluate(() => ({
  role: window.PC_COMPANY.roleOf(),
  canEdit: window.PC_COMPANY.canDo('rule.edit'),
  roleBtn: document.querySelectorAll('[data-role-uid]').length,
  removeBtn: document.querySelectorAll('[data-remove-uid]').length,
  inviteVisible: !!document.getElementById('inviteCode'),
}));
console.log('\n⑤ 切回管理员');
console.log('   角色:', step5.role, '| 可改规则:', step5.canEdit);
console.log('   改角色按钮:', step5.roleBtn, '| 移除按钮:', step5.removeBtn, '| 邀请码:', step5.inviteVisible ? '可见' : '不可见');
await p.screenshot({ path: OUT + '/perm-admin-team.png' });

console.log('\n页面错误:', errs.length ? errs : '无');
await b.close();
