/**
 * 成员管理页 + 身份切换（webapp/team.js）
 *
 * 这是"一个管理员 + 其他人加入"的完整界面：
 *   · 管理员：看邀请码、复制、换码、改角色、移除成员、转让创建者
 *   · 员工：看公司名和成员名单，但没有任何管理按钮
 *
 * 实现方式：注册到 app.js 暴露的页面渲染器上（不侵入原有页面）。
 */
(function () {
  var C = null;
  var U = null; // app.js 提供的工具集合

  function h(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function can(action) {
    return C.canDo(action);
  }

  /* ==================== 成员管理页 ==================== */

  function renderTeam() {
    var me = C.currentAccount();
    var company = C.getCompany();
    var members = C.getMembers();
    var myRole = C.roleOf();
    var canInvite = can('member.invite');
    var canSetRole = can('member.setRole');
    var canRemove = can('member.remove');
    var canTransfer = C.atLeast(myRole, 'owner');

    var html = '<div class="page">';

    // ---- 公司卡 ----
    html += '<div class="card company-card">';
    html += '<div class="company-name">' + h(company ? company.name : '未创建公司') + '</div>';
    html += '<div class="company-meta">' + members.length + ' 位成员 · 你的角色：' + C.roleName(myRole) + '</div>';
    html += '</div>';

    // ---- 邀请码（只有管理员能看到完整码）----
    if (canInvite) {
      html += '<div class="section-label">邀请成员</div>';
      html += '<div class="card">';
      html += '<div class="invite-row">';
      html += '<div class="invite-code" id="inviteCode">' + h(company.inviteCode) + '</div>';
      html += '<button class="btn-sm" id="copyCode">复制</button>';
      html += '</div>';
      html += '<div class="muted" style="margin-top:var(--s2)">把邀请码发给同事，他在这台设备上用「加入公司」输入即可成为员工。邀请码可随时更换，旧码立即失效。</div>';
      html += '<button class="btn" id="refreshCode" style="margin-top:var(--s3)">更换邀请码</button>';
      html += '</div>';

      // ---- 体验用：加入一个测试员工 ----
      html += '<div class="card trial-card">';
      html += '<div class="card-title"><span>试用：加一个员工身份</span><span class="sub">仅本机体验</span></div>';
      html += '<div class="muted">网页版没有后端，这里可以在同一台设备上造一个员工身份，用来验证"员工看不到规则编辑"。</div>';
      html += '<button class="btn" id="addTrial" style="margin-top:var(--s3)">用邀请码加入一个员工</button>';
      html += '</div>';
    } else {
      html += '<div class="section-label">邀请成员</div>';
      html += '<div class="card"><div class="muted">只有管理员可以邀请成员。邀请码请向管理员索取。</div></div>';
    }

    // ---- 成员列表 ----
    html += '<div class="section-label">成员 · ' + members.length + '</div>';
    html += '<div class="card" style="padding-top:4px;padding-bottom:4px">';
    members.forEach(function (m) {
      var isMe = m.uid === C.currentUid();
      html += '<div class="member-row">';
      html += '<div class="member-avatar">' + h((m.nickname || '?').slice(0, 1)) + '</div>';
      html += '<div class="member-info">';
      html += '<div class="member-name">' + h(m.nickname) + (isMe ? '<span class="member-me">就是你</span>' : '') + '</div>';
      html += '<div class="member-sub">' + C.roleName(m.role) + ' · 加入于 ' + new Date(m.joinedAt).toLocaleDateString('zh-CN') + '</div>';
      html += '</div>';
      if (canSetRole && m.role !== 'owner') {
        html += '<button class="btn-sm" data-role-uid="' + h(m.uid) + '">改角色</button>';
      }
      if (canRemove && m.role !== 'owner' && !isMe) {
        html += '<button class="btn-sm btn-sm-danger" data-remove-uid="' + h(m.uid) + '">移除</button>';
      }
      html += '</div>';
    });
    html += '</div>';

    // ---- 转让（仅 owner）----
    if (canTransfer && members.filter(function (m) { return m.role !== 'owner'; }).length) {
      html += '<div class="section-label">创建者操作</div>';
      html += '<div class="card"><div class="muted">转让后你会变成管理员，对方成为创建者。创建者只有一个。</div>';
      html += '<button class="btn" id="transferBtn" style="margin-top:var(--s3)">转让创建者</button></div>';
    }

    // ---- 员工视角的说明 ----
    if (!canInvite) {
      html += '<div class="card"><div class="muted">你的角色是「' + C.roleName(myRole) + '」，只能打卡、申请补卡、查看自己的记录。公司设置与考勤规则由管理员维护。</div></div>';
    }

    html += '</div>';
    return html;
  }

  function bindTeam($body, rerender, toast) {
    var copyBtn = document.getElementById('copyCode');
    if (copyBtn) {
      copyBtn.onclick = function () {
        var code = document.getElementById('inviteCode').textContent.trim();
        if (navigator.clipboard) {
          navigator.clipboard.writeText(code).then(function () { toast('邀请码已复制'); }, function () { toast('复制失败，请手动记下'); });
        } else {
          toast('邀请码：' + code);
        }
      };
    }

    var refresh = document.getElementById('refreshCode');
    if (refresh) {
      refresh.onclick = function () {
        U.openSheet({
          title: '更换邀请码？',
          body: '旧邀请码会立即失效，已经加入的成员不受影响。',
          confirmText: '更换',
          onConfirm: function () {
            C.refreshInviteCode();
            toast('已更换邀请码');
            rerender();
          },
        });
      };
    }

    var addTrial = document.getElementById('addTrial');
    if (addTrial) {
      addTrial.onclick = function () {
        U.openSheet({
          title: '加一个员工身份',
          body: '会新建一个本机身份并用当前邀请码加入，然后自动切换到该身份，方便你验证员工视角。',
          input: '张三',
          placeholder: '员工昵称',
          confirmText: '加入并切换',
          onConfirm: function (val) {
            var r = C.joinByInvite(C.getCompany().inviteCode, (val || '张三').trim());
            if (!r.ok) { toast(r.message); return; }
            toast('已加入并切换为员工身份');
            U.reloadWithIdentity();
          },
        });
      };
    }

    $body.querySelectorAll('[data-role-uid]').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        var uid = el.getAttribute('data-role-uid');
        var m = C.memberOf(uid);
        if (!m) return;
        var opts = C.ROLES.filter(function (r) { return r.id !== 'owner'; });
        U.openSheet({
          title: '改 ' + m.nickname + ' 的角色',
          body: opts.map(function (r) { return r.name + '：' + r.desc; }).join('\n'),
          input: C.roleName(m.role),
          placeholder: '管理员 / 主管 / 员工',
          confirmText: '保存',
          onConfirm: function (val) {
            var v = String(val || '').trim();
            var target = opts.filter(function (r) { return r.name === v; })[0];
            if (!target) { toast('请填：管理员 / 主管 / 员工'); return; }
            var res = C.setMemberRole(uid, target.id, C.currentUid());
            toast(res.message);
            if (res.ok) rerender();
          },
        });
      };
    });

    $body.querySelectorAll('[data-remove-uid]').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        var uid = el.getAttribute('data-remove-uid');
        var m = C.memberOf(uid);
        if (!m) return;
        U.openSheet({
          title: '移除 ' + m.nickname + '？',
          body: '移除后他不能再打卡，但已有的考勤记录会保留（考勤不能因为离职而消失）。',
          confirmText: '移除',
          onConfirm: function () {
            var res = C.removeMember(uid, C.currentUid());
            toast(res.message);
            if (res.ok) rerender();
          },
        });
      };
    });

    var tr = document.getElementById('transferBtn');
    if (tr) {
      tr.onclick = function () {
        var others = C.getMembers().filter(function (m) { return m.role !== 'owner'; });
        U.openSheet({
          title: '转让给谁？',
          body: others.map(function (m) { return m.nickname; }).join(' / ') + '\n\n填写对方昵称。',
          input: others[0] ? others[0].nickname : '',
          confirmText: '转让',
          onConfirm: function (val) {
            var t = others.filter(function (m) { return m.nickname === String(val || '').trim(); })[0];
            if (!t) { toast('没找到这个成员'); return; }
            var res = C.transferOwnership(t.uid, C.currentUid());
            toast(res.message);
            if (res.ok) rerender();
          },
        });
      };
    }
  }

  /* ==================== 身份切换（我的页用） ==================== */

  function identitySwitcherHtml() {
    var accounts = C.getAccounts() || [];
    if (accounts.length < 2) return '';
    var cur = C.currentUid();
    var html = '<div class="section-label">本机身份（体验用）</div>';
    html += '<div class="card" style="padding-top:4px;padding-bottom:4px">';
    accounts.forEach(function (a) {
      var m = C.memberOf(a.uid);
      var isCur = a.uid === cur;
      html += '<div class="switch-row' + (isCur ? ' active' : '') + '" data-switch-uid="' + h(a.uid) + '">';
      html += '<div class="switch-name">' + h(a.nickname) + (isCur ? '<span class="member-me">当前</span>' : '') + '</div>';
      html += '<div class="switch-role">' + (m ? C.roleName(m.role) : '已移除') + '</div>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function bindIdentitySwitcher($body, toast) {
    $body.querySelectorAll('[data-switch-uid]').forEach(function (el) {
      el.onclick = function () {
        var uid = el.getAttribute('data-switch-uid');
        var r = C.switchTo(uid);
        if (!r.ok) { toast(r.message); return; }
        toast('已切换为 ' + r.member.nickname);
        U.reloadWithIdentity();
      };
    });
  }

  /* ==================== 注册到 app.js ==================== */

  // app.js 在末尾同步执行完，team.js 在其后加载，所以 __pc 一定已存在。
  // 这里自注册，不需要外部调用 attach()。
  function autoAttach() {
    if (!window.__pc || !window.__pc.registerPage) return false;
    C = window.PC_COMPANY;
    if (!C) return false;
    U = window.__pc;
    window.__pc.registerPage('team', {
      title: '公司与成员',
      render: renderTeam,
      bind: function ($body, rerender, toast) { bindTeam($body, rerender, toast); },
    });
    window.__pc.registerMeExtra({
      html: identitySwitcherHtml,
      bind: function ($body, toast) { bindIdentitySwitcher($body, toast); },
    });
    return true;
  }

  window.PC_TEAM = { attach: autoAttach, ready: autoAttach() };
})();
