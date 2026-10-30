/* 预览版界面：与 miniprogram/pages/* 交互一致，逻辑全部来自 core-bundle.js */
(function () {
  var R = PC.rules;
  var L = PC.ledger;

  var STORE_KEY = 'pc_preview_v2';
  var WEEK = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var WEEK_SHORT = ['', '一', '二', '三', '四', '五', '六', '日'];

  var state = {
    page: 'index',
    month: R.monthKeyOf(Date.now()),
    expanded: {},
    geo: { ok: true, dist: 118, acc: 24 },
    lastPunchText: '',
  };

  /* ---------------- 数据 ---------------- */

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }

  function save(d) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(d));
    } catch (e) {}
  }

  function seed() {
    var now = Date.now();
    var month = R.monthKeyOf(now);
    var info = R.monthInfo(month);
    var todayKey = R.dayKeyOf(now);
    var rs = R.normalizeRuleSet({});
    var records = [];

    for (var i = 1; i <= info.days; i++) {
      var dayKey = info.y + '-' + R.pad2(info.m) + '-' + R.pad2(i);
      if (dayKey >= todayKey) break;
      if (R.shiftOfDay(rs, dayKey).rest) continue;
      var rnd = (i * 7919) % 100;
      if (rnd < 3) continue; // 偶发缺勤
      // 迟到是少数情况：约 12% 的天数迟到，其余准点或提前
      var inMin = 530 + (rnd % 7);
      if (rnd % 8 === 3) inMin = 545 + (rnd % 12); // 偶尔迟到 5-16 分钟
      var outMin = 1080 + (rnd % 4 === 1 ? 45 : 4 + (rnd % 3));
      if (rnd % 16 === 5) outMin = 1055; // 偶尔早退
      records = L.append(records, mk('in', dayKey, inMin, now), now);
      records = L.append(records, mk('out', dayKey, outMin, now), now);
    }

    // 今天：已上班（08:57），等下班
    var tp = R.partsOf(now);
    if (!R.shiftOfDay(rs, todayKey).rest && tp.minutes > 540) {
      records = L.append(records, mk('in', todayKey, 537 + (tp.d % 3), now), now);
    }

    // 两条异常：范围外 + 未定位
    var dayA = R.shiftDayKey(todayKey, -3);
    var dayB = R.shiftDayKey(todayKey, -4);
    records = L.append(records, {
      uid: 'Upreview', dateKey: dayA, type: 'in', at: R.msOfDayMinute(dayA, 545), clientAt: R.msOfDayMinute(dayA, 545),
      source: 'miniprogram', lat: 39.9142, lng: 116.4051, acc: 34, dist: 838, note: '', patchId: null, geoSkipped: false,
    }, now);
    records = L.append(records, {
      uid: 'Upreview', dateKey: dayB, type: 'out', at: R.msOfDayMinute(dayB, 1125), clientAt: R.msOfDayMinute(dayB, 1125),
      source: 'miniprogram', lat: null, lng: null, acc: null, dist: null, note: '', patchId: null, geoSkipped: true,
    }, now);

    records.forEach(function (r) { r.id = L.makeId(r.uid, r.at, r.seq); });

    return {
      boot: { uid: 'Upreview00001', nickname: '阿伟', env: 'local' },
      ruleSet: R.normalizeRuleSet({}),
      presets: [
        { id: 'PR1', name: '弹性（研发）', ruleSet: R.normalizeRuleSet({ type: 'flexible', latestStart: '10:30', requiredMinutes: 480 }) },
        { id: 'PR2', name: '三班倒（门店）', ruleSet: R.normalizeRuleSet({ type: 'shift', rotation: { enabled: true, cycleDays: 4, slots: ['A', 'A', 'B', 'REST'], anchorDate: todayKey } }) },
      ],
      leaves: [{ id: 'L1', dateKey: month + '-16', kind: 'personal', days: 1 }],
      patches: [
        { id: 'PP1', dateKey: R.shiftDayKey(todayKey, -2), type: 'out', reason: '下班忘打卡，加班到 21 点', status: 'pending', createdAt: now },
        { id: 'PP2', dateKey: R.shiftDayKey(todayKey, -5), type: 'in', reason: '手机没电，到公司后直接开会', status: 'pending', createdAt: now },
      ],
      records: records,
    };
  }

  function mk(type, dayKey, minute, now) {
    var at = R.msOfDayMinute(dayKey, minute);
    return {
      uid: 'Upreview',
      dateKey: dayKey,
      type: type,
      at: at,
      clientAt: at,
      source: 'miniprogram',
      lat: 39.9087 + (Math.random() - 0.5) * 0.0006,
      lng: 116.3972 + (Math.random() - 0.5) * 0.0006,
      acc: 18 + Math.round(Math.random() * 20),
      dist: 40 + Math.round(Math.random() * 220),
      note: '',
      patchId: null,
      geoSkipped: false,
    };
  }

  var db = load() || seed();
  if (!db.ruleSet || !db.ruleSet.type) db = seed();
  save(db);

  function rs() {
    return R.normalizeRuleSet(db.ruleSet);
  }

  /* ---------------- DOM & 工具 ---------------- */

  var body = document.getElementById('body');
  var toastEl = null;

  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.querySelector('.phone').appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  function h(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtMin(min) {
    var m = Math.max(0, Math.round(min || 0));
    if (!m) return '0m';
    var hh = Math.floor(m / 60);
    var r = m % 60;
    return hh ? (r ? hh + 'h' + r + 'm' : hh + 'h') : r + 'm';
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;');
  }

  /* ---------------- 首页 ---------------- */

  function renderIndex() {
    var s = summary();
    var now = Date.now();
    var p = R.partsOf(now);
    var r = rs();

    var percent = 0;
    if (s.day.inAt) {
      if (s.day.outAt) percent = 100;
      else if (s.day.expectOutAt && s.day.expectInAt) {
        var total = s.day.expectOutAt - s.day.expectInAt;
        var done = now - s.day.inAt;
        percent = total > 0 ? Math.max(0, Math.min(99, Math.round((done / total) * 100))) : 50;
      } else percent = 50;
    }

    var remainText = '—';
    var remainKey = '应满工时';
    var remainTone = '';
    if (r.type === 'flexible') {
      remainKey = '还需工时';
      if (s.day.inAt) {
        if (s.day.outAt) { remainText = '已满'; remainTone = 'tone-ok'; }
        else { var left = R.diffMinutes(s.day.expectOutAt || 0, now); if (left > 0) { remainText = fmtMin(left); remainTone = 'tone-warn'; } else { remainText = '工时已满'; remainTone = 'tone-ok'; } }
      } else remainText = fmtMin(r.requiredMinutes);
    } else if (r.type === 'free') {
      remainKey = '目标工时';
      var spanNow = s.day.inAt ? R.diffMinutes(now, s.day.inAt) : 0;
      var left2 = Math.max(0, r.dailyTargetMinutes - spanNow);
      remainText = left2 > 0 ? fmtMin(left2) : '已达目标';
      remainTone = left2 > 0 ? '' : 'tone-ok';
    } else {
      remainKey = s.isRest ? '休息日' : '应满工时';
      if (s.isRest) {
        remainText = '—';
      } else if (s.day.outAt) {
        remainText = '已打卡';
        remainTone = 'tone-ok';
      } else if (s.day.inAt) {
        var left3 = R.diffMinutes(s.day.expectOutAt || 0, now);
        remainText = left3 > 0 ? fmtMin(left3) : '待下班';
        remainTone = left3 > 0 ? '' : 'tone-warn';
      } else remainText = fmtMin(s.planMinutes - (r.breakMinutes || 0));
    }

    var alerts = [];
    if (s.lateText) alerts.push({ label: s.lateText, tone: 'warn' });
    if (s.earlyText) alerts.push({ label: s.earlyText, tone: 'warn' });
    if (s.underText) alerts.push({ label: s.underText, tone: 'warn' });
    if (s.overtimeText) alerts.push({ label: s.overtimeText, tone: 'accent' });
    if (s.day.missingIn) alerts.push({ label: '上班卡未打', tone: 'bad' });
    if (s.day.missingOut) alerts.push({ label: '下班卡未打', tone: 'bad' });

    var html = '';
    html += '<div class="page">';

    // 头部
    html += '<div class="hero"><div><div class="hero-date">' + p.m + '月' + p.d + '日</div>';
    html += '<div class="hero-week">' + WEEK[p.weekday] + (s.isRest ? '<span class="tag tag-mute rest-tag">休息日</span>' : '') + '</div></div>';
    html += '<div class="rule-chip" data-go="rules"><span class="chip-dot"></span><span>' + R.ruleTypeName(r.type) + '</span><span class="chip-arrow">›</span></div></div>';
    html += '<div class="rule-line" data-go="rules">' + h(R.describeRule(r)) + '</div>';

    // 打卡按钮
    html += '<div class="punch-zone"><div class="halo halo-' + s.nextType + '"></div>';
    html += '<div class="punch-btn btn-' + s.nextType + '" id="punch"><div class="btn-time" id="clock">--:--:--</div>';
    html += '<div class="btn-label">' + (s.nextType === 'in' ? '上班打卡' : '下班打卡') + '</div>';
    html += '<div class="btn-hint">' + (s.isRest ? '休息日打卡将记为加班' : '点击打卡') + '</div></div>';
    html += '<div class="punch-caption">' + (s.day.hasAny && s.status !== 'missing' && s.status !== 'absent' ? '<span class="tag tag-' + s.statusTone + '">' + s.statusLabel + '</span>' : '') + '<span class="caption-text">' + h(captionOf(s)) + '</span></div></div>';

    // 时间轴
    html += '<div class="card tl-card"><div class="tl">';
    html += '<div class="tl-node"><div class="tl-mark ' + (s.day.inAt ? 'done' : '') + '"><span class="tl-dot"></span></div>';
    html += '<div class="tl-info"><div class="tl-what">上班</div><div class="tl-when ' + (s.day.inAt ? 'strong' : '') + '">' + s.inText + '</div><div class="tl-plan">应到 ' + s.expectInText + '</div></div></div>';
    html += '<div class="tl-line"><div class="tl-line-fill" style="width:' + percent + '%"></div></div>';
    html += '<div class="tl-node right"><div class="tl-mark ' + (s.day.outAt ? 'done' : '') + '"><span class="tl-dot"></span></div>';
    html += '<div class="tl-info"><div class="tl-what">下班</div><div class="tl-when ' + (s.day.outAt ? 'strong' : '') + '">' + s.outText + '</div><div class="tl-plan">应到 ' + s.expectOutText + '</div></div></div>';
    html += '</div><div class="divider"></div>';
    html += '<div class="metrics"><div class="metric"><div class="m-val">' + (s.day.inAt ? fmtMin(s.day.outAt ? s.day.workMinutes : R.diffMinutes(now, s.day.inAt)) : '—') + '</div><div class="m-key">' + (s.day.outAt ? '今日工时' : '已上') + '</div></div>';
    html += '<div class="m-sep"></div><div class="metric"><div class="m-val ' + remainTone + '">' + remainText + '</div><div class="m-key">' + remainKey + '</div></div>';
    html += '<div class="m-sep"></div><div class="metric"><div class="m-val">' + (s.day.overtimeMinutes ? fmtMin(s.day.overtimeMinutes) : '—') + '</div><div class="m-key">加班</div></div></div>';
    if (alerts.length) {
      html += '<div class="alerts">';
      alerts.forEach(function (a) {
        html += '<div class="alert alert-' + a.tone + '"><span class="alert-dot"></span><span>' + h(a.label) + '</span></div>';
      });
      html += '</div>';
    }
    html += '</div>';

    // 打卡范围
    html += '<div class="card geo-card"><div class="geo-head"><div><span class="geo-name">' + h(r.geo.name) + '</span><span class="geo-sub">范围 ' + r.geo.radius + ' 米</span></div>';
    var geoOk = state.geo.ok;
    html += '<div class="geo-state ' + (r.geo.enabled ? (geoOk ? 'ok' : 'bad') : 'ok') + '"><span class="geo-dot"></span><span>' + (r.geo.enabled ? (geoOk ? '已进入范围' : '未在范围') : '无需定位') + '</span></div></div>';
    if (r.geo.enabled) {
      html += '<div class="geo-row"><span class="geo-k">距打卡点</span><span class="geo-v">' + state.geo.dist + ' 米</span></div>';
      html += '<div class="geo-row"><span class="geo-k">定位精度</span><span class="geo-v">±' + state.geo.acc + ' 米</span></div>';
    }
    if (state.lastPunchText) html += '<div class="geo-row"><span class="geo-k">最近一次</span><span class="geo-v">' + h(state.lastPunchText) + '</span></div>';
    html += '<div class="geo-actions"><button class="geo-btn" id="regeo">重新定位</button>';
    if (r.geo.enabled && r.allowOutsideNote) html += '<button class="geo-btn" id="outside">外勤打卡</button>';
    html += '</div></div>';

    html += '<div class="muted" style="text-align:center;color:#97a3b8;font-size:11px;margin-top:12px;padding:0 18px">打卡记录写入哈希链，任何改动都能在「记录」页校验出来</div>';
    html += '</div>';

    body.innerHTML = html;

    var punchBtn = document.getElementById('punch');
    if (punchBtn) punchBtn.onclick = doPunch;
    var regeo = document.getElementById('regeo');
    if (regeo) regeo.onclick = function () {
      state.geo = { ok: true, dist: 50 + Math.round(Math.random() * 240), acc: 16 + Math.round(Math.random() * 18) };
      toast('已重新定位，距打卡点 ' + state.geo.dist + ' 米');
      render();
    };
    var outside = document.getElementById('outside');
    if (outside) outside.onclick = function () {
      state.geo = { ok: false, dist: 420 + Math.round(Math.random() * 300), acc: 32 };
      toast('已切换为外勤模式（' + state.geo.dist + ' 米），点打卡将标记待审核');
      render();
    };
    body.querySelectorAll('[data-go]').forEach(function (el) {
      el.onclick = function () { state.page = el.getAttribute('data-go'); render(); };
    });

    tickClock();
  }

  function tickClock() {
    var el = document.getElementById('clock');
    if (!el) return;
    var d = new Date();
    el.textContent = R.pad2(d.getHours()) + ':' + R.pad2(d.getMinutes()) + ':' + R.pad2(d.getSeconds());
    if (state.page === 'index') setTimeout(tickClock, 1000);
  }

  function summary() {
    var now = Date.now();
    var r = rs();
    var records = db.records;
    var dayKey = R.resolveShiftDay(now, r);
    var day = R.pairDay(records, r, dayKey, now);
    var dayInfo = R.shiftOfDay(r, dayKey);
    var planMinutes = r.type === 'flexible' ? r.requiredMinutes : r.type === 'free' ? r.dailyTargetMinutes : dayInfo.shift ? dayInfo.shift.endMin - dayInfo.shift.startMin : 0;
    var meta = R.statusMeta(day.status);
    return {
      day: day,
      dayInfo: dayInfo,
      nextType: !day.inRec ? 'in' : !day.outRec ? 'out' : 'in',
      planMinutes: planMinutes,
      isRest: day.restDay,
      statusLabel: meta.label,
      status: day.status,
      statusTone: meta.tone,
      inText: day.inAt ? R.hhmmOf(day.inAt) : '--:--',
      outText: day.outAt ? R.hhmmOf(day.outAt) : '--:--',
      expectInText: day.expectInAt ? R.hhmmOf(day.expectInAt) : '--:--',
      expectOutText: day.expectOutAt ? R.hhmmOf(day.expectOutAt) : '--:--',
      lateText: day.lateMinutes > 0 ? '迟到 ' + day.lateMinutes + ' 分钟' : '',
      earlyText: day.earlyMinutes > 0 ? '早退 ' + day.earlyMinutes + ' 分钟' : '',
      underText: day.shortMinutes > 0 ? '工时不足 ' + day.shortMinutes + ' 分钟' : '',
      overtimeText: day.overtimeMinutes > 0 ? '加班 ' + day.overtimeMinutes + ' 分钟' : '',
    };
  }

  function captionOf(s) {
    var r = rs();
    var nw = Date.now();
    if (s.isRest && !s.day.hasAny) return '今天休息，不用打卡';
    if (r.type === 'free') {
      if (!s.day.hasAny) return '自由工时 · 任何时间都能打卡，按累计工时计';
      var span = s.day.inAt ? R.diffMinutes(nw, s.day.inAt) : 0;
      var target = r.dailyTargetMinutes;
      if (span >= target) return '自由工时 · 已计时 ' + fmtMin(span) + '，已达目标';
      return '自由工时 · 已计时 ' + fmtMin(span) + '，距目标还差 ' + fmtMin(target - span);
    }
    if (r.type === 'flexible') {
      if (s.day.outAt) return '今日已完成打卡';
      if (s.day.inAt) {
        var lf = R.diffMinutes(s.day.expectOutAt || 0, nw);
        return lf > 0 ? '还需 ' + fmtMin(lf) + ' 才满工时' : '工时已满，打完下班卡即可';
      }
      return '弹性班 · 最晚 ' + r.latestStart + ' 上班，每日满 ' + fmtMin(r.requiredMinutes);
    }
    if (!s.day.inAt) return '班次 ' + (s.dayInfo.shift ? s.dayInfo.shift.start + '-' + s.dayInfo.shift.end : '—');
    if (s.day.outAt) return '今日已完成打卡';
    var lf2 = R.diffMinutes(s.day.expectOutAt || 0, nw);
    return lf2 > 0 ? '已上班 · 还需在岗 ' + fmtMin(lf2) : '已过下班时间，记得打下班卡';
  }

  function doPunch() {
    var now = Date.now();
    var r = rs();
    var dayKey = R.resolveShiftDay(now, r);
    var day = R.pairDay(db.records, r, dayKey, now);
    var type = !day.inRec ? 'in' : 'out';
    var info = R.shiftOfDay(r, dayKey);
    var graded = R.classifyPunch({ ms: now, type: type, dayKey: dayKey, ruleSet: r });

    var outOfRange = r.geo.enabled && !state.geo.ok;
    if (outOfRange && r.geo.strict && !r.allowOutsideNote) {
      toast('不在打卡范围，无法打卡（规则为严格模式）');
      return;
    }

    var rec = {
      uid: db.boot.uid,
      dateKey: dayKey,
      type: type,
      at: now,
      clientAt: now,
      source: 'miniprogram',
      lat: r.geo.lat + 0.0004,
      lng: r.geo.lng - 0.0003,
      acc: state.geo.acc,
      dist: outOfRange ? state.geo.dist : state.geo.dist,
      note: outOfRange ? '外勤打卡' : '',
      patchId: null,
      geoSkipped: !r.geo.enabled,
      shiftId: info.shift ? info.shift.id : null,
      shiftName: info.name,
    };
    db.records = L.append(db.records, rec, now);
    var written = db.records[db.records.length - 1];
    written.id = L.makeId(db.boot.uid, now, written.seq);
    save(db);

    var title = outOfRange ? '外勤打卡' : graded.restDay ? (type === 'in' ? '休息日到岗' : '休息日下班') : type === 'in' ? (graded.status === 'late' ? '迟到打卡' : '上班打卡') : graded.status === 'early' ? '早退打卡' : graded.status === 'under' ? '工时不足' : '下班打卡';
    state.lastPunchText = R.hhmmOf(now) + ' · ' + title;
    toast(title + ' ' + R.hhmmssOf(now) + ' · 哈希 ' + written.hash.slice(0, 12) + '…');
    render();
  }

  /* ---------------- 规则页 ---------------- */

  function renderRules() {
    var r = rs();
    var types = R.RULE_TYPES;

    var html = '<div class="page">';
    html += '<div class="card current"><div class="cur-top"><span class="cur-badge">' + R.ruleTypeName(r.type) + '</span><span class="cur-name">' + h(r.name) + '</span></div>';
    html += '<div class="cur-desc">' + h(R.describeRule(r)) + '</div></div>';

    html += '<div class="section-label">选择考勤规则</div><div class="options">';
    types.forEach(function (t) {
      var active = t.id === r.type;
      html += '<div class="option ' + (active ? 'active' : '') + '" data-type="' + t.id + '">';
      html += '<div class="opt-radio">' + (active ? '<div class="opt-radio-fill"></div>' : '') + '</div>';
      html += '<div class="opt-body"><div class="opt-head"><span class="opt-name">' + t.name + '</span><span class="opt-tag">' + t.tag + '</span></div>';
      html += '<div class="opt-desc">' + t.desc + '</div><div class="opt-detail">' + t.detail + '</div></div></div>';
    });
    html += '</div>';

    html += '<div class="section-label">规则参数</div><div class="card">';
    if (r.type === 'fixed') {
      html += row('上班时间', r.start);
      html += row('下班时间', r.end);
      html += row('工作日', R.weekdaysText(r.weekdays));
      html += row('午休时段', r.breakStart ? r.breakStart + '-' + r.breakEnd : '未设置');
      html += row('迟到宽限', r.lateGrace + ' 分钟');
    } else if (r.type === 'flexible') {
      html += row('最晚上班', r.latestStart);
      html += row('最早下班', r.earliestEnd);
      html += row('每日应满工时', R.fmtMinuteText(r.requiredMinutes));
      html += row('工作日', R.weekdaysText(r.weekdays));
      html += row('午休（不计工时）', r.breakStart ? r.breakStart + '-' + r.breakEnd : '未设置');
    } else if (r.type === 'shift') {
      html += row('周期轮换', r.rotation.enabled ? '已开启' : '未开启');
      if (r.rotation.enabled) {
        html += row('轮换周期', r.rotation.cycleDays + ' 天');
        html += row('班次顺序', r.rotation.slots.map(R.slotName(r)).join(' → '));
      } else {
        html += row('上班时间', r.start);
        html += row('下班时间', r.end);
      }
      html += row('工作日', R.weekdaysText(r.weekdays));
    } else {
      html += row('每日目标工时', R.fmtMinuteText(r.dailyTargetMinutes));
      html += row('判定方式', '<span class="v dim">不判迟到早退</span>');
    }
    html += '</div>';

    html += '<div class="section-label">打卡方式</div><div class="card">';
    html += '<div class="row"><span class="k">位置校验</span><span class="v">' + (r.geo.enabled ? '已开启' : '已关闭') + '</span></div>';
    if (r.geo.enabled) {
      html += '<div class="row"><span class="k">打卡点</span><span class="v mono" style="color:#5b6b85">' + r.geo.lat.toFixed(5) + ', ' + r.geo.lng.toFixed(5) + '</span></div>';
      html += row('范围半径', r.geo.radius + ' 米');
      html += row('范围外打卡', r.geo.strict ? '禁止' : '允许（填外勤原因）');
    }
    html += '</div>';

    html += '<div class="section-label">规则模板</div><div class="card">';
    if (!db.presets.length) html += '<div class="muted" style="padding:4px 0 10px">还没有保存的模板。保存后可一键切换。</div>';
    db.presets.forEach(function (p) {
      html += '<div class="dt-row" style="padding:8px 0"><div class="dt-mid" style="margin-left:0"><div class="dt-time" style="font-size:13px">' + h(p.name) + '</div>';
      html += '<div class="dt-meta">' + R.ruleTypeName(p.ruleSet.type) + ' · ' + h(R.describeRule(p.ruleSet)) + '</div></div>';
      html += '<span class="dt-link" data-apply="' + escapeAttr(p.id) + '">应用</span></div>';
    });
    html += '<button class="btn" id="savepreset">保存当前规则为模板</button></div>';

    html += '<div class="muted" style="text-align:center;font-size:11px;margin-top:12px;padding:0 20px;line-height:1.8">切换规则后今天的判定按新规则重算，但已产生的打卡记录不会被改写</div>';
    html += '</div>';

    body.innerHTML = html;

    body.querySelectorAll('[data-type]').forEach(function (el) {
      el.onclick = function () {
        var t = el.getAttribute('data-type');
        if (t === rs().type) return;
        db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { type: t }));
        save(db);
        toast('已切换为 ' + R.ruleTypeName(t));
        render();
      };
    });
    body.querySelectorAll('[data-apply]').forEach(function (el) {
      el.onclick = function () {
        var id = el.getAttribute('data-apply');
        var p = db.presets.find(function (x) { return x.id === id; });
        if (!p) return;
        db.ruleSet = R.normalizeRuleSet(p.ruleSet);
        save(db);
        toast('已应用模板：' + p.name);
        render();
      };
    });
    var sp = document.getElementById('savepreset');
    if (sp) {
      sp.onclick = function () {
        var name = R.ruleTypeName(rs().type);
        db.presets.unshift({ id: 'PR' + Date.now().toString(36), name: name, ruleSet: rs() });
        save(db);
        toast('已保存模板：' + name);
        render();
      };
    }
  }

  function row(k, v) {
    return '<div class="row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
  }

  /* ---------------- 记录页 ---------------- */

  function renderRecords() {
    var r = rs();
    var now = Date.now();
    var todayKey = R.dayKeyOf(now);
    var month = state.month;
    var info = R.monthInfo(month);
    var chain = L.verifyChain(db.records);

    // 汇总
    var present = 0, abnormal = 0, workMin = 0, otMin = 0, planned = 0;
    var byKey = {};
    for (var i = 1; i <= info.days; i++) {
      var dk = info.y + '-' + R.pad2(info.m) + '-' + R.pad2(i);
      if (dk > todayKey) break;
      var d = R.pairDay(db.records, r, dk, now);
      byKey[dk] = d;
      if (!d.restDay) planned += 1;
      if (d.inAt) present += 1;
      if (['late', 'early', 'missing', 'absent', 'under'].indexOf(d.status) >= 0) abnormal += 1;
      workMin += d.workMinutes;
      otMin += d.overtimeMinutes;
    }

    // 周历条
    var todayWeekday = R.partsOf(now).weekday;
    var monday = R.shiftDayKey(todayKey, -(todayWeekday - 1));
    var strip = '';
    for (var w = 0; w < 7; w++) {
      var wdk = R.shiftDayKey(monday, w);
      var wd = R.pairDay(db.records, r, wdk, now);
      var tone = '';
      if (wdk <= todayKey && !wd.restDay) {
        if (['missing', 'absent'].indexOf(wd.status) >= 0) tone = 'bad';
        else if (['late', 'early', 'under'].indexOf(wd.status) >= 0) tone = 'warn';
        else if (wd.hasAny) tone = 'ok';
        else if (wdk < todayKey) tone = 'bad';
      } else if (wd.restDay) tone = 'mute';
      strip += '<div class="wb-day ' + (wdk === todayKey ? 'today' : '') + '"><span class="wb-w">' + WEEK_SHORT[w + 1] + '</span><span class="wb-d">' + Number(wdk.slice(8)) + '</span>' + (tone ? '<span class="wb-dot wb-' + tone + '"></span>' : '') + '</div>';
    }

    // 日列表
    var daysHtml = '';
    var shown = 0;
    for (var j = info.days; j >= 1; j--) {
      var dayKey = info.y + '-' + R.pad2(info.m) + '-' + R.pad2(j);
      if (dayKey > todayKey) continue;
      var day = byKey[dayKey];
      if (day.restDay && !day.hasAny) continue;
      shown++;
      var meta = R.statusMeta(day.status);
      var open = state.expanded[dayKey];
      var recs = db.records.filter(function (x) { return x.dateKey === dayKey; });

      daysHtml += '<div class="day" data-day="' + dayKey + '"><div class="day-main"><div class="day-left">';
      daysHtml += '<div class="day-date"><span class="dd-num">' + R.pad2(j) + '</span><span class="dd-week">' + WEEK[R.partsOf(R.msOfDayMinute(dayKey, 720)).weekday] + '</span></div>';
      daysHtml += '<div class="day-tags"><span class="tag tag-' + meta.tone + '">' + meta.label + '</span>';
      if (r.type === 'shift' && day.shiftName) daysHtml += '<span class="tag tag-brand">' + h(day.shiftName) + '</span>';
      if (recs.some(function (x) { return x.geoSkipped; })) daysHtml += '<span class="tag tag-bad">外勤</span>';
      daysHtml += '</div></div><div class="day-right"><div class="day-times">' + (day.inAt ? R.hhmmOf(day.inAt) : '--:--') + '<span class="dash">–</span>' + (day.outAt ? R.hhmmOf(day.outAt) : '--:--') + '</div>';
      daysHtml += '<div class="day-work">' + (day.workMinutes ? fmtMin(day.workMinutes) : '—') + '</div></div></div>';

      if (open) {
        daysHtml += '<div class="day-detail">';
        if (!recs.length) daysHtml += '<div class="muted" style="padding:4px 0">当天没有打卡记录</div>';
        recs.forEach(function (x) {
          var bits = [x.source === 'manual' ? '手动补录' : x.source === 'patch' ? '审批补卡' : '小程序'];
          if (x.geoSkipped) bits.push('未定位');
          else if (typeof x.dist === 'number') bits.push('距 ' + Math.round(x.dist) + 'm');
          if (x.shiftName) bits.push(x.shiftName);
          daysHtml += '<div class="dt-row"><span class="dt-type ' + x.type + '">' + (x.type === 'in' ? '上班' : '下班') + '</span>';
          daysHtml += '<div class="dt-mid"><div class="dt-time">' + R.hhmmssOf(x.at) + '</div><div class="dt-meta">' + h(bits.join(' · ')) + '</div></div>';
          daysHtml += '<span class="dt-hash">' + (x.hash || '').slice(0, 10) + '</span></div>';
        });
        daysHtml += '<div class="dt-actions"><span class="dt-link" data-patch="' + dayKey + '">申请补卡</span><span class="dt-link" data-add="' + dayKey + '">手动补录</span></div>';
        daysHtml += '</div>';
      }
      daysHtml += '</div>';
    }

    var html = '<div class="page">';
    html += '<div class="monthbar"><div class="mb-side" data-nav="-1">‹</div><div class="mb-center"><span class="mb-month">' + month + '</span><span class="mb-arrow" data-go="stats">统计 ›</span></div><div class="mb-side" data-nav="1">›</div></div>';

    html += '<div class="card summary"><div class="sum-row">';
    html += '<div class="sum-item"><div class="sum-val">' + present + '</div><div class="sum-key">出勤</div></div>';
    html += '<div class="sum-item"><div class="sum-val warn">' + abnormal + '</div><div class="sum-key">异常</div></div>';
    html += '<div class="sum-item"><div class="sum-val">' + Math.floor(workMin / 60) + 'h</div><div class="sum-key">工时</div></div>';
    html += '<div class="sum-item"><div class="sum-val accent">' + Math.floor(otMin / 60) + 'h</div><div class="sum-key">加班</div></div>';
    html += '</div></div>';

    html += '<div class="chain ' + (chain.ok ? 'ok' : 'bad') + '" id="verify"><div class="chain-icon">' + (chain.ok ? '✓' : '!') + '</div>';
    html += '<div><div class="chain-title">' + (chain.ok ? '记录完整' : '记录被改动') + '</div>';
    html += '<div class="chain-sub">' + (chain.ok ? chain.count + ' 条记录完整，最近 ' + (db.records.length ? db.records[db.records.length - 1].hash.slice(0, 16) + '…' : '—') : '第 ' + ((chain.brokenAt || 0) + 1) + ' 条校验失败（' + chain.reason + '）') + '</div></div>';
    html += '<span class="chain-more">校验 ›</span></div>';

    html += '<div class="weekbar">' + strip + '</div>';
    if (!shown) html += '<div class="empty">本月还没有打卡记录</div>';
    html += daysHtml;
    html += '<div class="muted" style="text-align:center;font-size:11px;margin-top:12px;padding:0 20px;line-height:1.8">每条记录都带哈希与前一条的链尾，改动任一条都会被校验发现</div>';
    html += '</div>';

    body.innerHTML = html;

    body.querySelectorAll('[data-nav]').forEach(function (el) {
      el.onclick = function () {
        var delta = Number(el.getAttribute('data-nav'));
        var seg = state.month.split('-').map(Number);
        var nd = new Date(Date.UTC(seg[0], seg[1] - 1 + delta, 1));
        var nextKey = nd.getUTCFullYear() + '-' + R.pad2(nd.getUTCMonth() + 1);
        if (nextKey > R.monthKeyOf(Date.now())) return;
        state.month = nextKey;
        render();
      };
    });
    body.querySelectorAll('[data-day]').forEach(function (el) {
      el.onclick = function (ev) {
        if (ev.target && /dt-link/.test(ev.target.className)) return;
        var k = el.getAttribute('data-day');
        state.expanded[k] = !state.expanded[k];
        render();
      };
    });
    var verify = document.getElementById('verify');
    if (verify) verify.onclick = function () {
      var c = L.verifyChain(db.records);
      toast(c.ok ? '校验通过：' + c.count + ' 条记录完整' : '校验失败：第 ' + ((c.brokenAt || 0) + 1) + ' 条被改动（' + c.reason + '）');
    };
    body.querySelectorAll('[data-patch]').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        var k = el.getAttribute('data-patch');
        var d = R.pairDay(db.records, rs(), k, Date.now());
        var type = d.inRec && !d.outRec ? 'out' : 'in';
        db.patches.push({ id: 'P' + Date.now().toString(36), dateKey: k, type: type, reason: '忘记打卡', status: 'pending', createdAt: Date.now() });
        save(db);
        toast('已提交补卡申请，待审核');
        render();
      };
    });
    body.querySelectorAll('[data-add]').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        var k = el.getAttribute('data-add');
        addManual(k);
      };
    });
    body.querySelectorAll('[data-go]').forEach(function (el) {
      el.onclick = function () { state.page = el.getAttribute('data-go'); render(); };
    });
  }

  function addManual(dayKey) {
    var r = rs();
    var d = R.pairDay(db.records, r, dayKey, Date.now());
    var type = !d.inRec ? 'in' : 'out';
    var info = R.shiftOfDay(r, dayKey);
    db.records = L.append(db.records, {
      uid: db.boot.uid, dateKey: dayKey, type: type, at: Date.now(), clientAt: Date.now(),
      source: 'manual', lat: null, lng: null, acc: null, dist: null, note: '手动补录', patchId: null,
      geoSkipped: true, shiftId: info.shift ? info.shift.id : null, shiftName: info.name,
    }, Date.now());
    db.records[db.records.length - 1].id = L.makeId(db.boot.uid, Date.now(), db.records[db.records.length - 1].seq);
    save(db);
    toast('已补录 ' + dayKey + ' ' + (type === 'in' ? '上班' : '下班'));
    render();
  }

  /* ---------------- 统计页 ---------------- */

  function renderStats() {
    var r = rs();
    var now = Date.now();
    var todayKey = R.dayKeyOf(now);
    var month = state.month || R.monthKeyOf(now);
    var info = R.monthInfo(month);
    var results = [];
    var byKey = {};
    for (var i = 1; i <= info.days; i++) {
      var dk = info.y + '-' + R.pad2(info.m) + '-' + R.pad2(i);
      if (dk > todayKey) break;
      var d = R.pairDay(db.records, r, dk, now);
      results.push(d);
      byKey[dk] = d;
    }
    var workdays = results.filter(function (x) { return !x.restDay; });
    var present = workdays.filter(function (x) { return x.inAt; }).length;
    var abnormal = workdays.filter(function (x) { return ['late', 'early', 'missing', 'absent', 'under'].indexOf(x.status) >= 0; }).length;
    var rate = workdays.length ? Math.round((present / workdays.length) * 100) : 0;
    var workMin = results.reduce(function (s, x) { return s + x.workMinutes; }, 0);
    var otMin = results.reduce(function (s, x) { return s + x.overtimeMinutes; }, 0);
    var withWork = results.filter(function (x) { return x.workMinutes > 0; }).length;

    var counts = {};
    results.forEach(function (x) {
      if (x.restDay && !x.hasAny) return;
      counts[x.status] = (counts[x.status] || 0) + 1;
    });
    var totalDays = Object.keys(counts).reduce(function (s, k) { return s + counts[k]; }, 0);
    var order = ['normal', 'overtime', 'late', 'early', 'under', 'missing', 'absent', 'rest'];
    var dist = '';
    order.forEach(function (k) {
      if (!counts[k]) return;
      var m = R.statusMeta(k);
      var tone = m.tone === 'accent' ? 'accent' : m.tone;
      var pct = totalDays ? Math.round((counts[k] / totalDays) * 100) : 0;
      dist += '<div class="dist"><div class="dist-left"><span class="dist-label">' + m.label + '</span><span class="dist-count">' + counts[k] + '</span></div>';
      dist += '<div class="dist-track"><div class="dist-fill dist-' + tone + '" style="width:' + pct + '%"></div></div></div>';
    });

    // 日历
    var firstWeekday = R.partsOf(R.msOfDayMinute(info.firstDayKey, 720)).weekday;
    var cells = '';
    for (var p0 = 1; p0 < firstWeekday; p0++) cells += '<div class="cell"></div>';
    for (var dgn = 1; dgn <= info.days; dgn++) {
      var k2 = info.y + '-' + R.pad2(info.m) + '-' + R.pad2(dgn);
      var dayObj = byKey[k2];
      var cls = '';
      var dot = '';
      if (k2 > todayKey) cls = 'future';
      else if (dayObj) {
        if (dayObj.restDay) cls = dayObj.hasAny ? 'accent' : 'rest';
        else if (['missing', 'absent'].indexOf(dayObj.status) >= 0) cls = 'bad';
        else if (['late', 'early', 'under'].indexOf(dayObj.status) >= 0) cls = 'warn';
        else if (dayObj.status === 'overtime') cls = 'accent';
        else if (dayObj.hasAny) cls = 'ok';
        else cls = 'bad';
        if (dayObj.hasAny) dot = '<span class="cell-dot"></span>';
      } else {
        var sh = R.shiftOfDay(r, k2);
        cls = sh.rest ? 'rest' : '';
      }
      if (k2 === todayKey) cls += ' today';
      cells += '<div class="cell ' + cls.trim() + '"><span class="cell-d">' + dgn + '</span>' + dot + '</div>';
    }

    // 近 7 日
    var bars = '';
    for (var t = 6; t >= 0; t--) {
      var dk2 = R.shiftDayKey(todayKey, -t);
      var d2 = R.pairDay(db.records, r, dk2, now);
      var tone2 = 'ok';
      if (d2.restDay) tone2 = 'mute';
      else if (['missing', 'absent'].indexOf(d2.status) >= 0) tone2 = 'bad';
      else if (['late', 'early', 'under'].indexOf(d2.status) >= 0) tone2 = 'warn';
      bars += '<div class="bar-wrap"><div class="bar-track"><div class="bar-fill bar-' + tone2 + '" style="height:' + Math.min(100, Math.round((d2.workMinutes / 600) * 100)) + '%"></div></div>';
      bars += '<span class="bar-v">' + (d2.workMinutes ? Math.floor(d2.workMinutes / 60) + 'h' : '-') + '</span><span class="bar-l">' + dk2.slice(8) + '</span></div>';
    }

    var html = '<div class="page">';
    html += '<div class="monthbar"><div class="mb-side" data-nav="-1">‹</div><div class="mb-center"><span class="mb-month">' + month + '</span><span class="mb-arrow">' + R.ruleTypeName(r.type) + '</span></div><div class="mb-side" data-nav="1">›</div></div>';

    html += '<div class="hero-card"><div class="hero-main"><div class="hero-num">' + rate + '<span class="hero-unit">%</span></div><div class="hero-label">出勤率 · 按有上班卡天数</div></div>';
    html += '<div class="hero-side"><div class="hs-row"><span class="hs-k">应出勤</span><span class="hs-v">' + workdays.length + ' 天</span></div>';
    html += '<div class="hs-row"><span class="hs-k">实际打卡</span><span class="hs-v">' + present + ' 天</span></div>';
    html += '<div class="hs-row"><span class="hs-k">有异常</span><span class="hs-v warn">' + abnormal + ' 天</span></div></div></div>';

    html += '<div class="card"><div class="card-title"><span>日历</span><span class="sub">' + month + '</span></div>';
    html += '<div class="grid-hd"><span class="gh">一</span><span class="gh">二</span><span class="gh">三</span><span class="gh">四</span><span class="gh">五</span><span class="gh">六</span><span class="gh">日</span></div>';
    html += '<div class="grid">' + cells + '</div>';
    html += '<div class="legend"><span><i style="background:#10b981"></i>正常</span><span><i style="background:#f59e0b"></i>迟到/早退</span><span><i style="background:#ef4444"></i>缺卡/旷工</span><span><i style="background:#cbd5e1"></i>休息</span></div></div>';

    html += '<div class="card"><div class="card-title"><span>出勤构成</span><span class="sub">' + totalDays + ' 天有记录</span></div>' + dist + '</div>';

    html += '<div class="card"><div class="card-title"><span>工时</span><span class="sub">本月合计</span></div><div class="kpi">';
    html += '<div class="kpi-item"><div class="kpi-val">' + Math.floor(workMin / 60) + 'h</div><div class="kpi-key">累计工时</div></div>';
    html += '<div class="kpi-item"><div class="kpi-val">' + (withWork ? Math.floor(workMin / withWork / 60) + 'h' : '0h') + '</div><div class="kpi-key">日均工时</div></div>';
    html += '<div class="kpi-item"><div class="kpi-val accent">' + Math.floor(otMin / 60) + 'h</div><div class="kpi-key">加班合计</div></div></div></div>';

    html += '<div class="card"><div class="card-title"><span>近 7 日</span><span class="sub">每日工时</span></div><div class="bars">' + bars + '</div></div>';
    html += '<div class="muted" style="text-align:center;font-size:11px;margin-top:12px;padding:0 20px;line-height:1.8">仅统计考勤（出勤 / 工时 / 异常），不涉及薪资与扣款计算</div>';
    html += '</div>';

    body.innerHTML = html;

    body.querySelectorAll('[data-nav]').forEach(function (el) {
      el.onclick = function () {
        var delta = Number(el.getAttribute('data-nav'));
        var seg = state.month.split('-').map(Number);
        var nd = new Date(Date.UTC(seg[0], seg[1] - 1 + delta, 1));
        var nextKey = nd.getUTCFullYear() + '-' + R.pad2(nd.getUTCMonth() + 1);
        if (nextKey > R.monthKeyOf(Date.now())) return;
        state.month = nextKey;
        render();
      };
    });
  }

  /* ---------------- 我的 ---------------- */

  function renderMe() {
    var r = rs();
    var s = summary();
    var chain = L.verifyChain(db.records);
    var now = Date.now();
    var p = R.partsOf(now);

    var html = '<div class="page">';
    html += '<div class="profile"><div class="avatar">' + h((db.boot.nickname || '打').slice(0, 1)) + '</div>';
    html += '<div class="pf-info"><div class="pf-name">' + h(db.boot.nickname || '未设置昵称') + '</div>';
    html += '<div class="pf-meta">' + R.ruleTypeName(r.type) + ' · 本地离线</div></div>';
    html += '<div class="pf-edit" id="editname">编辑</div></div>';

    html += '<div class="card"><div class="card-title"><span>今日</span><span class="sub">' + p.m + '/' + p.d + ' ' + WEEK[p.weekday] + '</span></div>';
    html += '<div class="row"><span class="k">状态</span><span class="v"><span class="tag tag-' + (s.day.hasAny ? s.statusTone : s.isRest ? 'mute' : 'mute') + '">' + (s.day.hasAny ? s.statusLabel : s.isRest ? '休息' : '未打卡') + '</span></span></div>';
    if (s.day.inAt) html += '<div class="row"><span class="k">上班</span><span class="v">' + s.inText + '</span></div>';
    if (s.day.outAt) html += '<div class="row"><span class="k">下班</span><span class="v">' + s.outText + '</span></div>';
    html += '<div class="row"><span class="k">今日工时</span><span class="v">' + fmtMin(s.day.workMinutes) + '</span></div></div>';

    html += '<div class="section-label">考勤规则</div><div class="menu">';
    html += '<div class="menu-item" data-go="rules"><div class="mi-left"><div class="mi-title">考勤规则</div><div class="mi-desc">' + h(R.describeRule(r)) + '</div></div>';
    html += '<div class="mi-right"><span class="mi-badge">' + R.ruleTypeName(r.type) + '</span><span class="mi-arrow">›</span></div></div>';
    html += '<div class="menu-item" data-go="stats"><div class="mi-left"><div class="mi-title">考勤统计</div><div class="mi-desc">出勤率、工时、异常分布</div></div><span class="mi-arrow">›</span></div>';
    html += '<div class="menu-item" data-go="admin"><div class="mi-left"><div class="mi-title">审批与异常</div><div class="mi-desc">补卡审批、异常打卡审核</div></div><span class="mi-arrow">›</span></div>';
    html += '</div>';

    html += '<div class="section-label">数据</div><div class="menu">';
    html += '<div class="menu-item"><div class="mi-left"><div class="mi-title">本地记录</div><div class="mi-desc">' + chain.count + ' 条 · 哈希链' + (chain.ok ? '完整' : '异常') + '</div></div>';
    html += '<span class="tag tag-' + (chain.ok ? 'ok' : 'bad') + '">' + (chain.ok ? '校验通过' : '校验失败') + '</span></div>';
    html += '<div class="menu-item" id="export"><div class="mi-left"><div class="mi-title">导出数据</div><div class="mi-desc">JSON 备份，复制到剪贴板</div></div><span class="mi-arrow">›</span></div>';
    html += '<div class="menu-item" id="reset"><div class="mi-left"><div class="mi-title bad">清空全部数据</div><div class="mi-desc">删除记录与规则，不可恢复</div></div><span class="mi-arrow">›</span></div>';
    html += '</div>';

    html += '<div class="about"><div class="about-line">打卡 v2 · 纯本地运行，数据不出手机</div>';
    html += '<div class="about-line">参考钉钉考勤模型：固定班制 / 弹性工作制 / 排班制 / 自由工时</div></div>';
    html += '</div>';

    body.innerHTML = html;

    body.querySelectorAll('[data-go]').forEach(function (el) {
      el.onclick = function () { state.page = el.getAttribute('data-go'); render(); };
    });
    var ex = document.getElementById('export');
    if (ex) ex.onclick = function () {
      var blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'punch-backup-' + R.dayKeyOf(Date.now()) + '.json';
      a.click();
      toast('已导出备份');
    };
    var rst = document.getElementById('reset');
    if (rst) rst.onclick = function () {
      db = seed();
      save(db);
      state.expanded = {};
      toast('已清空并重建示例数据');
      render();
    };
    var en = document.getElementById('editname');
    if (en) en.onclick = function () {
      var n = prompt('昵称', db.boot.nickname);
      if (n === null) return;
      db.boot.nickname = String(n).slice(0, 20);
      save(db);
      toast('已保存昵称');
      render();
    };
  }

  /* ---------------- 管理页 ---------------- */

  function renderAdmin() {
    var r = rs();
    var pending = db.patches.filter(function (x) { return x.status === 'pending'; });
    var abnormal = db.records
      .filter(function (x) { return x.geoSkipped || (typeof x.dist === 'number' && x.dist > r.geo.radius); })
      .slice(-8)
      .reverse();

    var html = '<div class="page">';
    html += '<div class="section-label">待审批补卡 · ' + pending.length + '</div><div class="card">';
    if (!pending.length) html += '<div class="muted" style="padding:6px 0">没有待处理的补卡申请</div>';
    pending.forEach(function (p1) {
      html += '<div class="dt-row" style="padding:9px 0"><div class="dt-mid" style="margin-left:0">';
      html += '<div class="dt-time" style="font-size:13px">' + p1.dateKey + ' <span class="tag tag-brand" style="font-size:10px">' + (p1.type === 'out' ? '下班' : '上班') + '</span></div>';
      html += '<div class="dt-meta" style="margin-top:3px">' + h(p1.reason) + '</div></div>';
      html += '<span class="dt-link" data-approve="' + escapeAttr(p1.id) + '">通过</span></div>';
    });
    html += '</div>';

    html += '<div class="section-label">异常打卡 · ' + abnormal.length + '</div><div class="card">';
    if (!abnormal.length) html += '<div class="muted" style="padding:6px 0">本月没有异常记录</div>';
    abnormal.forEach(function (x) {
      html += '<div class="dt-row" style="padding:9px 0"><div class="dt-mid" style="margin-left:0">';
      html += '<div class="dt-time" style="font-size:13px">' + x.dateKey + ' ' + R.hhmmOf(x.at) + ' <span class="tag tag-brand" style="font-size:10px">' + (x.type === 'out' ? '下班' : '上班') + '</span> ';
      html += '<span class="tag tag-' + (x.geoSkipped ? 'bad' : 'warn') + '" style="font-size:10px">' + (x.geoSkipped ? '未定位' : '范围外') + '</span></div>';
      html += '<div class="dt-meta" style="margin-top:3px">' + (x.geoSkipped ? '无定位' : '距 ' + Math.round(x.dist) + ' 米 · 精度 ±' + (x.acc || 0)) + ' · 序列 ' + x.seq + '</div>';
      html += '<div class="mono" style="margin-top:2px">' + (x.hash || '').slice(0, 14) + '</div></div></div>';
    });
    html += '</div>';

    html += '<div class="section-label">本月汇总</div><div class="card">';
    var days = {};
    db.records.forEach(function (x) { days[x.dateKey] = true; });
    html += '<div class="row"><span class="k">我（本机）</span><span class="v">' + Object.keys(days).length + ' 天 · ' + db.records.length + ' 条</span></div>';
    html += '<div class="row"><span class="k">待审补卡</span><span class="v">' + pending.length + ' 条</span></div></div>';
    html += '</div>';

    body.innerHTML = html;

    body.querySelectorAll('[data-approve]').forEach(function (el) {
      el.onclick = function () {
        var id = el.getAttribute('data-approve');
        var p1 = db.patches.find(function (x) { return x.id === id; });
        if (!p1) return;
        p1.status = 'approved';
        var info = R.shiftOfDay(rs(), p1.dateKey);
        db.records = L.append(db.records, {
          uid: db.boot.uid, dateKey: p1.dateKey, type: p1.type || 'in', at: Date.now(), clientAt: Date.now(),
          source: 'manual', lat: null, lng: null, acc: null, dist: null, note: '审批补卡：' + p1.reason, patchId: id,
          geoSkipped: true, shiftId: info.shift ? info.shift.id : null, shiftName: info.name,
        }, Date.now());
        db.records[db.records.length - 1].id = L.makeId(db.boot.uid, Date.now(), db.records[db.records.length - 1].seq);
        save(db);
        toast('已通过，生成一条 patch 记录接入哈希链');
        render();
      };
    });
  }

  /* ---------------- 路由 ---------------- */

  function render() {
    var titles = { index: '考勤打卡', records: '打卡记录', stats: '考勤统计', me: '我的', rules: '考勤规则', admin: '审批与异常' };
    document.getElementById('navTitle').textContent = titles[state.page] || '考勤打卡';
    document.getElementById('navBack').textContent = state.page === 'index' || state.page === 'records' || state.page === 'me' ? '' : '‹';
    document.getElementById('navBack').onclick = function () {
      if (state.page === 'index' || state.page === 'records' || state.page === 'me') return;
      state.page = 'me';
      render();
    };
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-page') === state.page || (state.page === 'rules' && t.getAttribute('data-page') === 'me') || (state.page === 'stats' && t.getAttribute('data-page') === 'records') || (state.page === 'admin' && t.getAttribute('data-page') === 'me'));
    });
    if (state.page === 'index') renderIndex();
    else if (state.page === 'records') renderRecords();
    else if (state.page === 'stats') renderStats();
    else if (state.page === 'rules') renderRules();
    else if (state.page === 'admin') renderAdmin();
    else renderMe();
  }

  document.querySelectorAll('.tab').forEach(function (t) {
    t.onclick = function () {
      state.page = t.getAttribute('data-page');
      render();
    };
  });

  function sbTime() {
    var d = new Date();
    document.getElementById('sbTime').textContent = R.pad2(d.getHours()) + ':' + R.pad2(d.getMinutes());
    setTimeout(sbTime, 30000);
  }
  sbTime();

  render();

  window.__preview = {
    go: function (p) { state.page = p; render(); },
    setGeo: function (ok, dist) { state.geo = { ok: ok, dist: dist, acc: 24 }; render(); },
    expand: function (k) { state.expanded[k] = true; render(); },
    setRule: function (type) {
      db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { type: type }));
      save(db);
      render();
    },
  };
})();
