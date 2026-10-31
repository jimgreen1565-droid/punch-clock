/* ==========================================================================
   公司与权限（网页版）
   --------------------------------------------------------------------------
   诚实说明：网页版没有后端，所以这里用 localStorage 模拟"多家公司在同一台设备上"。
   它足够验证权限模型的正确性，但**不是真实的多用户隔离**——
   真实隔离必须靠云开发的 openid + 云函数判权（见 cloudfunctions/company）。
   本文件里的 role/can 与 miniprogram/core/permissions.js 是**同一套规则**，
   所以在这里验证过的权限逻辑可以直接搬到云端。

   重要：前端的 can() 只负责"不给入口"。
   真正的拦截在云函数，因为前端代码用户可以改。
   ========================================================================== */
(function () {
  var K_COMPANY = 'PC_COMPANY';
  var K_MEMBERS = 'PC_MEMBERS';
  var K_ACCOUNTS = 'PC_ACCOUNTS';   // 本机存的多个"身份"，用于切换体验
  var K_CURRENT = 'PC_CURRENT_UID';

  var ROLES = [
    { id: 'owner', name: '创建者', level: 4, desc: '公司创建人，唯一可转让与解散' },
    { id: 'admin', name: '管理员', level: 3, desc: '可改规则、管成员、看全员数据' },
    { id: 'manager', name: '主管', level: 2, desc: '可审批补卡、看数据，不能改规则' },
    { id: 'member', name: '员工', level: 1, desc: '只能打卡、申请补卡、看自己的记录' },
  ];

  var LEVEL = { owner: 4, admin: 3, manager: 2, member: 1 };

  // 权限清单：与 miniprogram/core/permissions.js 保持一致
  var ACTIONS = {
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

  var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function can(role, action) {
    var allowed = ACTIONS[action];
    if (!allowed) return false; // 未声明一律拒绝
    return allowed.indexOf(role) >= 0;
  }

  function atLeast(role, min) {
    return (LEVEL[role] || 0) >= (LEVEL[min] || 99);
  }

  function roleMeta(role) {
    return ROLES.filter(function (r) { return r.id === role; })[0] || { id: role, name: '未知', desc: '' };
  }

  function roleName(role) {
    return roleMeta(role).name;
  }

  function hash32(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function makeCode(seed) {
    var h = hash32(String(seed));
    var out = '';
    for (var i = 0; i < 6; i++) {
      out += CODE_CHARS[h % CODE_CHARS.length];
      h = (h >>> 5) + hash32(String(seed) + i);
      h = h >>> 0;
    }
    return out;
  }

  function makeCompanyId(uid, at) {
    return 'CO' + hash32(String(uid) + '|' + String(at)).toString(36).toUpperCase().slice(0, 8);
  }

  function normalizeCode(v) {
    var s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s.length === 6 ? s : null;
  }

  /* ---------------- 存储 ---------------- */

  function read(key, fb) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fb;
    } catch (e) {
      return fb;
    }
  }

  function write(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 账号（本机多身份，用于体验切换） ---------------- */

  function getAccounts() {
    var a = read(K_ACCOUNTS, null);
    return Array.isArray(a) && a.length ? a : null;
  }

  function setAccounts(list) {
    write(K_ACCOUNTS, list);
  }

  function currentUid() {
    return read(K_CURRENT, null);
  }

  function setCurrentUid(uid) {
    write(K_CURRENT, uid);
  }

  function currentAccount() {
    var uid = currentUid();
    var list = getAccounts() || [];
    return list.filter(function (a) { return a.uid === uid; })[0] || null;
  }

  /**
   * 首次使用：创建公司 + 自己是 owner。
   * 同时写入"本机账号列表"，这样后续可以加第二个身份来体验员工视角。
   */
  function ensureCompany(nickname) {
    var company = read(K_COMPANY, null);
    var members = read(K_MEMBERS, []);
    if (!Array.isArray(members)) members = [];

    if (company && company.id) {
      // 已有公司：确保当前 uid 在成员里
      var uid0 = currentUid();
      if (!uid0) {
        var first = members[0];
        if (first) setCurrentUid(first.uid);
      }
      return company;
    }

    var now = Date.now();
    var uid = 'U' + hash32('owner|' + now).toString(36).slice(0, 8);
    company = {
      id: makeCompanyId(uid, now),
      name: '我的公司',
      ownerUid: uid,
      inviteCode: makeCode(uid + '|' + now),
      createdAt: now,
    };
    write(K_COMPANY, company);

    members = [{
      uid: uid,
      nickname: nickname || '管理员',
      role: 'owner',
      joinedAt: now,
      status: 'active',
    }];
    write(K_MEMBERS, members);
    setAccounts([{ uid: uid, nickname: nickname || '管理员' }]);
    setCurrentUid(uid);
    return company;
  }

  function getCompany() {
    return read(K_COMPANY, null);
  }

  // 规则存在公司上（成员共享）；网页版把 ruleSet 也放这里
  function syncRuleFromCompany() {
    var c = getCompany();
    return c && c.ruleSet ? c.ruleSet : null;
  }

  function setCompanyRuleSet(ruleSet) {
    var c = getCompany();
    if (!c) return null;
    c.ruleSet = ruleSet;
    write(K_COMPANY, c);
    return c;
  }

  function renameCompany(name) {
    var c = getCompany();
    if (!c) return null;
    c.name = String(name || '').slice(0, 24) || '未命名公司';
    write(K_COMPANY, c);
    return c;
  }

  function refreshInviteCode() {
    var c = getCompany();
    if (!c) return null;
    c.inviteCode = makeCode(c.id + '|' + Date.now());
    c.inviteCodeUpdatedAt = Date.now();
    write(K_COMPANY, c);
    return c;
  }

  /* ---------------- 成员 ---------------- */

  function getMembers() {
    var m = read(K_MEMBERS, []);
    return Array.isArray(m) ? m : [];
  }

  function memberOf(uid) {
    return getMembers().filter(function (m) { return m.uid === uid; })[0] || null;
  }

  function roleOf(uid) {
    var m = memberOf(uid || currentUid());
    return m && m.status === 'active' ? m.role : null;
  }

  function canDo(action, uid) {
    var role = roleOf(uid);
    if (!role) return false;
    return can(role, action);
  }

  /**
   * 用邀请码加入（会新建一个本机身份，用于体验员工视角）。
   */
  function joinByInvite(rawCode, nickname) {
    var code = normalizeCode(rawCode);
    if (!code) return { ok: false, code: 'BAD_FORMAT', message: '邀请码是 6 位字母数字' };

    var company = getCompany();
    if (!company) return { ok: false, code: 'NO_COMPANY', message: '本机还没有公司' };
    if (company.inviteCode !== code) return { ok: false, code: 'WRONG_CODE', message: '邀请码不正确' };

    var now = Date.now();
    var uid = 'U' + hash32(String(nickname) + '|' + now).toString(36).slice(0, 8);
    var members = getMembers();
    if (members.some(function (m) { return m.uid === uid; })) {
      return { ok: false, code: 'ALREADY_IN', message: '这个身份已在公司里' };
    }

    var member = {
      uid: uid,
      nickname: String(nickname || '新员工').slice(0, 16),
      role: 'member',
      joinedAt: now,
      status: 'active',
      inviteCodeUsed: code,
    };
    members.push(member);
    write(K_MEMBERS, members);

    // 加入本机账号列表并切换过去（方便立即体验员工视角）
    var accounts = getAccounts() || [];
    accounts.push({ uid: uid, nickname: member.nickname });
    setAccounts(accounts);
    setCurrentUid(uid);

    return { ok: true, code: 'OK', message: '已加入 ' + company.name, member: member };
  }

  /** 切换本机身份（体验不同角色） */
  function switchTo(uid) {
    var m = memberOf(uid);
    if (!m) return { ok: false, message: '身份不存在' };
    setCurrentUid(uid);
    return { ok: true, member: m };
  }

  function setMemberRole(targetUid, newRole, operatorUid) {
    if (!canDo('member.setRole', operatorUid)) return { ok: false, message: '你没有改角色的权限' };
    var members = getMembers();
    var t = members.filter(function (m) { return m.uid === targetUid; })[0];
    if (!t) return { ok: false, message: '成员不存在' };
    if (t.role === 'owner') return { ok: false, message: '创建者角色不能改，只能转让' };

    if (atLeast(t.role, 'admin') && !atLeast(newRole, 'admin')) {
      var others = members.filter(function (m) {
        return m.uid !== targetUid && m.status === 'active' && atLeast(m.role, 'admin');
      });
      if (!others.length) return { ok: false, message: '至少要保留一个管理员，否则没人能改规则' };
    }
    t.role = newRole;
    write(K_MEMBERS, members);
    return { ok: true, message: '已改为' + roleName(newRole), member: t };
  }

  function removeMember(targetUid, operatorUid) {
    if (!canDo('member.remove', operatorUid)) return { ok: false, message: '你没有移除成员的权限' };
    var t = memberOf(targetUid);
    if (!t) return { ok: false, message: '成员不存在' };
    if (t.role === 'owner') return { ok: false, message: '不能移除创建者' };
    var members = getMembers().filter(function (m) { return m.uid !== targetUid; });
    write(K_MEMBERS, members);
    var accounts = (getAccounts() || []).filter(function (a) { return a.uid !== targetUid; });
    setAccounts(accounts);
    if (currentUid() === targetUid) setCurrentUid(accounts.length ? accounts[0].uid : null);
    return { ok: true, message: '已移除' };
  }

  function transferOwnership(newOwnerUid, operatorUid) {
    var c = getCompany();
    if (!c) return { ok: false, message: '公司不存在' };
    if (c.ownerUid !== operatorUid) return { ok: false, message: '只有创建者可以转让' };
    var t = memberOf(newOwnerUid);
    if (!t) return { ok: false, message: '目标成员不存在' };

    var members = getMembers();
    members.forEach(function (m) {
      if (m.uid === operatorUid) m.role = 'admin';
      if (m.uid === newOwnerUid) m.role = 'owner';
    });
    c.ownerUid = newOwnerUid;
    write(K_MEMBERS, members);
    write(K_COMPANY, c);
    return { ok: true, message: '已转让给 ' + t.nickname };
  }

  window.PC_COMPANY = {
    ROLES: ROLES,
    ACTIONS: ACTIONS,
    can: can,
    atLeast: atLeast,
    roleName: roleName,
    roleMeta: roleMeta,
    ensureCompany: ensureCompany,
    getCompany: getCompany,
    renameCompany: renameCompany,
    refreshInviteCode: refreshInviteCode,
    syncRuleFromCompany: syncRuleFromCompany,
    setCompanyRuleSet: setCompanyRuleSet,
    getMembers: getMembers,
    memberOf: memberOf,
    roleOf: roleOf,
    canDo: canDo,
    joinByInvite: joinByInvite,
    getAccounts: getAccounts,
    setAccounts: setAccounts,
    currentUid: currentUid,
    currentAccount: currentAccount,
    switchTo: switchTo,
    setMemberRole: setMemberRole,
    removeMember: removeMember,
    transferOwnership: transferOwnership,
    makeCode: makeCode,
    normalizeCode: normalizeCode,
  };
})();
