const store = require('../../utils/store');
const rules = require('../../core/rules');

const WEEK_TEXT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEK_SHORT = ['', '一', '二', '三', '四', '五', '六', '日'];

Page({
  data: {
    month: '',
    summary: { present: 0, abnormal: 0, workHours: '0h', otHours: '0h' },
    chain: { ok: true, count: 0 },
    chainText: '',
    weekStrip: [],
    days: [],
    expanded: {},
  },

  onLoad(query) {
    this.setData({ month: (query && query.month) || rules.monthKeyOf(Date.now()) });
    this.refresh();
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  },

  refresh() {
    this.verifyChain();
    this.buildDays();
    this.buildWeekStrip();
    this.buildSummary();
  },

  verifyChain() {
    const v = store.verifyLocalChain();
    const records = store.getRecords();
    const tail = records.length ? records[records.length - 1].hash : '';
    this.setData({
      chain: { ok: v.ok, count: v.count },
      chainText: v.ok
        ? v.count + ' 条记录完整，最近 ' + (tail ? tail.slice(0, 16) + '…' : '—')
        : '第 ' + ((v.brokenAt || 0) + 1) + ' 条校验失败（' + v.reason + '）',
    });
  },

  buildSummary() {
    const rs = store.getRuleSet();
    const records = store.getRecords();
    const now = Date.now();
    const info = rules.monthInfo(this.data.month);
    const todayKey = rules.dayKeyOf(now);
    let present = 0;
    let abnormal = 0;
    let workMin = 0;
    let otMin = 0;
    let planned = 0;

    for (let i = 1; i <= info.days; i++) {
      const dayKey = info.y + '-' + rules.pad2(info.m) + '-' + rules.pad2(i);
      if (dayKey > todayKey) break;
      const day = rules.pairDay(records, rs, dayKey, now);
      if (!day.restDay) planned += 1;
      if (day.inAt) present += 1;
      if (['late', 'early', 'missing', 'absent', 'under'].indexOf(day.status) >= 0) abnormal += 1;
      workMin += day.workMinutes;
      otMin += day.overtimeMinutes;
    }

    this.setData({
      summary: {
        present,
        planned,
        abnormal,
        workHours: Math.floor(workMin / 60) + 'h',
        otHours: Math.floor(otMin / 60) + 'h',
      },
    });
  },

  buildDays() {
    const month = this.data.month;
    const rs = store.getRuleSet();
    const records = store.getRecords();
    const now = Date.now();
    const info = rules.monthInfo(month);
    const todayKey = rules.dayKeyOf(now);
    const days = [];

    for (let i = info.days; i >= 1; i--) {
      const dayKey = info.y + '-' + rules.pad2(info.m) + '-' + rules.pad2(i);
      if (dayKey > todayKey) continue;
      const day = rules.pairDay(records, rs, dayKey, now);
      // 休息日且无记录：不显示（避免刷屏）
      if (day.restDay && !day.hasAny) continue;

      const p = rules.partsOf(rules.msOfDayMinute(dayKey, 720));
      const meta = rules.statusMeta(day.status);
      const dayRecords = records
        .filter((r) => r.dateKey === dayKey)
        .map((r) => ({
          id: r.id,
          type: r.type,
          hhmmss: rules.hhmmssOf(r.at),
          metaText: metaOf(r, rs),
          hashShort: (r.hash || '').slice(0, 10),
        }));

      days.push({
        dateKey: dayKey,
        dayNum: rules.pad2(i),
        weekText: WEEK_TEXT[p.weekday],
        inText: day.inAt ? rules.hhmmOf(day.inAt) : '--:--',
        outText: day.outAt ? rules.hhmmOf(day.outAt) : '--:--',
        workText: day.workMinutes ? fmtMin(day.workMinutes) : '—',
        statusLabel: meta.label,
        tone: meta.tone,
        shiftName: rs.type === 'shift' ? day.shiftName : '',
        outside: dayRecords.some((r) => records.find((x) => x.id === r.id && (x.dist === null && x.geoSkipped))),
        records: dayRecords,
      });
    }

    this.setData({ days });
  },

  buildWeekStrip() {
    const rs = store.getRuleSet();
    const records = store.getRecords();
    const now = Date.now();
    const todayKey = rules.dayKeyOf(now);
    const todayWeekday = rules.partsOf(now).weekday;
    // 以本周一为起点
    const monday = rules.shiftDayKey(todayKey, -(todayWeekday - 1));
    const strip = [];
    for (let i = 0; i < 7; i++) {
      const dayKey = rules.shiftDayKey(monday, i);
      const day = rules.pairDay(records, rs, dayKey, now);
      let tone = '';
      if (dayKey <= todayKey && !day.restDay) {
        if (['missing', 'absent'].indexOf(day.status) >= 0) tone = 'bad';
        else if (['late', 'early', 'under'].indexOf(day.status) >= 0) tone = 'warn';
        else if (day.hasAny || (dayKey < todayKey && day.restDay)) tone = 'ok';
        else if (dayKey < todayKey) tone = 'bad';
      } else if (day.restDay) tone = 'mute';
      strip.push({
        dayKey,
        w: WEEK_SHORT[i + 1],
        d: String(Number(dayKey.slice(8))),
        tone,
        isToday: dayKey === todayKey,
      });
    }
    this.setData({ weekStrip: strip });
  },

  toggleDay(e) {
    const key = e.currentTarget.dataset.key;
    const expanded = Object.assign({}, this.data.expanded);
    expanded[key] = !expanded[key];
    this.setData({ expanded });
  },

  prevMonth() {
    const [y, m] = this.data.month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    this.setData({ month: d.getUTCFullYear() + '-' + rules.pad2(d.getUTCMonth() + 1) });
    this.refresh();
  },

  nextMonth() {
    const [y, m] = this.data.month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m, 1));
    const month = d.getUTCFullYear() + '-' + rules.pad2(d.getUTCMonth() + 1);
    if (month > rules.monthKeyOf(Date.now())) return;
    this.setData({ month });
    this.refresh();
  },

  goStats() {
    wx.navigateTo({ url: '/pages/stats/stats?month=' + this.data.month });
  },

  onVerify() {
    this.verifyChain();
    const c = this.data.chain;
    wx.showModal({
      title: c.ok ? '校验通过' : '校验失败',
      content: this.data.chainText,
      showCancel: false,
    });
  },

  onApplyPatch(e) {
    const key = e.currentTarget.dataset.key;
    wx.showModal({
      title: '申请补卡',
      editable: true,
      placeholderText: '填写补卡原因（忘记打卡/设备没电/在客户现场）',
      success: (r) => {
        if (!r.confirm) return;
        const rs = store.getRuleSet();
        const day = rules.pairDay(store.getRecords(), rs, key, Date.now());
        store.addPatch({
          dateKey: key,
          type: day.inRec && !day.outRec ? 'out' : 'in',
          reason: (r.content || '').trim() || '未填写',
          status: 'pending',
        });
        wx.showToast({ title: '已提交待审核', icon: 'success' });
        try {
          getApp().refreshBadge();
        } catch (err) {
          // ignore
        }
        this.refresh();
      },
    });
  },

  onAddRecord(e) {
    const key = e.currentTarget.dataset.key;
    const rs = store.getRuleSet();
    const day = rules.pairDay(store.getRecords(), rs, key, Date.now());
    const type = !day.inRec ? 'in' : 'out';
    wx.showModal({
      title: '手动补录',
      content: '为 ' + key + ' 补一条「' + (type === 'in' ? '上班' : '下班') + '」记录（使用当前时间）。补录会标记为 manual。',
      confirmText: '补录',
      success: (r) => {
        if (!r.confirm) return;
        const info = rules.shiftOfDay(rs, key);
        store.addRecord({
          type,
          at: Date.now(),
          dateKey: key,
          source: 'manual',
          note: '手动补录',
          shiftId: info.shift ? info.shift.id : null,
          shiftName: info.name,
        });
        wx.showToast({ title: '已补录', icon: 'success' });
        this.refresh();
      },
    });
  },
});

function fmtMin(min) {
  const m = Math.max(0, Math.round(min || 0));
  if (!m) return '—';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? h + 'h' + r + 'm' : h + 'h') : r + 'm';
}

function metaOf(r, rs) {
  const bits = [];
  if (r.source === 'manual') bits.push('手动补录');
  else if (r.source === 'patch') bits.push('审批补卡');
  else if (r.source === 'cloud') bits.push('云端');
  else bits.push('小程序');
  if (r.geoSkipped) bits.push('未定位');
  else if (typeof r.dist === 'number') bits.push('距 ' + Math.round(r.dist) + 'm');
  if (r.wifiSsid) bits.push('WiFi');
  if (r.shiftName) bits.push(r.shiftName);
  return bits.join(' · ');
}
