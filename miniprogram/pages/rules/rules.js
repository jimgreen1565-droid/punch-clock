const store = require('../../utils/store');
const geo = require('../../utils/geo');
const rules = require('../../core/rules');

Page({
  data: {
    types: rules.RULE_TYPES,
    ruleSet: {},
    ruleTypeName: '',
    ruleDesc: '',
    weekdaysText: '',
    breakText: '',
    requiredText: '',
    targetText: '',
    slotText: '',
    patchDaysText: '',
    patchQuotaText: '',
    patchUsed: 0,
    presets: [],
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const rs = store.getRuleSet();
    const presets = store.getPresets().map((p) => ({
      id: p.id,
      name: p.name,
      desc: rules.ruleTypeName(p.ruleSet.type) + ' · ' + rules.describeRule(p.ruleSet),
    }));

    this.setData({
      ruleSet: rs,
      ruleTypeName: rules.ruleTypeName(rs.type),
      ruleDesc: rules.describeRule(rs),
      weekdaysText: rules.weekdaysText(rs.weekdays),
      breakText: rs.breakStart ? rs.breakStart + '-' + rs.breakEnd : '未设置',
      requiredText: rules.fmtMinuteText(rs.requiredMinutes),
      targetText: rules.fmtMinuteText(rs.dailyTargetMinutes),
      slotText: rs.rotation.slots.map(rules.slotName(rs)).join(' → '),
      patchDaysText: rs.patch.maxDays === 0 ? '仅当天' : '过去 ' + rs.patch.maxDays + ' 天',
      patchQuotaText: rs.patch.maxPerMonth === 0 ? '不限' : rs.patch.maxPerMonth + ' 次',
      patchUsed: this.countPatchUsed(),
      presets,
    });
  },

  /* ---------- 类型切换 ---------- */

  onPickType(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.ruleSet.type) return;
    const name = rules.ruleTypeName(type);
    wx.showModal({
      title: '切换为' + name + '？',
      content: '切换后今天的判定会按新规则计算；已产生的打卡记录不会被改写。',
      success: (r) => {
        if (!r.confirm) return;
        store.switchRuleType(type);
        this.refresh();
        wx.showToast({ title: '已切换为' + name, icon: 'success' });
      },
    });
  },

  /* ---------- 时间编辑 ---------- */

  editTime(field, title, cb) {
    const cur = this.data.ruleSet[field];
    wx.showModal({
      title,
      editable: true,
      content: cur,
      placeholderText: 'HH:MM，例如 09:00',
      success: (r) => {
        if (!r.confirm) return;
        if (rules.parseHHMM(r.content) === null) {
          wx.showToast({ title: '格式应为 HH:MM', icon: 'none' });
          return;
        }
        store.setRuleSet({ [field]: r.content.trim() });
        this.refresh();
        if (cb) cb();
      },
    });
  },

  editStart() {
    const t = this.data.ruleSet.type === 'shift' ? '上班时间' : '上班时间';
    this.editTime('start', t);
  },

  editEnd() {
    this.editTime('end', '下班时间');
  },

  editLatestStart() {
    this.editTime('latestStart', '最晚上班时间');
  },

  editEarliestEnd() {
    this.editTime('earliestEnd', '最早下班时间');
  },

  editRequired() {
    wx.showModal({
      title: '每日应满工时（分钟）',
      editable: true,
      content: String(this.data.ruleSet.requiredMinutes),
      placeholderText: '480 = 8 小时',
      success: (r) => {
        if (!r.confirm) return;
        const v = Number(r.content);
        if (!isFinite(v) || v < 60 || v > 1440) {
          wx.showToast({ title: '请输入 60-1440', icon: 'none' });
          return;
        }
        store.setRuleSet({ requiredMinutes: Math.round(v) });
        this.refresh();
      },
    });
  },

  editTarget() {
    wx.showModal({
      title: '每日目标工时（分钟）',
      editable: true,
      content: String(this.data.ruleSet.dailyTargetMinutes),
      success: (r) => {
        if (!r.confirm) return;
        const v = Number(r.content);
        if (!isFinite(v) || v < 0 || v > 1440) {
          wx.showToast({ title: '请输入 0-1440', icon: 'none' });
          return;
        }
        store.setRuleSet({ dailyTargetMinutes: Math.round(v) });
        this.refresh();
      },
    });
  },

  editGrace() {
    wx.showModal({
      title: '迟到宽限（分钟）',
      editable: true,
      content: String(this.data.ruleSet.lateGrace),
      success: (r) => {
        if (!r.confirm) return;
        const v = Number(r.content);
        if (!isFinite(v) || v < 0) {
          wx.showToast({ title: '请输入非负数字', icon: 'none' });
          return;
        }
        store.setRuleSet({ lateGrace: Math.min(120, Math.round(v)) });
        this.refresh();
      },
    });
  },

  editRadius() {
    wx.showModal({
      title: '打卡范围半径（米）',
      editable: true,
      content: String(this.data.ruleSet.geo.radius),
      placeholderText: '常见 200-500',
      success: (r) => {
        if (!r.confirm) return;
        const v = Number(r.content);
        if (!isFinite(v) || v <= 0 || v > 5000) {
          wx.showToast({ title: '请输入 1-5000', icon: 'none' });
          return;
        }
        store.setRuleSet({ geo: { radius: Math.round(v) } });
        this.refresh();
      },
    });
  },

  /* ---------- 工作日 / 午休 ---------- */

  editWeekdays() {
    const rs = this.data.ruleSet;
    const picked = rs.weekdays.slice();
    wx.showActionSheet({
      itemList: [1, 2, 3, 4, 5, 6, 7].map((w) => (picked.indexOf(w) >= 0 ? '✓ ' : '　 ') + rules.WEEKDAY_TEXT[w]),
      success: (r) => {
        const w = r.tapIndex + 1;
        let next = picked.slice();
        if (next.indexOf(w) >= 0) next = next.filter((x) => x !== w);
        else next.push(w);
        next.sort((a, b) => a - b);
        if (!next.length) {
          wx.showToast({ title: '至少保留一天', icon: 'none' });
          return;
        }
        store.setRuleSet({ weekdays: next });
        this.refresh();
        wx.showToast({ title: '已更新', icon: 'success' });
      },
    });
  },

  editBreak() {
    const rs = this.data.ruleSet;
    wx.showActionSheet({
      itemList: ['午休开始 ' + (rs.breakStart || '未设置'), '午休结束 ' + (rs.breakEnd || '未设置'), '不设置午休'],
      success: (r) => {
        if (r.tapIndex === 2) {
          store.setRuleSet({ breakStart: '', breakEnd: '' });
          this.refresh();
          return;
        }
        const field = r.tapIndex === 0 ? 'breakStart' : 'breakEnd';
        wx.showModal({
          title: field === 'breakStart' ? '午休开始' : '午休结束',
          editable: true,
          content: rs[field] || '',
          placeholderText: 'HH:MM',
          success: (res) => {
            if (!res.confirm) return;
            if (rules.parseHHMM(res.content) === null) {
              wx.showToast({ title: '格式应为 HH:MM', icon: 'none' });
              return;
            }
            store.setRuleSet({ [field]: res.content.trim() });
            this.refresh();
          },
        });
      },
    });
  },

  /* ---------- 排班 ---------- */

  toggleRotation() {
    const rot = this.data.ruleSet.rotation;
    store.setRuleSet({ rotation: { enabled: !rot.enabled } });
    this.refresh();
  },

  editCycle() {
    wx.showModal({
      title: '轮换周期（天）',
      editable: true,
      content: String(this.data.ruleSet.rotation.cycleDays),
      success: (r) => {
        if (!r.confirm) return;
        const v = Number(r.content);
        if (!isFinite(v) || v < 1 || v > 60) {
          wx.showToast({ title: '请输入 1-60', icon: 'none' });
          return;
        }
        const n = Math.round(v);
        const slots = this.data.ruleSet.rotation.slots.slice(0, n);
        while (slots.length < n) slots.push(slots.length === n - 1 ? 'REST' : this.data.ruleSet.shifts[0].id);
        store.setRuleSet({ rotation: { cycleDays: n, slots } });
        this.refresh();
      },
    });
  },

  editSlots() {
    const rs = this.data.ruleSet;
    const opts = rs.shifts.map((s) => s.name).concat(['休息']);
    wx.showActionSheet({
      itemList: opts,
      success: (r) => {
        const slot = r.tapIndex === rs.shifts.length ? 'REST' : rs.shifts[r.tapIndex].id;
        // 依次替换下一个非 REST 位置：简单起见让用户点第几步
        wx.showModal({
          title: '替换第几步？',
          editable: true,
          content: '1',
          placeholderText: '1-' + rs.rotation.cycleDays,
          success: (res) => {
            if (!res.confirm) return;
            const pos = Number(res.content);
            if (!isFinite(pos) || pos < 1 || pos > rs.rotation.cycleDays) {
              wx.showToast({ title: '超出范围', icon: 'none' });
              return;
            }
            const slots = rs.rotation.slots.slice();
            slots[pos - 1] = slot;
            store.setRuleSet({ rotation: { slots } });
            this.refresh();
          },
        });
      },
    });
  },

  /* ---------- 补卡规则 ---------- */

  countPatchUsed() {
    const month = rules.monthKeyOf(Date.now());
    return store.getPatches().filter((p) => String(p.dateKey || '').slice(0, 7) === month && p.status !== 'rejected').length;
  },

  togglePatch() {
    const cur = this.data.ruleSet.patch.allow;
    store.setRuleSet({ patch: { allow: !cur } });
    this.refresh();
    wx.showToast({ title: cur ? '已关闭补卡' : '已允许补卡', icon: 'none' });
  },

  editPatchDays() {
    const cur = this.data.ruleSet.patch.maxDays;
    wx.showModal({
      title: '可补天数（0 = 仅当天）',
      editable: true,
      content: String(cur),
      success: (r) => {
        if (!r.confirm) return;
        const v = Number(r.content);
        if (!isFinite(v) || v < 0 || v > 180) {
          wx.showToast({ title: '请输入 0-180', icon: 'none' });
          return;
        }
        store.setRuleSet({ patch: { maxDays: Math.round(v) } });
        this.refresh();
      },
    });
  },

  editPatchQuota() {
    const cur = this.data.ruleSet.patch.maxPerMonth;
    wx.showModal({
      title: '每月补卡上限（0 = 不限）',
      editable: true,
      content: String(cur),
      success: (r) => {
        if (!r.confirm) return;
        const v = Number(r.content);
        if (!isFinite(v) || v < 0 || v > 999) {
          wx.showToast({ title: '请输入 0-999', icon: 'none' });
          return;
        }
        store.setRuleSet({ patch: { maxPerMonth: Math.round(v) } });
        this.refresh();
      },
    });
  },

  /* ---------- 打卡方式 ---------- */

  onToggleGeo(e) {
    store.setRuleSet({ geo: { enabled: !!e.detail.value } });
    this.refresh();
  },

  onToggleStrict(e) {
    store.setRuleSet({ geo: { strict: !e.detail.value } });
    this.refresh();
  },

  async setHere() {
    wx.showLoading({ title: '定位中', mask: true });
    const loc = await geo.getLocation();
    wx.hideLoading();
    if (!loc.ok) {
      wx.showToast({ title: loc.denied ? '定位权限未开' : '定位失败', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '设为打卡点',
      content: '把当前位置设为打卡点？\n纬度 ' + loc.lat.toFixed(6) + '\n经度 ' + loc.lng.toFixed(6) + '\n精度 ±' + Math.round(loc.acc || 0) + ' 米',
      success: (r) => {
        if (!r.confirm) return;
        store.setRuleSet({ geo: { lat: loc.lat, lng: loc.lng } });
        this.refresh();
        wx.showToast({ title: '已更新打卡点', icon: 'success' });
      },
    });
  },

  /* ---------- 模板 ---------- */

  onSavePreset() {
    const rs = this.data.ruleSet;
    wx.showModal({
      title: '保存为模板',
      editable: true,
      content: this.data.ruleTypeName,
      placeholderText: '模板名称',
      success: (r) => {
        if (!r.confirm) return;
        store.savePreset((r.content || '').trim() || this.data.ruleTypeName);
        this.refresh();
        wx.showToast({ title: '已保存模板', icon: 'success' });
      },
    });
  },

  onApplyPreset(e) {
    const id = e.currentTarget.dataset.id;
    const p = this.data.presets.find((x) => x.id === id);
    wx.showModal({
      title: '应用模板',
      content: '将切换到「' + (p ? p.name : '') + '」的规则配置，当前规则会被覆盖。',
      success: (r) => {
        if (!r.confirm) return;
        store.applyPreset(id);
        this.refresh();
        wx.showToast({ title: '已应用', icon: 'success' });
      },
    });
  },

  onRemovePreset(e) {
    const id = e.currentTarget.dataset.id;
    store.removePreset(id);
    this.refresh();
    wx.showToast({ title: '已删除', icon: 'none' });
  },
});
