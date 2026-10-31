/**
 * 云函数：company
 *
 * **这是整个权限体系真正的安全边界。**
 * 前端（网页版 / 小程序）的权限判断只负责"不给入口"——用户可以改前端代码，
 * 也可以用抓包重放。所以：
 *   · 谁能改规则 → 服务端查 pc_users.role
 *   · 谁能批补卡 → 服务端查 pc_users.role
 *   · 谁能看别人的数据 → 服务端按 companyId 过滤
 *   · 打卡记录的归属 → 服务端用 OPENID，不信 payload 里的 uid
 *
 * 所有写操作都先过 requireRole()，任何一处漏判就是越权漏洞。
 */
const cloud = require('wx-server-sdk');
const C = require('./common');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COL_USER = 'pc_users';
const COL_COMPANY = 'pc_companies';
const COL_MEMBER = 'pc_members';

/** 角色等级：与小程序 core/permissions.js 保持一致 */
const LEVEL = { owner: 4, admin: 3, manager: 2, member: 1 };

/** 动作 → 允许的角色（服务端权威清单） */
const ACTIONS = {
  'rule.view': ['owner', 'admin', 'manager', 'member'],
  'rule.edit': ['owner', 'admin'],
  'rule.switchType': ['owner', 'admin'],
  'rule.editGeo': ['owner', 'admin'],
  'rule.editPatch': ['owner', 'admin'],
  'rule.editTemplate': ['owner', 'admin'],

  'punch.self': ['owner', 'admin', 'manager', 'member'],
  'punch.outside': ['owner', 'admin', 'manager', 'member'],

  'record.viewSelf': ['owner', 'admin', 'manager', 'member'],
  'record.viewAll': ['owner', 'admin', 'manager'],
  'record.export': ['owner', 'admin', 'manager', 'member'],
  'record.delete': ['owner', 'admin'],

  'patch.apply': ['owner', 'admin', 'manager', 'member'],
  'patch.approve': ['owner', 'admin', 'manager'],

  'member.view': ['owner', 'admin', 'manager'],
  'member.invite': ['owner', 'admin'],
  'member.remove': ['owner', 'admin'],
  'member.setRole': ['owner', 'admin'],
  'company.rename': ['owner', 'admin'],
  'company.dissolve': ['owner'],
  'company.transfer': ['owner'],

  'local.reset': ['owner', 'admin'],
};

function can(role, action) {
  const allowed = ACTIONS[action];
  if (!allowed) return false; // fail-closed
  return allowed.indexOf(role) >= 0;
}

/**
 * 取当前用户的档案与角色。**唯一可信来源是 openid**，
 * 绝不接受 payload 里传来的 role/companyId（那是用户可以伪造的）。
 */
async function whoAmI(openid) {
  const r = await db.collection(COL_USER).where({ openid }).limit(1).get();
  const u = r.data && r.data[0];
  if (!u) return { ok: false, error: C.fail('NO_USER', '请先登录') };
  if (u.status === 'disabled') return { ok: false, error: C.fail('ACCOUNT_DISABLED', '账号已停用') };
  return { ok: true, user: u, role: u.role || 'member', companyId: u.companyId || 'default' };
}

/** 权限门禁：不通过直接返回 fail */
async function requireAction(openid, action) {
  const me = await whoAmI(openid);
  if (!me.ok) return me;
  if (!can(me.role, action)) {
    return {
      ok: false,
      error: C.fail('FORBIDDEN', '你的角色（' + me.role + '）没有「' + action + '」权限'),
      role: me.role,
    };
  }
  return me;
}

/* ------------------------------ 邀请码 ------------------------------ */

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode(seed) {
  const s = String(seed);
  return 'CO' + C.sha256(s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6).replace(/O/g, 'Q').replace(/I|1/g, '7');
}

function normalizeCode(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 5 && s.length <= 8 ? s : null;
}

/** 生成邀请码（保证 6 位、只用易读字符集） */
function genInviteCode(companyId, ts) {
  let h = '';
  let n = 0;
  while (h.length < 6) {
    const part = C.sha256(companyId + '|' + ts + '|' + n).toUpperCase();
    for (let i = 0; i < part.length && h.length < 6; i++) {
      const ch = part[i];
      if (CODE_CHARS.indexOf(ch) >= 0) h += ch;
    }
    n++;
  }
  return h;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return C.fail('NO_OPENID', '只能在小程序内调用');

  const { action, payload } = C.parseEvent(event);
  const now = Date.now();

  try {
    /* ---------------- 读：我的公司与成员 ---------------- */
    if (action === 'me') {
      const me = await whoAmI(OPENID);
      if (!me.ok) return me.error;

      const [companyR, membersR] = await Promise.all([
        db.collection(COL_COMPANY).where({ id: me.companyId }).limit(1).get(),
        db.collection(COL_MEMBER).where({ companyId: me.companyId }).limit(200).get(),
      ]);
      const company = companyR.data && companyR.data[0];
      const members = (membersR.data || []).map((m) => ({
        uid: m.openid,
        nickname: m.nickname || '',
        role: m.role,
        joinedAt: m.joinedAt,
        status: m.status || 'active',
      }));

      // 只有能邀请的角色才返回完整邀请码；员工看不到
      const canInvite = can(me.role, 'member.invite');

      return C.ok({
        role: me.role,
        companyId: me.companyId,
        company: company
          ? { id: company.id, name: company.name, inviteCode: canInvite ? company.inviteCode : null }
          : null,
        members,
        canEditRule: can(me.role, 'rule.edit'),
        canApprove: can(me.role, 'patch.approve'),
        canInvite,
        canSetRole: can(me.role, 'member.setRole'),
        canRemove: can(me.role, 'member.remove'),
      });
    }

    /* ---------------- 读：公司考勤规则（所有成员可读） ---------------- */
    if (action === 'rule.get') {
      const me = await requireAction(OPENID, 'rule.view');
      if (!me.ok) return me.error;
      const r = await db.collection(COL_COMPANY).where({ id: me.companyId }).limit(1).get();
      const company = r.data && r.data[0];
      return C.ok({
        ruleSet: (company && company.ruleSet) || null,
        canEdit: can(me.role, 'rule.edit'),
        role: me.role,
      });
    }

    /* ---------------- 写：改公司规则（仅 owner/admin） ---------------- */
    if (action === 'rule.set') {
      const me = await requireAction(OPENID, 'rule.edit');
      if (!me.ok) return me.error;

      const rs = C.normalizeRuleSet(payload.ruleSet || {});
      // 服务端再规整一遍，防止客户端塞脏数据
      await db.collection(COL_COMPANY).where({ id: me.companyId }).update({
        data: { ruleSet: rs, ruleUpdatedAt: now, ruleUpdatedBy: OPENID },
      });

      // 审计：规则变更必须留痕，否则出了事查不到谁改的
      try {
        await db.collection('pc_audit').add({
          data: { openid: OPENID, kind: 'rule.set', companyId: me.companyId, at: now, role: me.role },
        });
      } catch (e) { /* 审计失败不影响主流程 */ }

      return C.ok({ ruleSet: rs, updatedBy: OPENID });
    }

    /* ---------------- 写：创建公司（任何登录用户可做一次） ---------------- */
    if (action === 'create') {
      const me = await whoAmI(OPENID);
      if (!me.ok) return me.error;
      if (me.user.companyId && me.user.companyId !== 'default') {
        return C.fail('ALREADY_IN_COMPANY', '你已经在一家公司里，不能重复创建');
      }

      const companyId = 'CO' + C.sha256(OPENID + '|' + now).toUpperCase().slice(0, 8);
      const inviteCode = genInviteCode(companyId, now);

      await db.collection(COL_COMPANY).add({
        data: {
          id: companyId,
          name: (payload.name || '我的公司').slice(0, 24),
          ownerUid: OPENID,
          inviteCode,
          createdAt: now,
          ruleSet: C.normalizeRuleSet({}),
        },
      });
      await db.collection(COL_MEMBER).add({
        data: { companyId, openid: OPENID, nickname: me.user.nickname || '创建者', role: 'owner', joinedAt: now, status: 'active' },
      });
      await db.collection(COL_USER).where({ openid: OPENID }).update({ data: { companyId, role: 'owner' } });

      return C.ok({ companyId, inviteCode, role: 'owner' });
    }

    /* ---------------- 写：用邀请码加入（任何人可做，角色固定 member） ---------------- */
    if (action === 'join') {
      const me = await whoAmI(OPENID);
      if (!me.ok) return me.error;

      const code = normalizeCode(payload.inviteCode);
      if (!code) return C.fail('BAD_CODE', '邀请码格式不对');
      if (me.user.companyId && me.user.companyId !== 'default') {
        return C.fail('ALREADY_IN_COMPANY', '你已经在一家公司里');
      }

      const r = await db.collection(COL_COMPANY).where({ inviteCode: code }).limit(1).get();
      const company = r.data && r.data[0];
      if (!company) return C.fail('WRONG_CODE', '邀请码不正确');

      // 关键：加入时角色**硬编码为 member**，绝不接受 payload 里的 role
      await db.collection(COL_MEMBER).add({
        data: {
          companyId: company.id,
          openid: OPENID,
          nickname: (payload.nickname || me.user.nickname || '新成员').slice(0, 16),
          role: 'member',
          joinedAt: now,
          status: 'active',
          inviteCodeUsed: code,
        },
      });
      await db.collection(COL_USER).where({ openid: OPENID }).update({
        data: { companyId: company.id, role: 'member' },
      });

      try {
        await db.collection('pc_audit').add({
          data: { openid: OPENID, kind: 'company.join', companyId: company.id, at: now },
        });
      } catch (e) { /* ignore */ }

      return C.ok({ companyId: company.id, companyName: company.name, role: 'member' });
    }

    /* ---------------- 写：换邀请码（仅 owner/admin） ---------------- */
    if (action === 'refreshCode') {
      const me = await requireAction(OPENID, 'member.invite');
      if (!me.ok) return me.error;
      const code = genInviteCode(me.companyId, now);
      await db.collection(COL_COMPANY).where({ id: me.companyId }).update({
        data: { inviteCode: code, inviteCodeUpdatedAt: now },
      });
      return C.ok({ inviteCode: code });
    }

    /* ---------------- 写：改成员角色（仅 owner/admin） ---------------- */
    if (action === 'setRole') {
      const me = await requireAction(OPENID, 'member.setRole');
      if (!me.ok) return me.error;

      const targetOpenid = payload.openid;
      const newRole = payload.role;
      if (!['admin', 'manager', 'member'].includes(newRole)) {
        return C.fail('BAD_ROLE', '非法角色（owner 只能通过转让产生）');
      }

      const tR = await db.collection(COL_MEMBER).where({ companyId: me.companyId, openid: targetOpenid }).limit(1).get();
      const target = tR.data && tR.data[0];
      if (!target) return C.fail('NOT_FOUND', '成员不存在');
      if (target.role === 'owner') return C.fail('CANNOT_MODIFY_OWNER', '创建者角色不能改，只能转让');

      // 不允许把最后一个管理员降级
      if ((LEVEL[target.role] || 0) >= 3 && (LEVEL[newRole] || 0) < 3) {
        const adminsR = await db.collection(COL_MEMBER).where({
          companyId: me.companyId,
          role: _.in(['owner', 'admin']),
          status: 'active',
        }).limit(50).get();
        const others = (adminsR.data || []).filter((m) => m.openid !== targetOpenid);
        if (!others.length) return C.fail('LAST_ADMIN', '至少要保留一个管理员');
      }

      await db.collection(COL_MEMBER).where({ companyId: me.companyId, openid: targetOpenid }).update({ data: { role: newRole } });
      await db.collection(COL_USER).where({ openid: targetOpenid }).update({ data: { role: newRole } });

      try {
        await db.collection('pc_audit').add({
          data: { openid: OPENID, kind: 'member.setRole', target: targetOpenid, from: target.role, to: newRole, at: now },
        });
      } catch (e) { /* ignore */ }

      return C.ok({ openid: targetOpenid, role: newRole });
    }

    /* ---------------- 写：移除成员 ---------------- */
    if (action === 'remove') {
      const me = await requireAction(OPENID, 'member.remove');
      if (!me.ok) return me.error;
      const targetOpenid = payload.openid;
      if (targetOpenid === OPENID) return C.fail('CANNOT_REMOVE_SELF', '不能移除自己');

      const tR = await db.collection(COL_MEMBER).where({ companyId: me.companyId, openid: targetOpenid }).limit(1).get();
      const target = tR.data && tR.data[0];
      if (!target) return C.fail('NOT_FOUND', '成员不存在');
      if (target.role === 'owner') return C.fail('CANNOT_REMOVE_OWNER', '不能移除创建者');

      await db.collection(COL_MEMBER).where({ companyId: me.companyId, openid: targetOpenid }).update({
        data: { status: 'removed', removedAt: now, removedBy: OPENID },
      });
      await db.collection(COL_USER).where({ openid: targetOpenid }).update({
        data: { companyId: 'default', role: 'employee' },
      });

      try {
        await db.collection('pc_audit').add({
          data: { openid: OPENID, kind: 'member.remove', target: targetOpenid, at: now },
        });
      } catch (e) { /* ignore */ }

      // 注意：**不删打卡记录**。考勤数据不能因为离职而消失，这是审计要求。
      return C.ok({ removed: targetOpenid, recordsKept: true });
    }

    /* ---------------- 写：转让创建者 ---------------- */
    if (action === 'transfer') {
      const me = await whoAmI(OPENID);
      if (!me.ok) return me.error;
      if (me.role !== 'owner') return C.fail('FORBIDDEN', '只有创建者可以转让');

      const targetOpenid = payload.openid;
      if (targetOpenid === OPENID) return C.fail('BAD_TARGET', '不能转让给自己');

      const tR = await db.collection(COL_MEMBER).where({ companyId: me.companyId, openid: targetOpenid, status: 'active' }).limit(1).get();
      const target = tR.data && tR.data[0];
      if (!target) return C.fail('NOT_FOUND', '目标成员不存在');

      await db.collection(COL_MEMBER).where({ companyId: me.companyId, openid: OPENID }).update({ data: { role: 'admin' } });
      await db.collection(COL_MEMBER).where({ companyId: me.companyId, openid: targetOpenid }).update({ data: { role: 'owner' } });
      await db.collection(COL_COMPANY).where({ id: me.companyId }).update({ data: { ownerUid: targetOpenid } });
      await db.collection(COL_USER).where({ openid: OPENID }).update({ data: { role: 'admin' } });
      await db.collection(COL_USER).where({ openid: targetOpenid }).update({ data: { role: 'owner' } });

      return C.ok({ ownerUid: targetOpenid });
    }

    return C.fail('BAD_ACTION', '未知操作 ' + action);
  } catch (e) {
    return C.fail('COMPANY_ERROR', (e && e.message) || 'company error');
  }
};
