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

  function agoText(ts) {
    if (!ts) return '';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
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
    var requireApproval = C.getRequireApproval();
    var pending = C.listPendingJoins(C.currentUid());
    var myJoin = C.myJoinStatus();

    var html = '<div class="page">';

    // ---- 公司卡 ----
    html += '<div class="card company-card">';
    html += '<div class="company-name">' + h(company ? company.name : '未创建公司') + '</div>';
    html += '<div class="company-meta">' + members.length + ' 位成员 · 你的角色：' + C.roleName(myRole) + '</div>';
    html += '</div>';

    // ---- 待审批（仅管理员）----
    if (canInvite && pending.length) {
      html += '<div class="section-label">待审批 · ' + pending.length + '</div>';
      pending.forEach(function (r) {
        html += '<div class="card">';
        html += '<div class="member-row">';
        html += '<div class="member-avatar">' + h((r.nickname || '?').slice(0, 1)) + '</div>';
        html += '<div class="member-info">';
        html += '<div class="member-name">' + h(r.nickname) + '</div>';
        html += '<div class="member-sub">' + h(agoText(r.createdAt)) + '</div>';
        html += '</div></div>';
        if (r.reason) html += '<div class="join-reason">「' + h(r.reason) + '」</div>';
        html += '<div class="join-ops">';
        html += '<button class="btn-sm op-ok" data-approve-join="' + h(r.id) + '">通过</button>';
        html += '<button class="btn-sm btn-sm-danger" data-reject-join="' + h(r.id) + '">驳回</button>';
        html += '</div></div>';
      });
    }

    // ---- 我的申请（非成员视角）----
    if (myJoin && !myJoin.isMember) {
      html += '<div class="section-label">我的申请</div>';
      html += '<div class="card">';
      html += '<div class="member-row"><div class="member-info">';
      html += '<div class="member-name">状态 · ' + h(myJoin.label) + '</div>';
      if (myJoin.request.reason) html += '<div class="member-sub">理由：' + h(myJoin.request.reason) + '</div>';
      if (myJoin.request.reviewNote) html += '<div class="member-sub">管理员备注：' + h(myJoin.request.reviewNote) + '</div>';
      html += '</div></div>';
      if (myJoin.status === 'pending') {
        html += '<button class="btn-ghost" id="cancelJoinBtn" style="margin-top:var(--s3)">撤回申请</button>';
      }
      html += '</div>';
    }

    // ---- 用邀请码加入（任何身份都能看到，非成员在这里输码）----
    html += '<div class="section-label">用邀请码加入</div>';
    html += '<div class="card join-entry">';
    html += '<div class="muted join-entry-hint">输入管理员给你的 6 位邀请码</div>';
    html += '<input class="invite-input" id="inviteInput" maxlength="6" placeholder="例如 ZJNY62" value="" pattern="[A-Z0-9]{6}" autocomplete="off" spellcheck="false" />';
    html += '<button class="btn-primary join-btn" id="submitJoin">' + (requireApproval ? '提交加入申请' : '加入公司') + '</button>';
    html += '<div class="muted join-entry-note" style="margin-top:var(--s3)">提交后需要管理员审批，通过后你才能开始打卡。</div>';
    html += '<div class="muted join-entry-note" style="margin-top:var(--s3)" id="joinEntryHint">你已经在「' + h(company ? company.name : '') + '」里。想以员工身份验证审批流程，需要另一台设备上的另一个账号（云端模式）。</div>';
    html += '</div>';

    // ---- 邀请码（只有管理员能看到完整码）----
    if (canInvite) {
      html += '<div class="section-label">邀请成员</div>';
      html += '<div class="card">';
      html += '<div class="invite-row">';
      html += '<div class="invite-code" id="inviteCode">' + h(company.inviteCode) + '</div>';
      html += '<button class="btn-sm" id="copyCode">复制</button>';
      html += '</div>';
      html += '<div class="muted" style="margin-top:var(--s2)">把邀请码发给同事。' +
        (requireApproval ? '对方提交申请，你审批通过后即可开始打卡。' : '对方输入后立即成为员工。') +
        ' 邀请码可随时更换，旧码立即失效。</div>';
      html += '<button class="btn" id="refreshCode" style="margin-top:var(--s3)">更换邀请码</button>';
      html += '<div class="member-row" style="margin-top:var(--s3)">';
      html += '<div class="member-info"><div class="member-name">加入需要审批</div>';
      html += '<div class="member-sub">关闭后，拿到邀请码即可直接加入</div></div>';
      html += '<label class="switch"><input type="checkbox" id="approvalToggle"' + (requireApproval ? ' checked' : '') + '><span class="slider"></span></label>';
      html += '</div>';
      html += '</div>';

      // ---- 体验用：加入一个测试员工 ----
      html += '<div class="card trial-card">';
      html += '<div class="card-title"><span>试用：加一个员工身份</span><span class="sub">仅本机体验</span></div>';
      html += '<div class="muted">网页版没有后端，这里可以在同一台设备上造一个员工身份' +
        (requireApproval ? '并提交一条申请，用来验证审批流。' : '，用来验证"员工看不到规则编辑"。') + '</div>';
      html += '<button class="btn" id="addTrial" style="margin-top:var(--s3)">' +
        (requireApproval ? '提交一条加入申请' : '用邀请码加入一个员工') + '</button>';
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

    // ---- 用邀请码加入（任何身份都能看到的输入框）----
    var joinInput = document.getElementById('inviteInput');
    var submitJoinBtn = document.getElementById('submitJoin');
    function submitJoinFromInput() {
      var code = (joinInput.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      joinInput.value = code;
      if (code.length !== 6) { toast('请输入 6 位邀请码'); return; }
      var needsApproval = C.getRequireApproval();
      if (needsApproval) {
        U.openSheet({
          title: '提交加入申请',
          body: '会新建一个本机身份并用当前邀请码提交申请，然后自动切换到该身份，方便你审批。',
          input: '',
          placeholder: '简单说明一下（可选），例如"我是市场部的张三"',
          confirmText: '提交申请',
          onConfirm: function (val) {
            var r = C.applyToJoin(code, '新员工', String(val || '').trim());
            toast(r.message);
            if (r.ok) U.reloadWithIdentity();
          },
        });
        return;
      }
      U.openSheet({
        title: '加一个员工身份',
        body: '会新建一个本机身份并用当前邀请码加入，然后自动切换到该身份。',
        input: '张三',
        placeholder: '员工昵称',
        confirmText: '加入并切换',
        onConfirm: function (val) {
          var name = (val || '张三').trim();
          var r = C.joinByInvite(code, name);
          toast(r.message);
          if (r.ok) U.reloadWithIdentity();
        },
      });
    }
    if (submitJoinBtn) submitJoinBtn.onclick = submitJoinFromInput;
    if (joinInput) {
      joinInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') submitJoinFromInput();
      });
    }

    var addTrial = document.getElementById('addTrial');
    if (addTrial) {
      addTrial.onclick = function () {
        var needsApproval = C.getRequireApproval();
        U.openSheet({
          title: needsApproval ? '提交一条加入申请' : '加一个员工身份',
          body: needsApproval
            ? '会新建一个本机身份并用当前邀请码提交加入申请，然后自动切换到该身份，方便你审批。'
            : '会新建一个本机身份并用当前邀请码加入，然后自动切换到该身份，方便你验证员工视角。',
          input: '张三',
          placeholder: '员工昵称',
          confirmText: needsApproval ? '提交申请' : '加入并切换',
          onConfirm: function (val) {
            var name = (val || '张三').trim();
            var r = needsApproval
              ? C.applyToJoin(C.getCompany().inviteCode, name, '试用申请')
              : C.joinByInvite(C.getCompany().inviteCode, name);
            if (!r.ok) { toast(r.message); return; }
            toast(r.message);
            U.reloadWithIdentity();
          },
        });
      };
    }

    // ---- 审批通过 / 驳回 ----
    $body.querySelectorAll('[data-approve-join]').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        var id = el.getAttribute('data-approve-join');
        var res = C.reviewJoin(id, true, C.currentUid());
        toast(res.message);
        if (res.ok) rerender();
      };
    });

    $body.querySelectorAll('[data-reject-join]').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        var id = el.getAttribute('data-reject-join');
        U.openSheet({
          title: '驳回这条申请？',
          body: '可以写一句原因，会展示给申请人。驳回后 10 分钟内对方不能再次申请。',
          input: '',
          placeholder: '驳回原因（可留空）',
          confirmText: '驳回',
          onConfirm: function (val) {
            var res = C.reviewJoin(id, false, C.currentUid(), String(val || '').trim());
            toast(res.message);
            if (res.ok) rerender();
          },
        });
      };
    });

    // ---- 撤回申请 ----
    var cancelJoinBtn = document.getElementById('cancelJoinBtn');
    if (cancelJoinBtn) {
      cancelJoinBtn.onclick = function () {
        var myJoin = C.myJoinStatus();
        if (!myJoin || !myJoin.request) return;
        var res = C.cancelJoin(myJoin.request.id, C.currentUid());
        toast(res.message);
        if (res.ok) rerender();
      };
    }

    // ---- 审批开关 ----
    var approvalToggle = document.getElementById('approvalToggle');
    if (approvalToggle) {
      approvalToggle.onchange = function () {
        var res = C.setRequireApproval(approvalToggle.checked);
        if (!res) {
          toast('没有权限修改');
          approvalToggle.checked = !approvalToggle.checked;
          return;
        }
        toast(approvalToggle.checked ? '已开启：加入需要审批' : '已关闭：凭邀请码直接加入');
        rerender();
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
