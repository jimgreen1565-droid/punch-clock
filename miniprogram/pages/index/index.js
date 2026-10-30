const store = require('../../utils/store');
const geo = require('../../utils/geo');
const punch = require('../../utils/punch');
const rules = require('../../core/rules');

const WEEK_TEXT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

Page({
  data: {
    monthDay: '',
    weekText: '',
    clock: '--:--:--',
    ruleTypeName: '',
    ruleDesc: '',
    nextType: 'in',
    nextLabel: '上班打卡',
    btnDone: false,
    tapHint: '点击打卡',
    busy: false,
    busyText: '正在打卡…',
    captionText: '',
    statusLabel: '',
    statusTone: '',
    day: {},
    inText: '--:--',
    outText: '--:--',
    expectInText: '--:--',
    expectOutText: '--:--',
    workText: '—',
    workKey: '今日工时',
    remainText: '—',
    remainKey: '应满工时',
    remainTone: '',
    overText: '—',
    barPercent: 0,
    alerts: [],
    isRest: false,
    geo: {},
    check: null,
    geoOk: false,
    geoStateText: '未校验',
    geoDistText: '',
    geoAccText: '',
    lastPunchText: '',
    canOutside: false,
  },

  onLoad() {
    this.refresh();
    this.startClock();
    this.checkGeo(true);
  },

  onShow() {
    this.refresh();
    if (!this.timer) this.startClock();
  },

  onHide() {
    this.stopClock();
  },

  onUnload() {
    this.stopClock();
  },

  onPullDownRefresh() {
    this.refresh();
    this.checkGeo(true).then(() => wx.stopPullDownRefresh());
  },

  startClock() {
    this.stopClock();
    const tick = () => {
      const d = new Date();
      this.setData({
        clock: rules.pad2(d.getHours()) + ':' + rules.pad2(d.getMinutes()) + ':' + rules.pad2(d.getSeconds()),
      });
      // 每分钟刷新一次统计，保持"剩余工时"真实
      if (!this.lastMinute || this.lastMinute !== d.getMinutes()) {
        this.lastMinute = d.getMinutes();
        this.refresh();
      }
    };
    tick();
    this.timer = setInterval(tick, 1000);
  },

  stopClock() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  refresh() {
    const s = punch.todaySummary();
    const rs = s.ruleSet;
    const now = Date.now();
    const p = rules.partsOf(now);

    // 进度条：已到下班应到时间则为 100%
    let percent = 0;
    if (s.day.inAt) {
      if (s.day.outAt) percent = 100;
      else if (s.day.expectOutAt && s.day.expectInAt) {
        const total = s.day.expectOutAt - s.day.expectInAt;
        const done = now - s.day.inAt;
        percent = total > 0 ? Math.max(0, Math.min(99, Math.round((done / total) * 100))) : 50;
      } else percent = 50;
    }

    // 剩余/应满（按规则类型切换语义）
    let remainText = '—';
    let remainKey = '应满工时';
    let remainTone = '';
    if (rs.type === 'flexible') {
      remainKey = '还需工时';
      if (s.day.inAt) {
        if (s.day.outAt) {
          remainText = '已满';
          remainTone = 'tone-ok';
        } else {
          const left = rules.diffMinutes(s.day.expectOutAt || 0, now);
          // 已过应下班时间但还没打卡：不能再显示「0m」，要明确告诉人「工时够了、只差打卡」
          if (left > 0) {
            remainText = fmtMin(left);
            remainTone = 'tone-warn';
          } else {
            remainText = '工时已满';
            remainTone = 'tone-ok';
          }
        }
      } else {
        remainText = fmtMin(rs.requiredMinutes);
      }
    } else if (rs.type === 'free') {
      remainKey = '目标工时';
      // 自由工时看的是「实际在岗累计」，不是已结算工时：
      // 没打下班卡时 workMinutes 还是 0，用它会一直显示「还可打 8h」，不像真在计时。
      const spanNow = s.day.inAt ? rules.diffMinutes(now, s.day.inAt) : 0;
      const left = Math.max(0, rs.dailyTargetMinutes - spanNow);
      remainText = left > 0 ? fmtMin(left) : '已达目标';
      remainTone = left > 0 ? '' : 'tone-ok';
    } else {
      remainKey = s.isRest ? '休息日' : '应满工时';
      if (s.isRest) {
        remainText = '—';
      } else if (s.day.outAt) {
        remainText = '已打卡';
        remainTone = 'tone-ok';
      } else if (s.day.inAt) {
        // 还没下班：显示还需要在岗多久（到应下班时间为止），不能标"已满"——工时还没落地
        const left = rules.diffMinutes(s.day.expectOutAt || 0, now);
        remainText = left > 0 ? fmtMin(left) : '待下班';
        remainTone = left > 0 ? '' : 'tone-warn';
      } else {
        remainText = fmtMin(s.planMinutes - (rs.breakMinutes || 0));
      }
    }

    // 今日工时：未上班显示占位；已上班未下班显示「已上 X」（在岗时长，不是已结算工时）
    let workText = '—';
    let workKey = '今日工时';
    if (s.day.inAt && s.day.outAt) {
      workText = fmtMin(s.day.workMinutes);
    } else if (s.day.inAt) {
      workText = fmtMin(rules.diffMinutes(now, s.day.inAt));
      workKey = '已上';
    }

    // 异常提示
    const alerts = [];
    if (s.lateText) alerts.push({ label: s.lateText, tone: 'warn' });
    if (s.earlyText) alerts.push({ label: s.earlyText, tone: 'warn' });
    if (s.underText) alerts.push({ label: s.underText, tone: 'warn' });
    if (s.overtimeText) alerts.push({ label: s.overtimeText, tone: 'accent' });
    if (s.day.missingIn) alerts.push({ label: '上班卡未打', tone: 'bad' });
    if (s.day.missingOut) alerts.push({ label: '下班卡未打', tone: 'bad' });

    this.setData({
      monthDay: p.m + '月' + p.d + '日',
      weekText: rules.WEEKDAY_TEXT[p.weekday],
      ruleTypeName: rules.ruleTypeName(rs.type),
      ruleDesc: rules.describeRule(rs),
      nextType: s.nextType,
      nextLabel: s.day.inAt && s.day.outAt ? '已完成' : s.nextType === 'in' ? '上班打卡' : '下班打卡',
      tapHint: s.isRest ? '休息日打卡将记为加班' : '点击打卡',
      captionText: captionOf(s),
      // 首页不把「缺卡」当状态标签：那是待办，已经在下方 alerts 里显式列出，
      // 状态标签只表达「已经发生的结果」（正常/迟到/早退/工时不足/加班/休息）。
      statusLabel: s.day.hasAny && s.status !== 'missing' && s.status !== 'absent' ? s.statusLabel : '',
      btnDone: !!(s.day.inAt && s.day.outAt),
      btnLabel: s.day.inAt && s.day.outAt ? '已完成' : s.nextType === 'in' ? '上班打卡' : '下班打卡',
      tapHint: s.day.inAt && s.day.outAt ? '今日已打完' : s.isRest ? '休息日打卡将记为加班' : '点击打卡',
      statusTone: s.statusTone,
      day: s.day,
      inText: s.inText,
      outText: s.outText,
      expectInText: s.expectInText,
      expectOutText: s.expectOutText,
      workText,
      workKey,
      remainText,
      remainKey,
      remainTone,
      overText: s.day.overtimeMinutes ? fmtMin(s.day.overtimeMinutes) : '—',
      barPercent: percent,
      alerts,
      isRest: s.isRest,
      geo: rs.geo,
      canOutside: rs.geo.enabled && rs.allowOutsideNote,
    });
  },

  async checkGeo(silent) {
    const rs = store.getRuleSet();
    if (!rs.geo.enabled) {
      this.setData({ geoOk: true, geoStateText: '无需定位', check: null, geoDistText: '', geoAccText: '' });
      return null;
    }
    const loc = await geo.getLocation();
    if (!loc.ok) {
      this.setData({ geoOk: false, geoStateText: loc.denied ? '定位权限未开' : '定位失败', check: null });
      if (!silent) this.promptGeoPermission(loc);
      return null;
    }
    const check = geo.inFence({ lat: loc.lat, lng: loc.lng, acc: loc.acc }, { lat: rs.geo.lat, lng: rs.geo.lng, radius: rs.geo.radius });
    this.setData({
      check,
      geoOk: check.ok,
      geoStateText: check.ok ? '已进入范围' : check.reason === 'low-accuracy' ? '精度不足' : '未在范围',
      geoDistText: check.dist !== null ? Math.round(check.dist) + ' 米' : '',
      geoAccText: check.acc !== null ? '±' + Math.round(check.acc) + ' 米' : '',
    });
    return check;
  },

  promptGeoPermission(loc) {
    if (loc.denied) {
      wx.showModal({
        title: '需要位置权限',
        content: '打卡需要核验位置。请在设置中允许「位置信息」后重试。',
        confirmText: '去设置',
        success: (r) => {
          if (r.confirm) wx.openSetting({});
        },
      });
    } else {
      wx.showToast({ title: '定位失败，请到窗边重试', icon: 'none' });
    }
  },

  onRetryGeo() {
    wx.showLoading({ title: '定位中', mask: true });
    this.checkGeo(false).then((c) => {
      wx.hideLoading();
      if (c && c.ok) wx.showToast({ title: '已在范围内', icon: 'success' });
      else wx.showToast({ title: '不在打卡范围', icon: 'none' });
    });
  },

  goRules() {
    wx.navigateTo({ url: '/pages/rules/rules' });
  },

  async onPunch() {
    if (this.data.busy) return;

    // 上下班都打完：不直接写记录，弹确认让用户决定是否补录
    if (this.data.btnDone) {
      wx.showModal({
        title: '今日已完成打卡',
        content: '上班 ' + this.data.inText + ' · 下班 ' + this.data.outText + ' · 工时 ' + this.data.workText + '\n\n如需补一条记录（例如中途外出回来），可以点「补一条」。',
        confirmText: '补一条',
        cancelText: '不用了',
        success: (r) => {
          if (r.confirm) this.doPunchWith({ manual: true });
        },
      });
      return;
    }

    // 必须 return/await：否则 await page.onPunch() 会在打卡完成前就 resolve，
    // 上面的成功处理全变成异步悬空，测试里表现为「toast 为 0、inText 还是 --:--」。
    return this.doPunchWith({});
  },

  async doPunchWith(opts) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    wx.showLoading({ title: '打卡中', mask: true });

    let res;
    try {
      res = await punch.doPunch(opts);
    } catch (e) {
      res = { ok: false, stage: 'exception', message: (e && e.message) || '打卡失败' };
    }
    wx.hideLoading();
    this.setData({ busy: false });

    if (!res.ok) {
      this.handleFail(res);
      return;
    }

    this.lastPunchText = rules.hhmmOf(res.at) + ' · ' + res.title;
    wx.vibrateShort({ type: 'medium' });
    wx.showToast({ title: res.title, icon: 'success', duration: 1800 });
    this.refresh();
    this.checkGeo(true);
  },

  handleFail(res) {
    if (res.stage === 'done') {
      // 理论上已由 onPunch 前置拦截，这里是并发双击等竞态下的兜底
      wx.showToast({ title: '今天已打完卡', icon: 'none' });
      return;
    }
    if (res.stage === 'geo') {
      wx.showModal({
        title: '不在打卡范围',
        content: res.message,
        confirmText: res.canOutOfRange ? '外勤打卡' : '重新定位',
        cancelText: '取消',
        success: (r) => {
          if (!r.confirm) return;
          if (res.canOutOfRange) this.onOutsidePunch();
          else this.onRetryGeo();
        },
      });
      return;
    }
    if (res.stage === 'exception') {
      wx.showModal({
        title: '打卡失败',
        content: res.message + '\n\n没有定位也可以先打卡，记录会标记为「未定位待审核」。',
        confirmText: '先打卡',
        success: (r) => {
          if (r.confirm) this.skipGeoPunch();
        },
      });
      return;
    }
    wx.showToast({ title: res.message || '打卡失败', icon: 'none' });
  },

  /** 外勤打卡：范围外 + 必填备注 */
  onOutsidePunch() {
    wx.showModal({
      title: '外勤打卡',
      editable: true,
      placeholderText: '说明外勤原因，例如「客户现场」「在途中」',
      confirmText: '提交',
      success: async (r) => {
        if (!r.confirm) return;
        const note = (r.content || '').trim();
        if (!note) {
          wx.showToast({ title: '请填写外勤原因', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '打卡中', mask: true });
        const res = await punch.doPunch({ outOfRange: true, note });
        wx.hideLoading();
        if (res.ok) {
          wx.showToast({ title: '外勤已记录', icon: 'success' });
          this.lastPunchText = rules.hhmmOf(res.at) + ' · 外勤打卡';
          this.refresh();
        } else {
          wx.showToast({ title: res.message || '失败', icon: 'none' });
        }
      },
    });
  },

  async skipGeoPunch() {
    wx.showLoading({ title: '打卡中', mask: true });
    const res = await punch.doPunch({ skipGeo: true, note: '未取到定位' });
    wx.hideLoading();
    if (res.ok) {
      wx.showToast({ title: '已记录（待审核）', icon: 'none' });
      this.refresh();
    } else {
      wx.showToast({ title: res.message || '失败', icon: 'none' });
    }
  },
});

function fmtMin(min) {
  const m = Math.max(0, Math.round(min || 0));
  if (!m) return '0m';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? h + 'h' + r + 'm' : h + 'h') : r + 'm';
}

function captionOf(s) {
  const rs = s.ruleSet;
  const now = Date.now();
  if (s.isRest && !s.day.hasAny) return '今天休息，不用打卡';
  if (rs.type === 'free') {
    if (!s.day.hasAny) return '自由工时 · 任何时间都能打卡，按累计工时计';
    const span = s.day.inAt ? rules.diffMinutes(now, s.day.inAt) : 0;
    const target = rs.dailyTargetMinutes;
    if (span >= target) return '自由工时 · 已计时 ' + fmtMin(span) + '，已达目标';
    return '自由工时 · 已计时 ' + fmtMin(span) + '，距目标还差 ' + fmtMin(target - span);
  }
  if (rs.type === 'flexible') {
    if (s.day.outAt) return '今日已完成打卡';
    if (s.day.inAt) {
      const left = rules.diffMinutes(s.day.expectOutAt || 0, now);
      return left > 0 ? '还需 ' + fmtMin(left) + ' 才满工时' : '工时已满，打完下班卡即可';
    }
    return '弹性班 · 最晚 ' + rs.latestStart + ' 上班，每日满 ' + fmtMin(rs.requiredMinutes);
  }
  if (!s.day.inAt) return '班次 ' + (s.dayInfo.shift ? s.dayInfo.shift.start + '-' + s.dayInfo.shift.end : '—');
  if (s.day.outAt) return '今日已完成打卡';
  const left = rules.diffMinutes(s.day.expectOutAt || 0, now);
  return left > 0 ? '已上班 · 还需在岗 ' + fmtMin(left) : '已过下班时间，记得打下班卡';
}
