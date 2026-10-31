const store = require('../../utils/store');
const company = require('../../utils/company');
const rules = require('../../core/rules');
const permissions = require('../../core/permissions');
const joinRequest = require('../../utils/joinRequest');
const cloud = require('../../utils/cloud');

Page({
  data: {
    companyName: '',
    memberCount: 0,
    myRoleName: '',
    inviteCode: '',
    requireApproval: true,
    members: [],
    pendingJoins: [],
    myJoin: null,
    myJoinLabel: '',
    myJoinTone: '',
    canInvite: false,
    canSetRole: false,
    canRemove: false,
    canReview: false,
    isOwner: false,
    transferables: [],
    cloudMode: false,
    isMember: true,
    inviteInput: '',
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    // 云端模式：审批流与成员数据以服务端为准
    if (cloud.isReady()) {
      const me = await cloud.call('company', 'me');
      if (me && me.ok && me.data && me.data.company) {
        this.setData({
          cloudMode: true,
          companyName: me.data.company.name,
          memberCount: (me.data.members || []).length,
          myRoleName: permissions.roleName(me.data.role),
          inviteCode: me.data.company.inviteCode || '',
          requireApproval: me.data.company.requireApproval !== false,
          members: (me.data.members || []).map((m) => ({
            uid: m.uid,
            nickname: m.nickname,
            initial: (m.nickname || '?').slice(0, 1),
            role: m.role,
            roleName: permissions.roleName(m.role),
            joinedText: fmtDate(m.joinedAt),
            isMe: m.uid === store.getBootInfo().uid,
          })),
          canInvite: !!me.data.canInvite,
          canSetRole: !!me.data.canSetRole,
          canRemove: !!me.data.canRemove,
          canReview: !!me.data.canInvite,
          isOwner: me.data.role === 'owner',
          transferables: (me.data.members || []).filter((m) => m.role !== 'owner'),
        });
      }

      // 待审批列表：只有能审批的角色才请求
      if (me && me.ok && me.data.canInvite) {
        const p = await cloud.call('company', 'pendingList');
        if (p && p.ok) {
          this.setData({
            pendingJoins: (p.data.list || []).map((r) => ({
              id: r.id,
              nickname: r.nickname,
              initial: (r.nickname || '?').slice(0, 1),
              reason: r.reason || '',
              agoText: agoText(r.createdAt),
            })),
          });
        }
      }

      // 我的申请状态
      const mj = await cloud.call('company', 'myJoin');
      if (mj && mj.ok) {
        const r = mj.data.request;
        this.setData({
          isMember: !!mj.data.isMember,
          myJoin: r
            ? {
                status: r.status,
                isMember: !!mj.data.isMember,
                request: r,
              }
            : null,
          myJoinLabel: r ? joinRequest.STATUS[r.status] || r.status : '',
          myJoinTone: !r
            ? 'mute'
            : r.status === 'approved'
            ? 'ok'
            : r.status === 'rejected'
            ? 'bad'
            : r.status === 'cancelled'
            ? 'mute'
            : 'warn',
        });
      }
      return;
    }

    this.refreshLocal();
  },

  refreshLocal() {
    const boot = store.getBootInfo();
    const uid = boot.uid;
    const c = company.ensureCompany(uid, boot.nickname);
    const role = company.roleOf(uid) || permissions ? company.roleOf(uid) : null;

    const members = company.getMembers()
      .filter((m) => m.status === 'active')
      .map((m) => ({
        uid: m.uid,
        nickname: m.nickname,
        initial: (m.nickname || '?').slice(0, 1),
        role: m.role,
        roleName: permissions.roleName(m.role),
        joinedText: fmtDate(m.joinedAt),
        isMe: m.uid === uid,
      }));

    const pendingRaw = company.listPendingJoins(uid);
    const pendingJoins = pendingRaw.map((r) => ({
      id: r.id,
      nickname: r.nickname,
      initial: (r.nickname || '?').slice(0, 1),
      reason: r.reason || '',
      agoText: agoText(r.createdAt),
    }));

    const myJoin = company.myJoinStatus(uid);
    const myJoinLabel = myJoin ? (joinRequest.STATUS[myJoin.status] || myJoin.status) : '';
    const myJoinTone = !myJoin
      ? 'mute'
      : myJoin.status === 'approved'
      ? 'ok'
      : myJoin.status === 'rejected'
      ? 'bad'
      : 'warn';

    this.setData({
      companyName: c.name,
      memberCount: members.length,
      myRoleName: permissions.roleName(role),
      inviteCode: company.canDo(uid, 'member.invite') ? c.inviteCode : '',
      requireApproval: c.requireApproval !== false,
      members,
      pendingJoins,
      myJoin,
      myJoinLabel,
      myJoinTone,
      isMember: !!company.getMember(uid),
      canInvite: company.canDo(uid, 'member.invite'),
      canSetRole: company.canDo(uid, 'member.setRole'),
      canRemove: company.canDo(uid, 'member.remove'),
      canReview: company.canDo(uid, 'member.invite'),
      isOwner: role === 'owner',
      transferables: members.filter((m) => m.role !== 'owner'),
    });
  },

  /* ---------- 加入公司 ---------- */

  onInviteInput(e) {
    // 只保留大写字母数字，方便和邀请码字符集一致
    const v = String(e.detail.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    this.setData({ inviteInput: v });
    return v;
  },

  submitJoin() {
    const code = this.data.inviteInput;
    const boot = store.getBootInfo();

    if (!code || code.length !== 6) {
      wx.showToast({ title: '请输入 6 位邀请码', icon: 'none' });
      return;
    }

    if (this.data.cloudMode) {
      this.submitJoinCloud(code);
      return;
    }

    const c = company.getCompany();
    if (c && c.requireApproval) {
      wx.showModal({
        title: '提交加入申请',
        editable: true,
        placeholderText: '简单说明一下（可选），例如"我是市场部的张三"',
        success: (r) => {
          if (!r.confirm) return;
          const res = company.applyToJoin(code, boot.uid, boot.nickname, r.content || '');
          wx.showToast({ title: res.message, icon: res.ok ? 'success' : 'none' });
          if (res.ok) this.setData({ inviteInput: '' });
          this.refresh();
        },
      });
      return;
    }

    const res = company.joinByInvite(code, boot.uid, boot.nickname);
    wx.showToast({ title: res.message, icon: res.ok ? 'success' : 'none' });
    if (res.ok) this.setData({ inviteInput: '' });
    this.refresh();
  },

  async submitJoinCloud(code) {
    const boot = store.getBootInfo();
    const c = company.getCompany();
    const requireApproval = c && c.requireApproval !== false;

    if (requireApproval) {
      wx.showModal({
        title: '提交加入申请',
        editable: true,
        placeholderText: '简单说明一下（可选），例如"我是市场部的张三"',
        success: async (r) => {
          if (!r.confirm) return;
          const res = await cloud.call('company', 'applyJoin', {
            inviteCode: code,
            nickname: boot.nickname,
            reason: r.content || '',
          });
          wx.showToast({ title: (res && res.message) || '提交失败', icon: res && res.ok ? 'success' : 'none' });
          if (res && res.ok) this.setData({ inviteInput: '' });
          this.refresh();
        },
      });
      return;
    }

    const res = await cloud.call('company', 'join', {
      inviteCode: code,
      nickname: boot.nickname,
    });
    wx.showToast({ title: (res && res.message) || '操作失败', icon: res && res.ok ? 'success' : 'none' });
    if (res && res.ok) this.setData({ inviteInput: '' });
    this.refresh();
  },

  /* ---------- 邀请 ---------- */

  copyInvite() {
    wx.setClipboardData({
      data: this.data.inviteCode,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }),
    });
  },

  refreshInvite() {
    wx.showModal({
      title: '更换邀请码？',
      content: '旧邀请码会立即失效，已加入的成员不受影响。',
      success: (r) => {
        if (!r.confirm) return;
        if (this.data.cloudMode) {
          cloud.call('company', 'refreshCode').then((res) => {
            wx.showToast({
              title: res && res.ok ? '已更换' : (res && res.message) || '更换失败',
              icon: res && res.ok ? 'success' : 'none',
            });
            this.refresh();
          });
          return;
        }
        company.refreshInviteCode();
        this.refresh();
        wx.showToast({ title: '已更换', icon: 'success' });
      },
    });
  },

  onToggleApproval(e) {
    const on = !!e.detail.value;
    if (this.data.cloudMode) {
      cloud.call('company', 'setApproval', { requireApproval: on }).then((res) => {
        wx.showToast({
          title: res && res.ok ? (on ? '已开启审批' : '已关闭，码即入') : (res && res.message) || '设置失败',
          icon: 'none',
        });
        this.refresh();
      });
      return;
    }
    company.setRequireApproval(on);
    this.refresh();
    wx.showToast({
      title: on ? '已开启审批' : '已关闭，码即入',
      icon: 'none',
    });
  },

  /* ---------- 审批 ---------- */

  approveJoin(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.cloudMode) {
      this.reviewCloud(id, true, '');
      return;
    }
    const boot = store.getBootInfo();
    const res = company.reviewJoin(id, true, boot.uid);
    wx.showToast({ title: res.message, icon: res.ok ? 'success' : 'none' });
    this.refresh();
    this.syncRoleFromCompany();
  },

  rejectJoin(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '驳回申请',
      editable: true,
      placeholderText: '可填写原因，会展示给对方',
      success: (r) => {
        if (!r.confirm) return;
        if (this.data.cloudMode) {
          this.reviewCloud(id, false, r.content || '');
          return;
        }
        const boot = store.getBootInfo();
        const res = company.reviewJoin(id, false, boot.uid, r.content || '');
        wx.showToast({ title: res.message, icon: 'none' });
        this.refresh();
      },
    });
  },

  async reviewCloud(id, approve, note) {
    const res = await cloud.call('company', 'reviewJoin', {
      requestId: id,
      approve: !!approve,
      note: note || '',
    });
    wx.showToast({
      title: (res && res.message) || (approve ? '已通过' : '已驳回'),
      icon: res && res.ok ? 'success' : 'none',
    });
    this.refresh();
  },

  cancelJoin() {
    const my = this.data.myJoin;
    if (!my || !my.request) return;
    if (this.data.cloudMode) {
      this.cancelJoinCloud(my.request.id);
      return;
    }
    const boot = store.getBootInfo();
    const res = joinRequest.cancel(my.request.id, boot.uid);
    wx.showToast({ title: res.message, icon: 'none' });
    this.refresh();
  },

  async cancelJoinCloud(id) {
    const res = await cloud.call('company', 'cancelJoin', { requestId: id });
    wx.showToast({ title: (res && res.message) || '操作失败', icon: 'none' });
    this.refresh();
  },

  /* ---------- 成员管理 ---------- */

  changeRole(e) {
    const { uid, name } = e.currentTarget.dataset;
    const opts = permissions.ROLES.filter((r) => r.id !== 'owner');
    wx.showActionSheet({
      itemList: opts.map((r) => r.name + '（' + r.desc + '）'),
      success: (r) => {
        const target = opts[r.tapIndex];
        if (this.data.cloudMode) {
          cloud.call('company', 'setRole', { targetUid: uid, role: target.id }).then((res) => {
            wx.showToast({
              title: (res && res.message) || '设置失败',
              icon: res && res.ok ? 'success' : 'none',
            });
            this.refresh();
          });
          return;
        }
        const boot = store.getBootInfo();
        const res = company.setMemberRole(uid, target.id, boot.uid);
        wx.showToast({ title: res.message, icon: res.ok ? 'success' : 'none' });
        this.refresh();
      },
    });
  },

  removeMember(e) {
    const { uid, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '移除 ' + name + '？',
      content: '移除后不能再打卡，但已有的考勤记录会保留（考勤不能因为离职而消失）。',
      confirmColor: '#ef4444',
      success: (r) => {
        if (!r.confirm) return;
        if (this.data.cloudMode) {
          cloud.call('company', 'remove', { targetUid: uid }).then((res) => {
            wx.showToast({
              title: (res && res.message) || '移除失败',
              icon: res && res.ok ? 'success' : 'none',
            });
            this.refresh();
          });
          return;
        }
        const boot = store.getBootInfo();
        const res = company.removeMember(uid, boot.uid);
        wx.showToast({ title: res.message, icon: res.ok ? 'success' : 'none' });
        this.refresh();
      },
    });
  },

  transferOwnership() {
    const list = this.data.transferables;
    if (!list.length) return;
    wx.showActionSheet({
      itemList: list.map((m) => m.nickname),
      success: (r) => {
        const target = list[r.tapIndex];
        if (this.data.cloudMode) {
          cloud.call('company', 'transfer', { targetUid: target.uid }).then((res) => {
            wx.showToast({
              title: (res && res.message) || '转让失败',
              icon: res && res.ok ? 'success' : 'none',
            });
            this.refresh();
          });
          return;
        }
        const boot = store.getBootInfo();
        const res = company.transferOwnership(target.uid, boot.uid);
        wx.showToast({ title: res.message, icon: res.ok ? 'success' : 'none' });
        this.refresh();
      },
    });
  },

  /** 审批通过后，若被批的是自己，需要刷新本机身份 */
  syncRoleFromCompany() {
    const boot = store.getBootInfo();
    const role = company.roleOf(boot.uid);
    if (role) store.setEnv(store.getBootInfo().env);
  },
});

function fmtDate(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
}

function agoText(ms) {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return '刚刚提交';
  if (mins < 60) return mins + ' 分钟前提交';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' 小时前提交';
  return Math.floor(hours / 24) + ' 天前提交';
}
