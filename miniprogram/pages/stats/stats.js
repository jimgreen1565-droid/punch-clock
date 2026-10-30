const store = require('../../utils/store');
const rules = require('../../core/rules');

const WEEK_HEADER = ['一', '二', '三', '四', '五', '六', '日'];

Page({
  data: {
    month: '',
    ruleTypeName: '',
    ruleDesc: '',
    rate: 0,
    planned: 0,
    present: 0,
    abnormal: 0,
    totalDays: 0,
    weekHeader: WEEK_HEADER,
    calendar: [],
    distribution: [],
    workHours: '0h',
    avgHours: '0h',
    otHours: '0h',
    trend: [],
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
    const month = this.data.month;
    const rs = store.getRuleSet();
    const records = store.getRecords();
    const now = Date.now();
    const info = rules.monthInfo(month);
    const todayKey = rules.dayKeyOf(now);

    // 本月每天的判定结果（<= 今天）
    const results = [];
    const byKey = {};
    for (let i = 1; i <= info.days; i++) {
      const dayKey = info.y + '-' + rules.pad2(info.m) + '-' + rules.pad2(i);
      if (dayKey > todayKey) break;
      const day = rules.pairDay(records, rs, dayKey, now);
      results.push(day);
      byKey[dayKey] = day;
    }

    // 应出勤 / 实际 / 异常
    //
    // 出勤率口径按钉钉：实际出勤天数 / 应出勤天数。
    // 「加班」不算异常——加班日往往还是准点到的，把加班算进异常会把出勤率算得很低。
    // 异常单独计数（迟到/早退/工时不足/缺卡/旷工），供右侧展示。
    const workdays = results.filter((d) => !d.restDay);
    const present = workdays.filter((d) => d.inAt).length;
    const abnormal = workdays.filter((d) => ['late', 'early', 'missing', 'absent', 'under'].indexOf(d.status) >= 0).length;
    const rate = workdays.length ? Math.round((present / workdays.length) * 100) : 0;

    // 工时
    const workMin = results.reduce((s, d) => s + d.workMinutes, 0);
    const otMin = results.reduce((s, d) => s + d.overtimeMinutes, 0);
    const daysWithWork = results.filter((d) => d.workMinutes > 0).length;

    // 构成
    const counts = {};
    results.forEach((d) => {
      if (d.restDay && !d.hasAny) return;
      counts[d.status] = (counts[d.status] || 0) + 1;
    });
    const totalDays = Object.keys(counts).reduce((s, k) => s + counts[k], 0);
    const order = ['normal', 'overtime', 'late', 'early', 'under', 'missing', 'absent', 'rest'];
    const distribution = order
      .filter((k) => counts[k])
      .map((k) => {
        const m = rules.statusMeta(k);
        return {
          key: k,
          label: m.label,
          count: counts[k],
          tone: m.tone === 'accent' ? 'accent' : m.tone,
          percent: totalDays ? Math.round((counts[k] / totalDays) * 100) : 0,
        };
      });

    this.setData({
      ruleTypeName: rules.ruleTypeName(rs.type),
      ruleDesc: rules.describeRule(rs),
      rate,
      planned: workdays.length,
      present,
      abnormal,
      totalDays,
      calendar: this.buildCalendar(info, byKey, todayKey, rs),
      distribution,
      workHours: Math.floor(workMin / 60) + 'h',
      avgHours: daysWithWork ? Math.floor(workMin / daysWithWork / 60) + 'h' + (Math.round(workMin / daysWithWork) % 60 ? ' ' + (Math.round(workMin / daysWithWork) % 60) + 'm' : '') : '0h',
      otHours: Math.floor(otMin / 60) + 'h',
      trend: this.buildTrend(rs, records, now),
    });
  },

  buildCalendar(info, byKey, todayKey, rs) {
    const cells = [];
    const firstWeekday = rules.partsOf(rules.msOfDayMinute(info.firstDayKey, 720)).weekday;
    for (let i = 1; i < firstWeekday; i++) cells.push({ idx: 'pad' + i, d: '', cls: '' });

    for (let d = 1; d <= info.days; d++) {
      const dayKey = info.y + '-' + rules.pad2(info.m) + '-' + rules.pad2(d);
      const day = byKey[dayKey];
      let cls = '';
      let dot = false;

      if (dayKey > todayKey) {
        cls = 'future';
      } else if (day) {
        dot = day.hasAny;
        if (day.restDay) cls = day.hasAny ? 'accent' : 'rest';
        else if (['missing', 'absent'].indexOf(day.status) >= 0) cls = 'bad';
        else if (['late', 'early', 'under'].indexOf(day.status) >= 0) cls = 'warn';
        else if (day.status === 'overtime') cls = 'accent';
        else if (day.hasAny) cls = 'ok';
        else cls = 'bad';
      } else {
        const sh = rules.shiftOfDay(rs, dayKey);
        cls = sh.rest ? 'rest' : '';
      }
      if (dayKey === todayKey) cls += ' today';
      cells.push({ idx: dayKey, d, cls: cls.trim(), dot });
    }
    return cells;
  },

  buildTrend(rs, records, now) {
    const out = [];
    const todayKey = rules.dayKeyOf(now);
    for (let i = 6; i >= 0; i--) {
      const dayKey = rules.shiftDayKey(todayKey, -i);
      const d = rules.pairDay(records, rs, dayKey, now);
      let tone = 'ok';
      if (d.restDay) tone = 'mute';
      else if (['missing', 'absent'].indexOf(d.status) >= 0) tone = 'bad';
      else if (['late', 'early', 'under'].indexOf(d.status) >= 0) tone = 'warn';
      out.push({
        dayKey,
        label: dayKey.slice(8),
        v: d.workMinutes ? Math.floor(d.workMinutes / 60) + 'h' : '-',
        h: Math.min(100, Math.round((d.workMinutes / 600) * 100)),
        tone,
      });
    }
    return out;
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
});
