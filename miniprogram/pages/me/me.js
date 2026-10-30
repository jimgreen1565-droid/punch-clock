const store = require('../../utils/store');
const punch = require('../../utils/punch');
const rules = require('../../core/rules');

Page({
  data: {
    nickname: '',
    initial: '打',
    ruleTypeName: '',
    ruleDesc: '',
    envText: '本地',
    todayText: '',
    todayLabel: '',
    todayTone: 'ok',
    inText: '',
    outText: '',
    workText: '0h0m',
    recordCount: 0,
    chainOk: true,
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const boot = store.getBootInfo();
    const rs = store.getRuleSet();
    const s = punch.todaySummary();
    const chain = store.verifyLocalChain();
    const p = rules.partsOf(Date.now());

    this.setData({
      nickname: boot.nickname,
      initial: (boot.nickname || '打').slice(0, 1),
      ruleTypeName: rules.ruleTypeName(rs.type),
      ruleDesc: rules.describeRule(rs),
      envText: boot.env === 'cloud' ? '云端同步' : '本地离线',
      todayText: p.m + '/' + p.d + ' ' + rules.WEEKDAY_TEXT[p.weekday],
      todayLabel: s.day.hasAny ? s.statusLabel : s.isRest ? '休息' : '未打卡',
      todayTone: s.day.hasAny ? s.statusTone : s.isRest ? 'mute' : 'mute',
      inText: s.day.inAt ? s.inText : '',
      outText: s.day.outAt ? s.outText : '',
      workText: fmtMin(s.workMinutes),
      recordCount: chain.count,
      chainOk: chain.ok,
    });
  },

  editNickname() {
    wx.showModal({
      title: '设置昵称',
      editable: true,
      content: this.data.nickname,
      placeholderText: '姓名或昵称',
      success: (r) => {
        if (!r.confirm) return;
        store.setNickname((r.content || '').trim());
        this.refresh();
        wx.showToast({ title: '已保存', icon: 'success' });
      },
    });
  },

  goRules() {
    wx.navigateTo({ url: '/pages/rules/rules' });
  },

  goStats() {
    wx.navigateTo({ url: '/pages/stats/stats' });
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  exportData() {
    const dump = {
      exportedAt: Date.now(),
      app: 'punch-clock',
      version: 2,
      boot: store.getBootInfo(),
      ruleSet: store.getRuleSet(),
      records: store.getRecords(),
      leaves: store.getLeaves(),
      patches: store.getPatches(),
      presets: store.getPresets(),
      chain: store.verifyLocalChain(),
    };
    wx.setClipboardData({
      data: JSON.stringify(dump, null, 2),
      success: () =>
        wx.showModal({
          title: '已复制',
          content: 'JSON 已复制到剪贴板（' + dump.records.length + ' 条记录），可直接粘贴备份。',
          showCancel: false,
        }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  resetAll() {
    wx.showModal({
      title: '清空全部数据',
      content: '将删除本机所有打卡记录、规则配置与模板，且不可恢复。建议先导出备份。',
      confirmText: '确认清空',
      confirmColor: '#ef4444',
      success: (r) => {
        if (!r.confirm) return;
        store.resetAll();
        this.refresh();
        wx.showToast({ title: '已清空', icon: 'success' });
      },
    });
  },
});

function fmtMin(min) {
  const m = Math.max(0, Math.round(min || 0));
  if (!m) return '0m';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? h + 'h' + r + 'm' : h + 'h') : r + 'm';
}
