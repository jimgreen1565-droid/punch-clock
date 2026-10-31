/* ==========================================================================
   考勤打卡 · 手机 Web 版
   
   与小程序共用同一套 core/ 逻辑（rules / ledger / sha256）：
   规则判定、哈希链、班次日归属都由 core 计算，这里只负责 DOM 渲染与交互。
   
   与小程序版的差异（如实记录）：
   1. 定位用 navigator.geolocation 而非 wx.getLocation，精度字段来自 coords.accuracy
   2. 数据存在 localStorage（单机），没有云端——所以哈希链只防"改"不防"伪造"
   3. 没有原生 tabBar / 原生弹窗，用 DOM 等价物
   4. 顶栏返回、页面栈手动维护
   ========================================================================== */
(function () {
  'use strict';

  var R = PC.rules;
  var L = PC.ledger;

  var STORE_KEY = 'pc_web_v2';
  var WEEK = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var WEEK_SHORT = ['', '一', '二', '三', '四', '五', '六', '日'];
  var PAGE_TITLES = { index: '考勤打卡', records: '打卡记录', stats: '考勤统计', me: '我的', rules: '考勤规则', admin: '审批与异常' };

  var state = {
    page: 'index',
    month: R.monthKeyOf(Date.now()),
    expanded: {},
    geo: { status: 'idle', ok: false, dist: null, acc: null, error: '' },
    lastPunch: '',
  };

  /* ======================= 数据 ======================= */

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && d.ruleSet && d.ruleSet.type && Array.isArray(d.records)) return d;
      }
    } catch (e) {}
    return null;
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
    } catch (e) {
      toast('存储空间不足，请先导出备份并清理');
    }
  }

  function mkRecord(type, dayKey, minute, dist) {
    var at = R.msOfDayMinute(dayKey, minute);
    return {
      uid: 'Uweb',
      dateKey: dayKey,
      type: type,
      at: at,
      clientAt: at,
      source: 'miniprogram',
      lat: 39.9087 + (Math.random() - 0.5) * 0.0008,
      lng: 116.3972 + (Math.random() - 0.5) * 0.0008,
      acc: 16 + Math.round(Math.random() * 18),
      dist: dist === undefined ? 40 + Math.round(Math.random() * 220) : dist,
      note: '',
      patchId: null,
      geoSkipped: false,
    };
  }

  /** 首次打开灌入一个月示例，让界面立刻有内容可看 */
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

      var inMin = 530 + (rnd % 7);
      if (rnd % 8 === 3) inMin = 545 + (rnd % 12); // 偶尔迟到 5-16 分
      var outMin = 1080 + (rnd % 4 === 1 ? 45 : 4 + (rnd % 3));
      if (rnd % 16 === 5) outMin = 1055; // 偶尔早退

      records = L.append(records, mkRecord('in', dayKey, inMin), now);
      records = L.append(records, mkRecord('out', dayKey, outMin), now);
    }

    // 今天：如果已过上班时间，补一条上班卡让首页有"进行中"的状态
    var tp = R.partsOf(now);
    if (!R.shiftOfDay(rs, todayKey).rest && tp.minutes > 555) {
      records = L.append(records, mkRecord('in', todayKey, 530 + (tp.d % 6)), now);
    }

    // 两条异常记录：范围外 + 未定位，供管理页演示
    var dayA = R.shiftDayKey(todayKey, -3);
    var dayB = R.shiftDayKey(todayKey, -4);
    records = L.append(
      records,
      {
        uid: 'Uweb', dateKey: dayA, type: 'in', at: R.msOfDayMinute(dayA, 545), clientAt: R.msOfDayMinute(dayA, 545),
        source: 'miniprogram', lat: 39.9142, lng: 116.4051, acc: 34, dist: 838, note: '客户现场', patchId: null, geoSkipped: false,
      },
      now
    );
    records = L.append(
      records,
      {
        uid: 'Uweb', dateKey: dayB, type: 'out', at: R.msOfDayMinute(dayB, 1125), clientAt: R.msOfDayMinute(dayB, 1125),
        source: 'miniprogram', lat: null, lng: null, acc: null, dist: null, note: '', patchId: null, geoSkipped: true,
      },
      now
    );

    records.forEach(function (r) { r.id = L.makeId(r.uid, r.at, r.seq); });

    return {
      boot: { uid: 'Uweb00000001', nickname: '阿伟', env: 'web' },
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

  var db = load() || seed();
  save();

  function rs() {
    return R.normalizeRuleSet(db.ruleSet);
  }

  function rulesOf() {
    return rs();
  }

  /* ======================= DOM 工具 ======================= */

  var $body = document.getElementById('body');
  var $navTitle = document.getElementById('navTitle');
  var $navBack = document.getElementById('navBack');
  var $topbar = document.getElementById('topbar');
  var $toast = document.getElementById('toast');
  var $mask = document.getElementById('mask');
  var $sheet = document.getElementById('sheet');
  var $sheetTitle = document.getElementById('sheetTitle');
  var $sheetBody = document.getElementById('sheetBody');
  var $sheetActions = document.getElementById('sheetActions');

  function h(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var toastTimer = null;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.classList.remove('show'); }, 2400);
  }

  /** 通用底部弹层：{title, body, input, confirmText, cancelText, onConfirm} */
  var sheetOnConfirm = null;
  function openSheet(opt) {
    $sheetTitle.textContent = opt.title || '';
    var bodyHtml = opt.body ? '<div class="sheet-body">' + h(opt.body) + '</div>' : '';
    if (opt.input !== undefined) {
      bodyHtml += '<input class="sheet-input" id="sheetInput" type="' + (opt.inputType || 'text') + '" value="' +
        h(opt.input) + '" placeholder="' + h(opt.placeholder || '') + '"' +
        (opt.inputMode ? ' inputmode="' + opt.inputMode + '"' : '') + '>';
    }
    $sheetBody.innerHTML = bodyHtml;
    $sheetBody.style.marginBottom = '14px';

    var actions = '';
    if (opt.cancelText !== false) {
      actions += '<button class="btn sheet-btn-ghost" id="sheetCancel">' + h(opt.cancelText || '取消') + '</button>';
    }
    actions += '<button class="btn btn-primary" id="sheetConfirm">' + h(opt.confirmText || '确定') + '</button>';
    $sheetActions.innerHTML = actions;

    sheetOnConfirm = opt.onConfirm || null;

    var cancel = document.getElementById('sheetCancel');
    if (cancel) cancel.onclick = closeSheet;

    document.getElementById('sheetConfirm').onclick = function () {
      var inputEl = document.getElementById('sheetInput');
      var value = inputEl ? inputEl.value : undefined;
      // 关键：先取出回调再关闭。closeSheet() 会把 sheetOnConfirm 置空，
      // 之前写成「先 closeSheet 再 if (sheetOnConfirm)」导致所有「确定」按钮全部失效。
      var cb = sheetOnConfirm;
      closeSheet();
      if (cb) cb(value);
    };

    $mask.classList.add('show');
    $sheet.classList.add('show');
    var ie = document.getElementById('sheetInput');
    if (ie) {
      setTimeout(function () { ie.focus(); }, 260);
      ie.onkeydown = function (ev) {
        if (ev.key === 'Enter') document.getElementById('sheetConfirm').click();
      };
    }
  }

  function closeSheet() {
    $mask.classList.remove('show');
    $sheet.classList.remove('show');
    sheetOnConfirm = null;
  }

  $mask.onclick = closeSheet;

  function fmtMin(min) {
    var m = Math.max(0, Math.round(min || 0));
    if (!m) return '0m';
    var hh = Math.floor(m / 60);
    var r = m % 60;
    return hh ? (r ? hh + 'h' + r + 'm' : hh + 'h') : r + 'm';
  }

  function row(k, v, cls) {
    return '<div class="row"><span class="k">' + k + '</span><span class="v ' + (cls || '') + '">' + v + '</span></div>';
  }

  /* ======================= 定位 ======================= */

  var GEO_OPTS = { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 };

  function geoSupported() {
    return !!navigator.geolocation;
  }

  /**
   * 取定位并做围栏判定。
   * 注意：浏览器定位必须 HTTPS（或 localhost），HTTP 会被静默拒绝——这是最常见的"定位不动"原因。
   */
  function requestGeo() {
    var r = rulesOf();
    state.geo.status = 'loading';
    render();

    if (!r.geo.enabled) {
      state.geo = { status: 'disabled', ok: true, dist: null, acc: null, error: '' };
      render();
      return;
    }
    if (!geoSupported()) {
      state.geo = { status: 'unsupported', ok: false, dist: null, acc: null, error: '浏览器不支持定位' };
      render();
      return;
    }
    if (!window.isSecureContext) {
      state.geo = { status: 'insecure', ok: false, dist: null, acc: null, error: '当前不是 HTTPS，浏览器会拒绝定位' };
      render();
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var check = PC.geo.inFence(
          { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy },
          { lat: r.geo.lat, lng: r.geo.lng, radius: r.geo.radius }
        );
        state.geo = {
          status: 'ok',
          ok: check.ok,
          dist: check.dist,
          acc: check.acc,
          reason: check.reason,
          check: check,
          error: '',
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        };
        render();
      },
      function (err) {
        var msg = '定位失败';
        var status = 'error';
        if (err.code === 1) { msg = '定位权限被拒绝，请在浏览器/系统设置里允许位置'; status = 'denied'; }
        else if (err.code === 2) { msg = '拿不到位置信号，请到窗边或室外重试'; status = 'unavailable'; }
        else if (err.code === 3) { msg = '定位超时，请重试'; status = 'timeout'; }
        state.geo = { status: status, ok: false, dist: null, acc: null, error: msg };
        render();
      },
      GEO_OPTS
    );
  }

  /* ======================= 汇总计算 ======================= */

  function todaySummary() {
    var now = Date.now();
    var r = rulesOf();
    var dayKey = R.resolveShiftDay(now, r);
    var day = R.pairDay(db.records, r, dayKey, now);
    var info = R.shiftOfDay(r, dayKey);
    var meta = R.statusMeta(day.status);
    var planMinutes = r.type === 'flexible' ? r.requiredMinutes
      : r.type === 'free' ? r.dailyTargetMinutes
      : info.shift ? info.shift.endMin - info.shift.startMin : 0;

    return {
      now: now,
      ruleSet: r,
      dayKey: dayKey,
      day: day,
      dayInfo: info,
      planMinutes: planMinutes,
      nextType: !day.inRec ? 'in' : !day.outRec ? 'out' : 'done',
      isRest: day.restDay,
      statusLabel: meta.label,
      statusTone: meta.tone,
      status: day.status,
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

  /* ======================= 首页 ======================= */

  function remainInfo(s) {
    var r = s.ruleSet;
    var now = s.now;
    if (r.type === 'flexible') {
      if (s.day.outAt) return { text: '已满', key: '还需工时', tone: 'tone-ok' };
      if (!s.day.inAt) return { text: fmtMin(r.requiredMinutes), key: '还需工时', tone: '' };
      var left = R.diffMinutes(s.day.expectOutAt || 0, now);
      return left > 0
        ? { text: fmtMin(left), key: '还需工时', tone: 'tone-warn' }
        : { text: '工时已满', key: '还需工时', tone: 'tone-ok' };
    }
    if (r.type === 'free') {
      var span = s.day.inAt ? R.diffMinutes(now, s.day.inAt) : 0;
      var left2 = Math.max(0, r.dailyTargetMinutes - span);
      return { text: left2 > 0 ? fmtMin(left2) : '已达目标', key: '目标工时', tone: left2 > 0 ? '' : 'tone-ok' };
    }
    // 固定/排班：中间这格放"今天应满多少工时"（计划事实）。
    // 倒计时只留在打卡按钮下方一处，避免同一信息在页面上出现两次。
    if (s.isRest) return { text: '—', key: '休息日', tone: '' };
    if (s.day.outAt && s.day.workMinutes > 0) {
      return { text: fmtMin(s.workMinutes), key: '实际工时', tone: s.day.workMinutes >= s.planMinutes - (r.breakMinutes || 0) ? 'tone-ok' : 'tone-warn' };
    }
    return { text: fmtMin(s.planMinutes - (r.breakMinutes || 0)), key: '应满工时', tone: '' };
  }

  function workInfo(s) {
    // 已上班未下班时，工时应随当前时间实时累加，不能永远显示 0m
    if (s.day.inAt && s.day.outAt) return { text: fmtMin(s.day.workMinutes), key: '今日工时' };
    if (s.day.inAt) {
      var span = Math.max(0, R.diffMinutes(s.now, s.day.inAt) - (s.ruleSet.breakMinutes || 0));
      // 还没跨过午休就不要扣（否则上午会显示负/异常值）
      var passBreak = s.ruleSet.breakEndMin !== null && s.now > R.msOfDayMinute(s.dayKey, s.ruleSet.breakEndMin);
      if (!passBreak) span = Math.max(0, R.diffMinutes(s.now, s.day.inAt));
      return { text: fmtMin(Math.max(0, span)), key: '已上（计时中）' };
    }
    return { text: '—', key: '今日工时' };
  }

  function captionOf(s) {
    var r = s.ruleSet;
    var now = s.now;
    // 不能写「不用打卡」：休息日按钮仍可点（会记为加班），两句话会自相矛盾
    if (s.isRest && !s.day.hasAny) return '休息日，打卡会记为加班';
    if (r.type === 'free') {
      if (!s.day.hasAny) return '自由工时 · 任何时间都能打卡，按累计工时计';
      var span = s.day.inAt ? R.diffMinutes(now, s.day.inAt) : 0;
      if (span >= r.dailyTargetMinutes) return '自由工时 · 已计时 ' + fmtMin(span) + '，已达目标';
      return '自由工时 · 已计时 ' + fmtMin(span) + '，距目标还差 ' + fmtMin(r.dailyTargetMinutes - span);
    }
    if (r.type === 'flexible') {
      if (s.day.outAt) return '今日已完成打卡';
      if (s.day.inAt) {
        var left = R.diffMinutes(s.day.expectOutAt || 0, now);
        return left > 0 ? '还需 ' + fmtMin(left) + ' 才满工时' : '工时已满，打完下班卡即可';
      }
      return '弹性班 · 最晚 ' + r.latestStart + ' 上班，每日满 ' + fmtMin(r.requiredMinutes);
    }
    if (!s.day.inAt) return '班次 ' + (s.dayInfo.shift ? s.dayInfo.shift.start + '-' + s.dayInfo.shift.end : '—');
    if (s.day.outAt) return '今日已完成打卡';
    var left2 = R.diffMinutes(s.day.expectOutAt || 0, now);
    // 与按钮下方倒计时重复，这里只说状态，不再报时间
    return left2 > 0 ? '已上班，下班记得打卡' : '已过下班时间，打完卡即可';
  }

  function geoBlock(r) {
    if (!r.geo.enabled) {
      return '<div class="card geo-card"><div class="geo-head"><div><span class="geo-name">' + PC_ICONS.pin(14) + ' ' + h(r.geo.name) +
        '</span><span class="geo-sub">已关闭</span></div><div class="geo-state idle"><span class="geo-dot"></span><span>无需定位</span></div></div></div>';
    }
    var g = state.geo;
    var stateText, stateCls;
    if (g.status === 'loading') { stateText = '定位中…'; stateCls = 'idle'; }
    else if (g.status === 'disabled') { stateText = '无需定位'; stateCls = 'idle'; }
    else if (g.status === 'ok' || g.status === 'done') {
      stateText = g.ok ? '已进入范围' : (g.reason === 'low-accuracy' ? '精度不足' : '未在范围');
      stateCls = g.ok ? 'ok' : 'bad';
    } else if (g.status === 'insecure') { stateText = '需要 HTTPS'; stateCls = 'bad'; }
    else if (g.status !== 'idle') { stateText = '定位未就绪'; stateCls = 'bad'; }
    else { stateText = '未校验'; stateCls = 'idle'; }

    var rows = '';
    if (g.dist !== null && g.dist !== undefined) rows += '<div class="geo-row"><span class="geo-k">距打卡点</span><span class="geo-v">' + Math.round(g.dist) + ' 米</span></div>';
    if (g.acc !== null && g.acc !== undefined) rows += '<div class="geo-row"><span class="geo-k">定位精度</span><span class="geo-v">±' + Math.round(g.acc) + ' 米</span></div>';
    if (g.error) rows += '<div class="geo-row"><span class="geo-k">问题</span><span class="geo-v bad">' + h(g.error) + '</span></div>';
    if (state.lastPunch) rows += '<div class="geo-row"><span class="geo-k">最近一次</span><span class="geo-v">' + h(state.lastPunch) + '</span></div>';

    return (
      '<div class="card geo-card"><div class="geo-head">' +
      '<div><span class="geo-name">' + h(r.geo.name) + '</span><span class="geo-sub">范围 ' + r.geo.radius + ' 米</span></div>' +
      '<div class="geo-state ' + stateCls + '"><span class="geo-dot"></span><span>' + stateText + '</span></div></div>' +
      '<div>' + rows + '</div>' +
      '<div class="geo-actions">' +
      '<button class="geo-btn" id="regeo">' + (g.status === 'loading' ? '定位中…' : '重新定位') + '</button>' +
      (r.allowOutsideNote ? '<button class="geo-btn" id="outside">外勤打卡</button>' : '') +
      '</div></div>'
    );
  }

  /**
   * 按钮下方的第三行小字：给出"现在该关注什么"的时间信息。
   * 头部打卡产品（钉钉/飞书）都在这里放倒计时，因为用户最想知道的是"还有多久能走"。
   */
  function countdownHint(s) {
    if (s.nextType === 'done') return '今日已打完';
    var r = s.ruleSet;
    if (s.isRest) return '休息日打卡将记为加班';

    if (s.nextType === 'out' && s.day.inAt) {
      // 已上班：距离应下班还剩多久
      var left = R.diffMinutes(s.day.expectOutAt || 0, Date.now());
      if (left > 0) {
        return left >= 60
          ? '还需 ' + Math.floor(left / 60) + ' 小时 ' + (left % 60) + ' 分可下班'
          : '还需 ' + left + ' 分可下班';
      }
      return '已到下班时间';
    }

    if (s.nextType === 'in') {
      var toStart = R.diffMinutes(s.day.expectInAt || 0, Date.now());
      if (toStart > 0) {
        return toStart >= 60
          ? '距上班还有 ' + Math.floor(toStart / 60) + ' 小时 ' + (toStart % 60) + ' 分'
          : '距上班还有 ' + toStart + ' 分';
      }
      if (r.type !== 'free' && toStart < 0) {
        var late = -toStart;
        return r.type === 'flexible'
          ? '已过最晚上班 ' + late + ' 分'
          : '已迟到 ' + late + ' 分';
      }
    }
    return '点击打卡';
  }

  function renderIndex() {
    var s = todaySummary();
    var r = s.ruleSet;
    var now = s.now;
    var p = R.partsOf(now);

    var percent = 0;
    if (s.day.inAt) {
      if (s.day.outAt) percent = 100;
      else if (s.day.expectOutAt && s.day.expectInAt) {
        var total = s.day.expectOutAt - s.day.expectInAt;
        var done = now - s.day.inAt;
        percent = total > 0 ? Math.max(0, Math.min(99, Math.round((done / total) * 100))) : 50;
      } else percent = 50;
    }

    var remain = remainInfo(s);
    var work = workInfo(s);

    var alerts = [];
    if (s.lateText) alerts.push({ label: s.lateText, tone: 'warn' });
    if (s.earlyText) alerts.push({ label: s.earlyText, tone: 'warn' });
    if (s.underText) alerts.push({ label: s.underText, tone: 'warn' });
    if (s.overtimeText) alerts.push({ label: s.overtimeText, tone: 'accent' });
    if (s.day.missingIn) alerts.push({ label: '上班卡未打', tone: 'bad' });
    if (s.day.missingOut) alerts.push({ label: '下班卡未打', tone: 'bad' });

    var statusTagVis = s.day.hasAny && s.status !== 'missing' && s.status !== 'absent';
    // 状态标签已经把「迟到」说了一次，alerts 里就不再重复同一句
    if (statusTagVis) {
      alerts = alerts.filter(function (a) { return a.label.indexOf(s.statusLabel) < 0; });
    }
    // 休息日且完全没打卡：整块时间轴毫无信息量，直接用一句说明替代
    var restEmpty = s.isRest && !s.day.hasAny;

    var html = '<div class="page">';

    html += '<div class="hero"><div><div class="hero-date">' + p.m + '月' + p.d + '日</div>';
    html += '<div class="hero-week">' + WEEK[p.weekday] +
      (s.isRest ? '<span class="tag tag-mute">休息日</span>' : '') + '</div></div>';
    html += '<button class="rule-chip" data-go="rules"><span class="chip-dot"></span><span>' +
      R.ruleTypeName(r.type) + '</span><span class="chip-arrow">' + PC_ICONS.chevronRight(12) + '</span></button></div>';
    html += '<div class="rule-line">' + h(R.describeRule(r)) + '</div>';

    html += '<div class="punch-zone">';
    var btnCls = s.nextType === 'done' ? 'is-done' : '';
    var btnLabel = s.nextType === 'done'
      ? '已完成'
      : s.isRest && !s.day.hasAny
      ? '加班打卡'
      : s.nextType === 'in' ? '上班打卡' : '下班打卡';
    html += '<button class="punch-btn ' + btnCls + '" id="punchBtn">';
    html += '<span class="btn-time" id="clock">--:--:--</span>';
    html += '<span class="btn-label">' + btnLabel + '</span>';
    html += '<span class="btn-hint">' + countdownHint(s) + '</span>';
    html += '</button>';
    html += '<div class="punch-caption">' + (statusTagVis ? '<span class="tag tag-' + s.statusTone + '">' + s.statusLabel + '</span>' : '') +
      '<span class="caption-text">' + h(captionOf(s)) + '</span></div></div>';

    if (restEmpty) {
      html += '<div class="card rest-card">' +
        '<div class="rest-title">今天休息</div>' +
        '<div class="rest-desc">按当前规则，' + R.weekdaysText(r.weekdays) + ' 上班。休息日打卡会记为加班。</div>' +
        '</div>';
    } else {
      html += '<div class="card tl-card"><div class="tl">';
      html += '<div class="tl-node"><div class="tl-mark ' + (s.day.inAt ? 'done' : '') + '"></div>' +
        '<div class="tl-info"><div class="tl-what">上班</div><div class="tl-when ' + (s.day.inAt ? 'strong' : '') + '">' + s.inText +
        '</div><div class="tl-plan">应到 ' + s.expectInText + '</div></div></div>';
      html += '<div class="tl-line"><div class="tl-line-fill" style="width:' + percent + '%"></div></div>';
      html += '<div class="tl-node right"><div class="tl-mark ' + (s.day.outAt ? 'done' : '') + '"></div>' +
        '<div class="tl-info"><div class="tl-what">下班</div><div class="tl-when ' + (s.day.outAt ? 'strong' : '') + '">' + s.outText +
        '</div><div class="tl-plan">应到 ' + s.expectOutText + '</div></div></div>';
      html += '</div><div class="divider"></div>';

      html += '<div class="metrics">' +
        '<div class="metric"><div class="m-val">' + work.text + '</div><div class="m-key">' + work.key + '</div></div>' +
        '<div class="m-sep"></div>' +
        '<div class="metric"><div class="m-val ' + remain.tone + '">' + remain.text + '</div><div class="m-key">' + remain.key + '</div></div>' +
        '<div class="m-sep"></div>' +
        '<div class="metric"><div class="m-val">' + (s.day.overtimeMinutes ? fmtMin(s.day.overtimeMinutes) : '—') + '</div><div class="m-key">加班</div></div>' +
        '</div>';

      if (alerts.length) {
        html += '<div class="alerts">';
        alerts.forEach(function (a) {
          html += '<div class="alert alert-' + a.tone + '"><span class="alert-dot"></span><span>' + h(a.label) + '</span></div>';
        });
        html += '</div>';
      }
      html += '</div>';
    }

    html += geoBlock(r);

    html += '<div class="muted" style="text-align:center;font-size:11px;margin-top:12px;padding:0 18px;line-height:1.8">' +
      '打卡记录写入本地哈希链，任何改动都能在「记录」页校验出来</div>';
    html += '</div>';

    $body.innerHTML = html;

    var btn = document.getElementById('punchBtn');
    btn.onclick = function () {
      if (s.nextType === 'done') {
        openSheet({
          title: '今日已完成打卡',
          body: '上班 ' + s.inText + ' · 下班 ' + s.outText + ' · 工时 ' + work.text +
            '\n\n如需补一条记录（例如中途外出回来），可以点下面的按钮。',
          confirmText: '补一条记录',
          cancelText: '不用了',
          onConfirm: function () { doPunch({ manual: true }); },
        });
        return;
      }
      doPunch({});
    };
    var regeo = document.getElementById('regeo');
    if (regeo) regeo.onclick = requestGeo;
    var outside = document.getElementById('outside');
    if (outside) outside.onclick = function () { outsidePunch(); };
    bindGo();

    tickClock();
  }

  var clockTimer = null;
  function tickClock() {
    var el = document.getElementById('clock');
    if (!el) return;
    var d = new Date();
    el.textContent = R.pad2(d.getHours()) + ':' + R.pad2(d.getMinutes()) + ':' + R.pad2(d.getSeconds());
    clearTimeout(clockTimer);
    // 每 10 秒重算一次汇总（不每秒重渲染，避免按钮抖动）
    if (state.page === 'index') {
      clockTimer = setTimeout(function () {
        if (state.page === 'index') renderIndex();
      }, 10000);
    }
  }

  function bindGo() {
    $body.querySelectorAll('[data-go]').forEach(function (el) {
      el.onclick = function () { go(el.getAttribute('data-go')); };
    });
  }

  /* ======================= 打卡动作 ======================= */

  function doPunch(opts) {
    var o = opts || {};
    var now = Date.now();
    var r = rulesOf();
    var dayKey = R.resolveShiftDay(now, r);
    var day = R.pairDay(db.records, r, dayKey, now);
    // 上下班都齐了时：如果是用户主动要补记录就按时间远近归类，否则 doPunch 已在上层拦截
    var type = !day.inRec ? 'in' : !day.outRec ? 'out'
      : Math.abs(now - day.inAt) < Math.abs(now - (day.outAt || 0)) ? 'in' : 'out';
    var info = R.shiftOfDay(r, dayKey);
    var graded = R.classifyPunch({ ms: now, type: type, dayKey: dayKey, ruleSet: r });

    var g = state.geo;
    var outside = o.outOfRange || (r.geo.enabled && g.status !== 'idle' && g.dist !== null && !g.ok);
    var skipGeo = !o.outOfRange && r.geo.enabled && g.status !== 'ok' && g.status !== 'done' && g.status !== 'loading';

    // 严格模式 + 明确在范围外 + 用户没选外勤 -> 拒绝
    if (r.geo.enabled && r.geo.strict && g.dist !== null && !g.ok && !o.outOfRange) {
      openSheet({
        title: '不在打卡范围',
        body: '距打卡点 ' + Math.round(g.dist) + ' 米，超出 ' + r.geo.radius + ' 米范围。\n\n' +
          (r.allowOutsideNote ? '若确实在外勤，可填写原因后打卡（记录会标记待审核）。' : '请联系管理员，或移动到范围内重试。'),
        input: '',
        placeholder: '外勤原因（如：客户现场 / 在途中）',
        confirmText: r.allowOutsideNote ? '外勤打卡' : '重新定位',
        onConfirm: function (val) {
          if (!r.allowOutsideNote) { requestGeo(); return; }
          var note = (val || '').trim();
          if (!note) { toast('请填写外勤原因'); return; }
          writePunch({ type: type, dayKey: dayKey, info: info, graded: graded, note: note, outOfRange: true, geoSkipped: false });
        },
      });
      return;
    }

    if (skipGeo) {
      openSheet({
        title: '尚未取得定位',
        body: '还没拿到位置，无法核验是否在打卡范围。\n先打卡会被标记为「未定位待审核」。',
        cancelText: '先定位',
        confirmText: '未定位打卡',
        onConfirm: function () {
          writePunch({ type: type, dayKey: dayKey, info: info, graded: graded, note: '未取到定位', outOfRange: false, geoSkipped: true });
        },
      });
      // 「先定位」按钮实际走取消分支，所以单独挂一下
      var cancelBtn = document.getElementById('sheetCancel');
      if (cancelBtn) cancelBtn.onclick = function () { closeSheet(); requestGeo(); };
      return;
    }

    writePunch({ type: type, dayKey: dayKey, info: info, graded: graded, note: o.note || '', outOfRange: false, geoSkipped: false });
  }

  function writePunch(ctx) {
    var now = Date.now();
    var r = rulesOf();
    var g = state.geo;
    var hasPos = g.status === 'ok' || g.status === 'done';

    var rec = {
      uid: db.boot.uid,
      dateKey: ctx.dayKey,
      type: ctx.type,
      at: now,
      clientAt: now,
      source: 'webapp',
      lat: hasPos && typeof g.lat === 'number' ? g.lat : null,
      lng: hasPos && typeof g.lng === 'number' ? g.lng : null,
      acc: hasPos && typeof g.acc === 'number' ? g.acc : null,
      dist: typeof g.dist === 'number' ? g.dist : null,
      note: String(ctx.note || '').slice(0, 60),
      patchId: null,
      geoSkipped: !!ctx.geoSkipped,
      shiftId: ctx.info.shift ? ctx.info.shift.id : null,
      shiftName: ctx.info.name,
    };

    db.records = L.append(db.records, rec, now);
    var written = db.records[db.records.length - 1];
    written.id = L.makeId(db.boot.uid, now, written.seq);
    save();

    var title = ctx.outOfRange ? '外勤打卡'
      : ctx.graded.restDay ? (ctx.type === 'in' ? '休息日到岗' : '休息日下班')
      : ctx.type === 'in' ? (ctx.graded.status === 'late' ? '迟到打卡' : '上班打卡')
      : ctx.graded.status === 'early' ? '早退打卡'
      : ctx.graded.status === 'under' ? '工时不足'
      : ctx.graded.status === 'overtime' || ctx.graded.overtimeMinutes > 0 ? '下班打卡（含加班）'
      : '下班打卡';

    state.lastPunch = R.hhmmOf(now) + ' · ' + title;
    if (navigator.vibrate) navigator.vibrate(60);
    toast(title + ' ' + R.hhmmssOf(now) + ' · 哈希 ' + written.hash.slice(0, 10) + '…');
    renderIndex();
  }

  function outsidePunch() {
    var r = rulesOf();
    if (!r.allowOutsideNote) {
      toast('当前规则不允许范围外打卡');
      return;
    }
    openSheet({
      title: '外勤打卡',
      body: '外勤打卡会记录在案并标记为待审核，请如实填写原因。',
      input: '',
      placeholder: '外勤原因（如：客户现场 / 在途中 / 在家办公）',
      confirmText: '提交',
      onConfirm: function (val) {
        var note = (val || '').trim();
        if (!note) { toast('请填写外勤原因'); return; }
        var now = Date.now();
        var dayKey = R.resolveShiftDay(now, r);
        var day = R.pairDay(db.records, r, dayKey, now);
        var type = !day.inRec ? 'in' : 'out';
        var info = R.shiftOfDay(r, dayKey);
        var graded = R.classifyPunch({ ms: now, type: type, dayKey: dayKey, ruleSet: r });
        writePunch({ type: type, dayKey: dayKey, info: info, graded: graded, note: note, outOfRange: true, geoSkipped: false });
      },
    });
  }

  /* ======================= 规则页 ======================= */

  function renderRules() {
    var r = rulesOf();
    var html = '<div class="page">';

    html += '<div class="card current"><div class="cur-top"><span class="cur-badge">' + R.ruleTypeName(r.type) +
      '</span><span class="cur-name">' + h(r.name) + '</span></div>';
    html += '<div class="cur-desc">' + h(R.describeRule(r)) + '</div></div>';

    html += '<div class="section-label">选择考勤规则</div><div class="options">';
    R.RULE_TYPES.forEach(function (t) {
      var active = t.id === r.type;
      html += '<button class="option ' + (active ? 'active' : '') + '" data-type="' + t.id + '">';
      html += '<span class="opt-radio">' + (active ? '<span class="opt-radio-fill"></span>' : '') + '</span>';
      html += '<span class="opt-body"><span class="opt-head"><span class="opt-name">' + t.name + '</span><span class="opt-tag">' + t.tag + '</span></span>';
      html += '<span class="opt-desc">' + t.desc + '</span><span class="opt-detail">' + t.detail + '</span></span></button>';
    });
    html += '</div>';

    html += '<div class="section-label">规则参数</div><div class="card">';
    if (r.type === 'fixed') {
      html += rowTappable('上班时间', r.start, 'edit', 'start');
      html += rowTappable('下班时间', r.end, 'edit', 'end');
      html += rowTappable('工作日', R.weekdaysText(r.weekdays), 'weekdays');
      html += rowTappable('午休时段', r.breakStart ? r.breakStart + '-' + r.breakEnd : '未设置', 'break');
      html += rowTappable('迟到宽限', r.lateGrace + ' 分钟', 'num', 'lateGrace');
      html += rowTappable('早退宽限', r.earlyGrace + ' 分钟', 'num', 'earlyGrace');
    } else if (r.type === 'flexible') {
      html += rowTappable('最晚上班', r.latestStart, 'edit', 'latestStart');
      html += rowTappable('最早下班', r.earliestEnd, 'edit', 'earliestEnd');
      html += rowTappable('每日应满工时', R.fmtMinuteText(r.requiredMinutes), 'num', 'requiredMinutes');
      html += rowTappable('工作日', R.weekdaysText(r.weekdays), 'weekdays');
      html += rowTappable('午休（不计工时）', r.breakStart ? r.breakStart + '-' + r.breakEnd : '未设置', 'break');
      html += rowTappable('迟到宽限', r.lateGrace + ' 分钟', 'num', 'lateGrace');
    } else if (r.type === 'shift') {
      html += rowTappable('周期轮换', r.rotation.enabled ? '已开启' : '未开启', 'toggleRot');
      if (r.rotation.enabled) {
        html += rowTappable('轮换周期', r.rotation.cycleDays + ' 天', 'num', 'cycleDays');
        html += rowTappable('班次顺序', r.rotation.slots.map(R.slotName(r)).join(' → '), 'slots');
      } else {
        html += rowTappable('上班时间', r.start, 'edit', 'start');
        html += rowTappable('下班时间', r.end, 'edit', 'end');
      }
      html += rowTappable('工作日', R.weekdaysText(r.weekdays), 'weekdays');
      html += rowTappable('迟到宽限', r.lateGrace + ' 分钟', 'num', 'lateGrace');
    } else {
      html += rowTappable('每日目标工时', R.fmtMinuteText(r.dailyTargetMinutes), 'num', 'dailyTargetMinutes');
      html += '<div class="row"><span class="k">判定方式</span><span class="v dim">不判迟到早退</span></div>';
    }
    html += '</div>';

    // 补卡规则（对齐飞书：是否允许 / 可补天数 / 每月次数）
    html += '<div class="section-label">补卡规则</div><div class="card">';
    html += rowTappable('允许补卡', r.patch.allow ? '允许' : '不允许', 'patchToggle');
    if (r.patch.allow) {
      html += rowTappable('可补天数', r.patch.maxDays === 0 ? '仅当天' : '过去 ' + r.patch.maxDays + ' 天', 'num', 'patchMaxDays');
      html += rowTappable('每月上限', r.patch.maxPerMonth === 0 ? '不限' : r.patch.maxPerMonth + ' 次', 'num', 'patchMaxPerMonth');
    }
    html += '<div class="muted" style="padding-top:' + 'var(--s2)' + '">本月已提交 ' + usedPatchCount() + ' 次补卡申请</div>';
    html += '</div>';

    html += '<div class="section-label">打卡方式</div><div class="card">';
''
    if (r.geo.enabled) {
      html += rowTappable('打卡点坐标', r.geo.lat.toFixed(5) + ', ' + r.geo.lng.toFixed(5), 'here');
      html += rowTappable('范围半径', r.geo.radius + ' 米', 'num', 'radius');
      html += rowTappable('范围外打卡', r.geo.strict ? '禁止' : '允许（填外勤原因）', 'strict');
      html += rowTappable('位置校验', r.geo.enabled ? '已开启（点击关闭）' : '已关闭（点击开启）', 'geoToggle');
    }
    html += '<div class="muted" style="padding:8px 0 0">' + (r.geo.enabled ? '严格模式：范围外无法打卡；宽松模式：范围外可打卡并填外勤原因' : '已关闭位置校验，任何位置都能打卡') + '</div>';
    html += '</div>';

    html += '<div class="section-label">规则模板</div><div class="card">';
    if (!db.presets.length) html += '<div class="muted" style="padding:4px 0 10px">还没有保存的模板。保存后可一键切换。</div>';
    db.presets.forEach(function (p) {
      html += '<div class="dt-row"><div class="dt-mid" style="margin-left:0"><div class="dt-time" style="font-size:13.5px">' + h(p.name) + '</div>';
      html += '<div class="dt-meta">' + R.ruleTypeName(p.ruleSet.type) + ' · ' + h(R.describeRule(p.ruleSet)) + '</div></div>';
      html += '<button class="dt-link" data-apply="' + h(p.id) + '">应用</button>';
      html += '<button class="dt-link" style="color:#ef4444" data-delpreset="' + h(p.id) + '">删</button></div>';
    });
    html += '<button class="btn" id="savePreset">保存当前规则为模板</button></div>';

    html += '<div class="muted" style="text-align:center;font-size:11px;margin-top:12px;padding:0 20px;line-height:1.85">' +
      '切换规则后今天的判定按新规则重算，但已产生的打卡记录不会被改写（哈希不变）</div>';
    html += '</div>';

    $body.innerHTML = html;

    $body.querySelectorAll('[data-type]').forEach(function (el) {
      el.onclick = function () {
        var t = el.getAttribute('data-type');
        if (t === rulesOf().type) return;
        var name = R.ruleTypeName(t);
        openSheet({
          title: '切换为' + name + '？',
          body: '切换后今天的判定会按新规则计算；已产生的打卡记录不会被改写。',
          confirmText: '切换',
          onConfirm: function () {
            db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { type: t }));
            save();
            state.geo = { status: 'idle', ok: false, dist: null, acc: null, error: '' };
            toast('已切换为 ' + name);
            renderRules();
          },
        });
      };
    });

    bindRuleRows();

    $body.querySelectorAll('[data-apply]').forEach(function (el) {
      el.onclick = function () {
        var id = el.getAttribute('data-apply');
        var p = db.presets.filter(function (x) { return x.id === id; })[0];
        if (!p) return;
        openSheet({
          title: '应用模板',
          body: '将切换到「' + p.name + '」的配置，当前规则会被覆盖。',
          confirmText: '应用',
          onConfirm: function () {
            db.ruleSet = R.normalizeRuleSet(p.ruleSet);
            save();
            toast('已应用：' + p.name);
            renderRules();
          },
        });
      };
    });

    $body.querySelectorAll('[data-delpreset]').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        var id = el.getAttribute('data-delpreset');
        db.presets = db.presets.filter(function (x) { return x.id !== id; });
        save();
        toast('已删除模板');
        renderRules();
      };
    });

    var sp = document.getElementById('savePreset');
    if (sp) sp.onclick = function () {
      var defName = R.ruleTypeName(rulesOf().type);
      openSheet({
        title: '保存为模板',
        input: defName,
        placeholder: '模板名称',
        confirmText: '保存',
        onConfirm: function (val) {
          db.presets.unshift({
            id: 'PR' + Date.now().toString(36),
            name: (val || '').trim() || defName,
            ruleSet: rulesOf(),
          });
          save();
          toast('已保存模板');
          renderRules();
        },
      });
    };
  }

  function rowTappable(k, v, action, field) {
    return '<div class="row tappable" data-act="' + action + '"' + (field ? ' data-field="' + field + '"' : '') +
      '><span class="k">' + k + '</span><span class="v">' + h(v) + ' ›</span></div>';
  }

  function patchRule(patch) {
    db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, patch));
    save();
    renderRules();
  }

  function bindRuleRows() {
    $body.querySelectorAll('[data-act]').forEach(function (el) {
      var act = el.getAttribute('data-act');
      var field = el.getAttribute('data-field');

      el.onclick = function () {
        var r = rulesOf();

        if (act === 'edit') {
          var isTime = true;
          openSheet({
            title: field === 'start' ? '上班时间' : field === 'end' ? '下班时间'
              : field === 'latestStart' ? '最晚上班时间' : '最早下班时间',
            body: isTime ? '格式 HH:MM，例如 09:00' : '',
            input: r[field],
            placeholder: 'HH:MM',
            inputMode: 'numeric',
            confirmText: '保存',
            onConfirm: function (val) {
              if (R.parseHHMM(val) === null) { toast('格式应为 HH:MM'); return; }
              var patch = {};
              patch[field] = String(val).trim();
              patchRule(patch);
              toast('已更新');
            },
          });
          return;
        }

        if (act === 'num') {
          var labels = {
            lateGrace: ['迟到宽限（分钟）', 0, 120],
            earlyGrace: ['早退宽限（分钟）', 0, 120],
            requiredMinutes: ['每日应满工时（分钟）', 60, 1440],
            dailyTargetMinutes: ['每日目标工时（分钟）', 0, 1440],
            cycleDays: ['轮换周期（天）', 1, 60],
            radius: ['打卡范围半径（米）', 1, 5000],
            patchMaxDays: ['可补天数（0 = 仅当天）', 0, 180],
            patchMaxPerMonth: ['每月补卡上限（0 = 不限）', 0, 999],
          };
          var conf = labels[field] || ['数值', 0, 100000];
          openSheet({
            title: conf[0],
            input: String(r[field]),
            inputMode: 'numeric',
            confirmText: '保存',
            onConfirm: function (val) {
              var n = Number(val);
              if (!isFinite(n) || n < conf[1] || n > conf[2]) {
                toast('请输入 ' + conf[1] + '-' + conf[2]);
                return;
              }
              if (field === 'cycleDays') {
                var count = Math.round(n);
                var slots = r.rotation.slots.slice(0, count);
                while (slots.length < count) {
                  slots.push(slots.length === count - 1 ? 'REST' : r.shifts[0].id);
                }
                db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { rotation: { cycleDays: count, slots: slots } }));
                save();
                renderRules();
                return;
              }
              if (field === 'radius') {
                db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { geo: { radius: Math.round(n) } }));
                save();
                renderRules();
                return;
              }
              if (field === 'patchMaxDays' || field === 'patchMaxPerMonth') {
                var key = field === 'patchMaxDays' ? 'maxDays' : 'maxPerMonth';
                db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { patch: { [key]: Math.round(n) } }));
                save();
                renderRules();
                return;
              }
              var p2 = {};
              p2[field] = Math.round(n);
              patchRule(p2);
              toast('已更新');
            },
          });
          return;
        }

        if (act === 'weekdays') {
          var picked = r.weekdays.slice();
          openSheet({
            title: '工作日',
            body: '点击切换某天是否上班（至少保留一天）',
            confirmText: '完成',
            cancelText: false,
            onConfirm: function () { renderRules(); },
          });
          // 把 body 换成可点的日子
          $sheetBody.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
            [1, 2, 3, 4, 5, 6, 7].map(function (w) {
              var on = picked.indexOf(w) >= 0;
              return '<button class="geo-btn" data-day="' + w + '" style="flex:0 0 auto;width:56px;height:44px;' +
                (on ? 'background:#4f6ef7;color:#fff' : 'background:#f1f4fa;color:#5b6b85') + '">' +
                R.WEEKDAY_TEXT[w].slice(1) + '</button>';
            }).join('') + '</div>';
          $sheetBody.querySelectorAll('[data-day]').forEach(function (b) {
            b.onclick = function () {
              var w = Number(b.getAttribute('data-day'));
              var cur = rulesOf().weekdays.slice();
              if (cur.indexOf(w) >= 0) {
                if (cur.length === 1) { toast('至少保留一天'); return; }
                cur = cur.filter(function (x) { return x !== w; });
              } else {
                cur.push(w);
              }
              cur.sort(function (a, bb) { return a - bb; });
              db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { weekdays: cur }));
              save();
              var on = cur.indexOf(w) >= 0;
              b.style.background = on ? '#4f6ef7' : '#f1f4fa';
              b.style.color = on ? '#fff' : '#5b6b85';
            };
          });
          return;
        }

        if (act === 'break') {
          openSheet({
            title: '午休时段',
            body: '两个时间都用 HH:MM。留空表示不设午休。',
            input: (r.breakStart || '') + '-' + (r.breakEnd || ''),
            placeholder: '12:00-13:00',
            confirmText: '保存',
            onConfirm: function (val) {
              var v = String(val || '').trim();
              if (!v) { patchRule({ breakStart: '', breakEnd: '' }); toast('已清除午休'); return; }
              var seg = v.split(/[-,~到\s]+/).filter(Boolean);
              if (seg.length !== 2 || R.parseHHMM(seg[0]) === null || R.parseHHMM(seg[1]) === null) {
                toast('格式应为 12:00-13:00');
                return;
              }
              patchRule({ breakStart: seg[0], breakEnd: seg[1] });
              toast('已更新午休');
            },
          });
          return;
        }

        if (act === 'toggleRot') {
          db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { rotation: { enabled: !r.rotation.enabled } }));
          save();
          renderRules();
          toast(r.rotation.enabled ? '已关闭周期轮换' : '已开启周期轮换');
          return;
        }

        if (act === 'slots') {
          var slots = r.rotation.slots.slice();
          var names = r.shifts.map(function (s) { return s.name; }).concat(['休息']);
          openSheet({
            title: '班次顺序',
            body: '当前：' + slots.map(R.slotName(r)).join(' → ') + '\n\n点击某一天，在弹出的列表里选班次。',
            confirmText: '完成',
            cancelText: false,
            onConfirm: function () { renderRules(); },
          });
          $sheetBody.innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">' +
            slots.map(function (s, i) {
              return '<button class="geo-btn" data-slot="' + i + '" style="flex:0 0 auto;padding:0 10px;height:40px;font-size:12px">第' + (i + 1) + '天 ' + R.slotName(r)(s) + '</button>';
            }).join('') + '</div>';
          $sheetBody.querySelectorAll('[data-slot]').forEach(function (b) {
            b.onclick = function () {
              var idx = Number(b.getAttribute('data-slot'));
              var cur = rulesOf().rotation.slots.slice();
              var pick = 0;
              openSheet({
                title: '第 ' + (idx + 1) + ' 天排什么班',
                body: names.join(' / '),
                input: R.slotName(rulesOf())(cur[idx]),
                placeholder: names[0],
                confirmText: '保存',
                onConfirm: function (val) {
                  var v = String(val || '').trim();
                  var found = -1;
                  if (/^休/.test(v)) found = -2;
                  else {
                    rulesOf().shifts.forEach(function (s, i) { if (s.name === v) found = i; });
                  }
                  if (found === -1) { toast('请填写班次名之一：' + names.join('/')); return; }
                  cur[idx] = found === -2 ? 'REST' : rulesOf().shifts[found].id;
                  db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { rotation: { slots: cur } }));
                  save();
                  renderRules();
                  toast('已更新排班');
                },
              });
            };
          });
          return;
        }

        if (act === 'geoToggle') {
          var nowOn = !rulesOf().geo.enabled;
          db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { geo: { enabled: nowOn } }));
          save();
          state.geo = { status: 'idle', ok: false, dist: null, acc: null, error: '' };
          renderRules();
          toast(nowOn ? '已开启位置校验' : '已关闭位置校验');
          return;
        }

        if (act === 'patchToggle') {
          db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { patch: { allow: !rulesOf().patch.allow } }));
          save();
          renderRules();
          toast(rulesOf().patch.allow ? '已允许补卡' : '已关闭补卡');
          return;
        }

        if (act === 'strict') {
          var next = !rulesOf().geo.strict;
          db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { geo: { strict: next } }));
          save();
          renderRules();
          toast(next ? '严格模式：范围外禁止打卡' : '宽松模式：范围外可打卡并填原因');
          return;
        }

        if (act === 'here') {
          if (!geoSupported() || !window.isSecureContext) {
            toast('当前环境无法取定位（需要 HTTPS），请手动填写坐标');
            openSheet({
              title: '打卡点坐标',
              body: '格式：纬度,经度（GCJ-02 或 WGS84 皆可，误差几百米内不影响演示）',
              input: rulesOf().geo.lat + ',' + rulesOf().geo.lng,
              confirmText: '保存',
              onConfirm: function (val) {
                var seg = String(val || '').split(/[,\s]+/).filter(Boolean);
                var a = Number(seg[0]);
                var b = Number(seg[1]);
                if (!isFinite(a) || !isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) {
                  toast('坐标格式不对');
                  return;
                }
                db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { geo: { lat: a, lng: b } }));
                save();
                state.geo = { status: 'idle', ok: false, dist: null, acc: null, error: '' };
                renderRules();
                toast('已更新打卡点');
              },
            });
            return;
          }
          toast('正在获取当前位置…');
          navigator.geolocation.getCurrentPosition(
            function (pos) {
              var lat = pos.coords.latitude;
              var lng = pos.coords.longitude;
              var acc = Math.round(pos.coords.accuracy || 0);
              openSheet({
                title: '设为打卡点',
                body: '纬度 ' + lat.toFixed(6) + '\n经度 ' + lng.toFixed(6) + '\n精度 ±' + acc + ' 米',
                confirmText: '设为打卡点',
                onConfirm: function () {
                  db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { geo: { lat: lat, lng: lng } }));
                  save();
                  state.geo = { status: 'idle', ok: false, dist: null, acc: null, error: '' };
                  renderRules();
                  toast('已设为打卡点');
                },
              });
            },
            function (err) {
              toast('获取位置失败：' + (err && err.message ? err.message : '请检查权限或 HTTPS'));
            },
            GEO_OPTS
          );
          return;
        }
      };
    });
  }

  /* ======================= 记录页 ======================= */

  /**
   * 补卡申请：按规则集里的补卡规则（是否允许 / 可补天数 / 每月次数）先校验。
   * 这条规则来自飞书「管理员设置补卡规则」，钉钉也有等价设置（默认每月 3 次）。
   */
  /** 本月已提交的补卡申请数（被驳回的不占额度） */
  function usedPatchCount() {
    var month = R.monthKeyOf(Date.now());
    return db.patches.filter(function (p) {
      return p.dateKey && p.dateKey.slice(0, 7) === month && p.status !== 'rejected';
    }).length;
  }

  function openPatchSheet(dayKey, type, onDone) {
    var rs = rulesOf();
    var todayKey = R.dayKeyOf(Date.now());
    var month = dayKey.slice(0, 7);
    var used = db.patches.filter(function (p) {
      return p.dateKey && p.dateKey.slice(0, 7) === month && p.status !== 'rejected';
    }).length;

    var check = R.canApplyPatch({ ruleSet: rs, targetDayKey: dayKey, todayKey: todayKey, alreadyCount: used });
    if (!check.ok) {
      openSheet({ title: '无法补卡', body: check.message, confirmText: '知道了', cancelText: false });
      return;
    }

    var quotaText = rs.patch.maxPerMonth > 0
      ? '本' + (month.slice(5) | 0) + '月已用 ' + used + '/' + rs.patch.maxPerMonth + ' 次补卡额度'
      : '补卡次数不限';

    openSheet({
      title: '申请补卡',
      body: dayKey + ' 的' + (type === 'in' ? '上班' : '下班') + '卡\n' + quotaText,
      input: '',
      placeholder: '补卡原因（忘记打卡 / 设备没电 / 在客户现场）',
      confirmText: '提交',
      onConfirm: function (val) {
        var reason = (val || '').trim();
        if (!reason) { toast('请填写原因'); return; }
        db.patches.push({
          id: 'P' + Date.now().toString(36),
          dateKey: dayKey,
          type: type,
          reason: reason,
          status: 'pending',
          createdAt: Date.now(),
        });
        save();
        toast('已提交，等待审批');
        if (onDone) onDone();
      },
    });
  }

  function renderRecords() {
    var r = rulesOf();
    var now = Date.now();
    var todayKey = R.dayKeyOf(now);
    var month = state.month;
    var info = R.monthInfo(month);
    var chain = L.verifyChain(db.records);

    var byKey = {};
    var present = 0, abnormal = 0, workMin = 0, otMin = 0;
    for (var i = 1; i <= info.days; i++) {
      var dk = info.y + '-' + R.pad2(info.m) + '-' + R.pad2(i);
      if (dk > todayKey) break;
      var d = R.pairDay(db.records, r, dk, now);
      byKey[dk] = d;
      if (!d.restDay) {
        if (d.inAt) present += 1;
        if (['late', 'early', 'missing', 'absent', 'under'].indexOf(d.status) >= 0) abnormal += 1;
      }
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
      strip += '<div class="wb-day ' + (wdk === todayKey ? 'today' : '') + '"><span class="wb-w">' + WEEK_SHORT[w + 1] +
        '</span><span class="wb-d">' + Number(wdk.slice(8)) + '</span>' +
        (tone ? '<span class="wb-dot wb-' + tone + '"></span>' : '') + '</div>';
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

      daysHtml += '<div class="day"><div class="day-main" data-day="' + dayKey + '"><div class="day-left">';
      daysHtml += '<div class="day-date"><span class="dd-num">' + R.pad2(j) + '</span><span class="dd-week">' +
        WEEK[R.partsOf(R.msOfDayMinute(dayKey, 720)).weekday] + '</span></div>';
      daysHtml += '<div class="day-tags"><span class="tag tag-' + meta.tone + '">' + meta.label + '</span>';
      if (r.type === 'shift' && day.shiftName) daysHtml += '<span class="tag tag-brand">' + h(day.shiftName) + '</span>';
      if (recs.some(function (x) { return x.geoSkipped; })) daysHtml += '<span class="tag tag-bad">外勤</span>';
      daysHtml += '</div></div><div class="day-right"><div class="day-times">' +
        (day.inAt ? R.hhmmOf(day.inAt) : '--:--') + '<span class="dash">–</span>' + (day.outAt ? R.hhmmOf(day.outAt) : '--:--') +
        '</div><div class="day-work">' + (day.workMinutes ? fmtMin(day.workMinutes) : '—') + '</div></div></div>';

      if (open) {
        daysHtml += '<div class="day-detail">';
        if (!recs.length) daysHtml += '<div class="muted" style="padding:4px 0">当天没有打卡记录</div>';
        recs.forEach(function (x) {
          var bits = [x.source === 'manual' ? '手动补录' : x.source === 'patch' ? '审批补卡' : x.source === 'webapp' ? '网页' : '小程序'];
          if (x.geoSkipped) bits.push('未定位');
          else if (typeof x.dist === 'number') bits.push('距 ' + Math.round(x.dist) + 'm');
          if (x.note) bits.push(x.note);
          if (x.shiftName) bits.push(x.shiftName);
          daysHtml += '<div class="dt-row"><span class="dt-type ' + x.type + '">' + (x.type === 'in' ? '上班' : '下班') + '</span>';
          daysHtml += '<div class="dt-mid"><div class="dt-time">' + R.hhmmssOf(x.at) + '</div><div class="dt-meta">' + h(bits.join(' · ')) + '</div></div>';
          daysHtml += '<span class="dt-hash">' + (x.hash || '').slice(0, 10) + '</span></div>';
        });
        daysHtml += '<div class="dt-actions">' +
          '<button class="dt-link" data-patch="' + dayKey + '">申请补卡</button>' +
          '<button class="dt-link" data-add="' + dayKey + '">手动补录</button></div>';
        daysHtml += '</div>';
      }
      daysHtml += '</div>';
    }

    var html = '<div class="page">';
    html += '<div class="monthbar"><button class="mb-side" data-nav="-1">‹</button>' +
      '<div class="mb-center"><span class="mb-month">' + month + '</span>' +
      '<button class="mb-arrow" data-go="stats">统计 ›</button></div>' +
      '<button class="mb-side" data-nav="1">›</button></div>';

    html += '<div class="card summary"><div class="sum-row">' +
      '<div class="sum-item"><div class="sum-val">' + present + '</div><div class="sum-key">出勤</div></div>' +
      '<div class="sum-item"><div class="sum-val warn">' + abnormal + '</div><div class="sum-key">异常</div></div>' +
      '<div class="sum-item"><div class="sum-val">' + Math.floor(workMin / 60) + 'h</div><div class="sum-key">工时</div></div>' +
      '<div class="sum-item"><div class="sum-val accent">' + Math.floor(otMin / 60) + 'h</div><div class="sum-key">加班</div></div>' +
      '</div></div>';

    html += '<button class="chain ' + (chain.ok ? 'ok' : 'bad') + '" id="verifyBtn">' +
      '<span class="chain-icon">' + (chain.ok ? '✓' : '!') + '</span>' +
      '<span class="chain-text"><span class="chain-title">' + (chain.ok ? '记录完整' : '记录被改动') + '</span>' +
      '<span class="chain-sub">' + (chain.ok
        ? chain.count + ' 条记录完整 · ' + (db.records.length ? db.records[db.records.length - 1].hash.slice(0, 16) + '…' : '—')
        : '第 ' + ((chain.brokenAt || 0) + 1) + ' 条校验失败（' + chain.reason + '）') +
      '</span></span><span class="chain-more">校验 ›</span></button>';

    html += '<div class="weekbar">' + strip + '</div>';
    if (!shown) html += '<div class="empty">本月还没有打卡记录</div>';
    html += daysHtml;
    html += '<div class="muted" style="text-align:center;font-size:11px;margin-top:12px;padding:0 20px;line-height:1.8">' +
      '每条记录都带哈希与前一条的链尾，改动任一条都会被校验发现</div>';
    html += '</div>';

    $body.innerHTML = html;

    $body.querySelectorAll('[data-nav]').forEach(function (el) {
      el.onclick = function () {
        var delta = Number(el.getAttribute('data-nav'));
        var seg = state.month.split('-').map(Number);
        var nd = new Date(Date.UTC(seg[0], seg[1] - 1 + delta, 1));
        var nextKey = nd.getUTCFullYear() + '-' + R.pad2(nd.getUTCMonth() + 1);
        if (nextKey > R.monthKeyOf(Date.now())) return;
        state.month = nextKey;
        renderRecords();
      };
    });

    $body.querySelectorAll('[data-day]').forEach(function (el) {
      el.onclick = function (ev) {
        if (ev.target && ev.target.classList.contains('dt-link')) return;
        var k = el.getAttribute('data-day');
        state.expanded[k] = !state.expanded[k];
        renderRecords();
      };
    });

    document.getElementById('verifyBtn').onclick = function () {
      var c = L.verifyChain(db.records);
      openSheet({
        title: c.ok ? '校验通过' : '校验失败',
        body: c.ok
          ? c.count + ' 条记录完整，最近哈希 ' + (db.records.length ? db.records[db.records.length - 1].hash : '—')
          : '第 ' + ((c.brokenAt || 0) + 1) + ' 条校验失败（' + c.reason + '）。这说明存储的数据被外部改过。',
        confirmText: '知道了',
        cancelText: false,
      });
    };

    $body.querySelectorAll('[data-patch]').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        var k = el.getAttribute('data-patch');
        var d = R.pairDay(db.records, rulesOf(), k, Date.now());
        var type = d.inRec && !d.outRec ? 'out' : 'in';
        openPatchSheet(k, type, function () { renderRecords(); });
      };
    });

    $body.querySelectorAll('[data-add]').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        var k = el.getAttribute('data-add');
        var d = R.pairDay(db.records, rulesOf(), k, Date.now());
        var type = !d.inRec ? 'in' : 'out';
        openSheet({
          title: '手动补录',
          body: '为 ' + k + ' 补一条「' + (type === 'in' ? '上班' : '下班') + '」记录，时间取当前时刻。补录会标记为手动。',
          confirmText: '补录',
          onConfirm: function () {
            var info = R.shiftOfDay(rulesOf(), k);
            db.records = L.append(db.records, {
              uid: db.boot.uid, dateKey: k, type: type, at: Date.now(), clientAt: Date.now(),
              source: 'manual', lat: null, lng: null, acc: null, dist: null, note: '手动补录', patchId: null,
              geoSkipped: true, shiftId: info.shift ? info.shift.id : null, shiftName: info.name,
            }, Date.now());
            db.records[db.records.length - 1].id = L.makeId(db.boot.uid, Date.now(), db.records[db.records.length - 1].seq);
            save();
            toast('已补录');
            renderRecords();
          },
        });
      };
    });

    bindGo();
  }

  /* ======================= 统计页 ======================= */

  function renderStats() {
    var r = rulesOf();
    var now = Date.now();
    var todayKey = R.dayKeyOf(now);
    var month = state.month;
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

    // 出勤构成按"出勤结果"归类，不按"主状态"。
    // 加班日的主状态是 overtime，但它的出勤结果是"正常到了，只是多待了"，
    // 所以归入「正常出勤」并在下面单列一行"其中加班"，否则"正常 15 + 加班 3"
    // 会让人误以为只有 15 天是正常的。
    var counts = { normal: 0, late: 0, early: 0, under: 0, missing: 0, absent: 0, rest: 0 };
    var otDays = 0;
    results.forEach(function (x) {
      if (x.restDay && !x.hasAny) return;
      if (x.status === 'overtime') { counts.normal += 1; otDays += 1; return; }
      counts[x.status] = (counts[x.status] || 0) + 1;
    });
    var totalDays = Object.keys(counts).reduce(function (a, k) { return a + counts[k]; }, 0);
    var distHtml = '';
    ['normal', 'late', 'early', 'under', 'missing', 'absent', 'rest'].forEach(function (k) {
      if (!counts[k]) return;
      var lbl = k === 'normal' ? '正常出勤' : R.statusMeta(k).label;
      var tone = k === 'normal' ? 'ok' : R.statusMeta(k).tone === 'accent' ? 'accent' : R.statusMeta(k).tone;
      var pct = totalDays ? Math.round((counts[k] / totalDays) * 100) : 0;
      distHtml += '<div class="dist"><div class="dist-left"><span class="dist-label">' + lbl +
        '</span><span class="dist-count">' + counts[k] + '</span></div>' +
        '<div class="dist-track"><div class="dist-fill dist-' + tone + '" style="width:' + pct + '%"></div></div></div>';
    });
    if (otDays) {
      distHtml += '<div class="muted" style="margin-top:' + 'var(--s2)' + '">其中 ' + otDays + ' 天有加班，已计入正常出勤</div>';
    }

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
      // 热力底：状态不只靠 4px 点，给格子一层很浅的同色底，让人扫一眼看出"哪一周崩了"
      // 只有"有记录的工作日"才铺底，休息日和未来保持干净
      var heat = '';
      if (dayObj && !dayObj.restDay && dayObj.hasAny && k2 <= todayKey) {
        if (cls.indexOf('bad') >= 0) heat = ' heat-bad';
        else if (cls.indexOf('warn') >= 0) heat = ' heat-warn';
        else heat = ' heat-ok';
      }
      if (k2 === todayKey) cls += ' today';
      cells += '<div class="cell ' + cls.trim() + heat + '"><span class="cell-d">' + dgn + '</span>' + dot + '</div>';
    }

    var bars = '';
    for (var t = 6; t >= 0; t--) {
      var dk2 = R.shiftDayKey(todayKey, -t);
      var d2 = R.pairDay(db.records, r, dk2, now);
      var tone2 = 'ok';
      if (d2.restDay) tone2 = 'mute';
      else if (['missing', 'absent'].indexOf(d2.status) >= 0) tone2 = 'bad';
      else if (['late', 'early', 'under'].indexOf(d2.status) >= 0) tone2 = 'warn';
      bars += '<div class="bar-wrap"><div class="bar-track"><div class="bar-fill bar-' + tone2 +
        '" style="height:' + Math.min(100, Math.round((d2.workMinutes / 600) * 100)) + '%"></div></div>' +
        '<span class="bar-v">' + (d2.workMinutes ? Math.floor(d2.workMinutes / 60) + 'h' : '-') + '</span>' +
        '<span class="bar-l">' + dk2.slice(8) + '</span></div>';
    }

    var html = '<div class="page">';
    html += '<div class="monthbar"><button class="mb-side" data-nav="-1">‹</button>' +
      '<div class="mb-center"><span class="mb-month">' + month + '</span>' +
      '<span class="mb-arrow">' + R.ruleTypeName(r.type) + '</span></div>' +
      '<button class="mb-side" data-nav="1">›</button></div>';

    html += '<div class="hero-card"><div class="hero-main"><div class="hero-num">' + rate +
      '<span class="hero-unit">%</span></div><div class="hero-label">出勤率</div></div>';
    html += '<div class="hero-side"><div class="hs-row"><span class="hs-k">应出勤</span><span class="hs-v">' + workdays.length + ' 天</span></div>' +
      '<div class="hs-row"><span class="hs-k">实际打卡</span><span class="hs-v">' + present + ' 天</span></div>' +
      '<div class="hs-row"><span class="hs-k">有异常</span><span class="hs-v warn">' + abnormal + ' 天</span></div></div></div>';

    html += '<div class="card"><div class="card-title"><span>日历</span><span class="sub">' + month + '</span></div>';
    html += '<div class="grid-hd"><span class="gh">一</span><span class="gh">二</span><span class="gh">三</span>' +
      '<span class="gh">四</span><span class="gh">五</span><span class="gh">六</span><span class="gh">日</span></div>';
    html += '<div class="grid">' + cells + '</div>';
    html += '<div class="legend"><span><i style="background:#10b981"></i>正常</span><span><i style="background:#f59e0b"></i>迟到/早退</span>' +
      '<span><i style="background:#ef4444"></i>缺卡/旷工</span><span><i style="background:#cbd5e1"></i>休息</span></div></div>';

    html += '<div class="card"><div class="card-title"><span>出勤构成</span><span class="sub">' + totalDays + ' 天有记录</span></div>' + distHtml + '</div>';

    html += '<div class="card"><div class="card-title"><span>工时</span><span class="sub">本月合计</span></div><div class="kpi">' +
      '<div class="kpi-item"><div class="kpi-val">' + Math.floor(workMin / 60) + 'h</div><div class="kpi-key">累计工时</div></div>' +
      '<div class="kpi-item"><div class="kpi-val">' + (withWork ? Math.floor(workMin / withWork / 60) + 'h' : '0h') + '</div><div class="kpi-key">日均工时</div></div>' +
      '<div class="kpi-item"><div class="kpi-val accent">' + Math.floor(otMin / 60) + 'h</div><div class="kpi-key">加班合计</div></div></div></div>';

    html += '<div class="card"><div class="card-title"><span>近 7 日</span><span class="sub">每日工时</span></div><div class="bars">' + bars + '</div></div>';
    html += '<div class="muted" style="text-align:center;font-size:11px;margin-top:12px;padding:0 20px;line-height:1.8">' +
      '仅统计考勤（出勤 / 工时 / 异常），不涉及薪资与扣款计算</div>';
    html += '</div>';

    $body.innerHTML = html;

    $body.querySelectorAll('[data-nav]').forEach(function (el) {
      el.onclick = function () {
        var delta = Number(el.getAttribute('data-nav'));
        var seg = state.month.split('-').map(Number);
        var nd = new Date(Date.UTC(seg[0], seg[1] - 1 + delta, 1));
        var nextKey = nd.getUTCFullYear() + '-' + R.pad2(nd.getUTCMonth() + 1);
        if (nextKey > R.monthKeyOf(Date.now())) return;
        state.month = nextKey;
        renderStats();
      };
    });
  }

  /* ======================= 我的 ======================= */

  function renderMe() {
    var r = rulesOf();
    var s = todaySummary();
    var chain = L.verifyChain(db.records);
    var p = R.partsOf(Date.now());

    var html = '<div class="page">';
    html += '<div class="profile"><div class="avatar">' + h((db.boot.nickname || '打').slice(0, 1)) + '</div>';
    html += '<div class="pf-info"><div class="pf-name">' + h(db.boot.nickname || '未设置昵称') + '</div>' +
      '<div class="pf-meta">' + R.ruleTypeName(r.type) + ' · 网页版（本地存储）</div></div>';
    html += '<button class="pf-edit" id="editName">编辑</button></div>';

    html += '<div class="card"><div class="card-title"><span>今日</span><span class="sub">' + p.m + '/' + p.d + ' ' + WEEK[p.weekday] + '</span></div>';
    html += '<div class="row"><span class="k">状态</span><span class="v"><span class="tag tag-' +
      (s.day.hasAny ? s.statusTone : 'mute') + '">' + (s.day.hasAny ? s.statusLabel : s.isRest ? '休息' : '未打卡') + '</span></span></div>';
    if (s.day.inAt) html += row('上班', s.inText);
    if (s.day.outAt) html += row('下班', s.outText);
    var miWork = s.day.inAt && !s.day.outAt
      ? '计时中 ' + fmtMin(Math.max(0, R.diffMinutes(Date.now(), s.day.inAt)))
      : fmtMin(s.day.workMinutes);
    html += row('今日工时', miWork);
    html += '</div>';

    html += '<div class="section-label">考勤规则</div><div class="menu">';
    html += '<button class="menu-item" data-go="rules"><span class="mi-left"><span class="mi-title">考勤规则</span>' +
      '<span class="mi-desc">' + h(R.describeRule(r)) + '</span></span>' +
      '<span class="mi-right"><span class="mi-badge">' + R.ruleTypeName(r.type) + '</span><span class="mi-arrow">›</span></span></button>';
    html += '<button class="menu-item" data-go="stats"><span class="mi-left"><span class="mi-title">考勤统计</span>' +
      '<span class="mi-desc">出勤率、工时、异常分布</span></span><span class="mi-arrow">›</span></button>';
    html += '<button class="menu-item" data-go="admin"><span class="mi-left"><span class="mi-title">审批与异常</span>' +
      '<span class="mi-desc">补卡审批、异常打卡审核</span></span><span class="mi-arrow">›</span></button>';
    html += '</div>';

    html += '<div class="section-label">数据</div><div class="menu">';
    html += '<div class="menu-item"><span class="mi-left"><span class="mi-title">本地记录</span>' +
      '<span class="mi-desc">' + chain.count + ' 条 · 哈希链' + (chain.ok ? '完整' : '异常') + '</span></span>' +
      '<span class="tag tag-' + (chain.ok ? 'ok' : 'bad') + '">' + (chain.ok ? '校验通过' : '校验失败') + '</span></div>';
    html += '<button class="menu-item" id="exportBtn"><span class="mi-left"><span class="mi-title">导出数据</span>' +
      '<span class="mi-desc">下载 JSON 备份文件</span></span><span class="mi-arrow">›</span></button>';
    html += '<button class="menu-item" id="resetBtn"><span class="mi-left"><span class="mi-title bad">清空全部数据</span>' +
      '<span class="mi-desc">删除记录与规则，不可恢复</span></span><span class="mi-arrow">›</span></button>';
    html += '</div>';

    html += '<div class="about"><div class="about-line">考勤打卡 v2 · 数据只存在本机浏览器</div>' +
      '<div class="about-line">参考钉钉考勤模型：固定班制 / 弹性工作制 / 排班制 / 自由工时</div></div>';
    html += '</div>';

    $body.innerHTML = html;

    bindGo();

    document.getElementById('editName').onclick = function () {
      openSheet({
        title: '设置昵称',
        input: db.boot.nickname,
        placeholder: '姓名或昵称',
        confirmText: '保存',
        onConfirm: function (val) {
          db.boot.nickname = String(val || '').slice(0, 20);
          save();
          toast('已保存昵称');
          renderMe();
        },
      });
    };

    document.getElementById('exportBtn').onclick = function () {
      var dump = {
        exportedAt: Date.now(),
        app: 'punch-clock-web',
        version: 2,
        boot: db.boot,
        ruleSet: db.ruleSet,
        records: db.records,
        leaves: db.leaves,
        patches: db.patches,
        presets: db.presets,
        chain: L.verifyChain(db.records),
      };
      var text = JSON.stringify(dump, null, 2);
      try {
        var blob = new Blob([text], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'punch-backup-' + R.dayKeyOf(Date.now()) + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        toast('已导出备份文件');
      } catch (e) {
        copyText(text);
      }
    };

    document.getElementById('resetBtn').onclick = function () {
      openSheet({
        title: '清空全部数据',
        body: '将删除本机所有打卡记录、规则配置与模板，且不可恢复。建议先导出备份。',
        confirmText: '确认清空',
        onConfirm: function () {
          localStorage.removeItem(STORE_KEY);
          db = seed();
          save();
          state.expanded = {};
          state.geo = { status: 'idle', ok: false, dist: null, acc: null, error: '' };
          state.lastPunch = '';
          toast('已清空并重建示例数据');
          go('index');
        },
      });
    };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板'); }, function () { toast('复制失败'); });
    } else {
      toast('当前浏览器不支持一键导出，请用桌面浏览器打开');
    }
  }

  /* ======================= 管理页 ======================= */

  function renderAdmin() {
    var r = rulesOf();
    var pending = db.patches.filter(function (x) { return x.status === 'pending'; });
    var abnormal = db.records
      .filter(function (x) { return x.geoSkipped || (typeof x.dist === 'number' && x.dist > r.geo.radius); })
      .slice(-10)
      .reverse();

    var html = '<div class="page">';
    html += '<div class="section-label">待审批补卡 · ' + pending.length + '</div><div class="card">';
    if (!pending.length) html += '<div class="muted" style="padding:6px 0">没有待处理的补卡申请</div>';
    pending.forEach(function (p1) {
      html += '<div class="dt-row"><div class="dt-mid" style="margin-left:0">' +
        '<div class="dt-time" style="font-size:13.5px">' + p1.dateKey +
        ' <span class="tag tag-brand" style="font-size:10px">' + (p1.type === 'out' ? '下班' : '上班') + '</span></div>' +
        '<div class="dt-meta" style="margin-top:3px">' + h(p1.reason) + '</div></div>' +
        '<button class="dt-link" data-approve="' + h(p1.id) + '">通过</button></div>';
    });
    html += '</div>';

    html += '<div class="section-label">异常打卡 · ' + abnormal.length + '</div><div class="card">';
    if (!abnormal.length) html += '<div class="muted" style="padding:6px 0">本月没有异常记录</div>';
    abnormal.forEach(function (x) {
      html += '<div class="dt-row"><div class="dt-mid" style="margin-left:0">' +
        '<div class="dt-time" style="font-size:13.5px">' + x.dateKey + ' ' + R.hhmmOf(x.at) +
        ' <span class="tag tag-brand" style="font-size:10px">' + (x.type === 'out' ? '下班' : '上班') + '</span> ' +
        '<span class="tag tag-' + (x.geoSkipped ? 'bad' : 'warn') + '" style="font-size:10px">' +
        (x.geoSkipped ? '未定位' : '范围外') + '</span></div>' +
        '<div class="dt-meta" style="margin-top:3px">' +
        (x.geoSkipped ? '无定位' : '距 ' + Math.round(x.dist) + ' 米 · 精度 ±' + (x.acc || 0)) +
        (x.note ? ' · ' + h(x.note) : '') + ' · 序列 ' + x.seq + '</div>' +
        '<div class="mono" style="margin-top:2px">' + (x.hash || '').slice(0, 14) + '</div></div></div>';
    });
    html += '</div>';

    html += '<div class="section-label">本月汇总</div><div class="card">';
    var days = {};
    db.records.forEach(function (x) { days[x.dateKey] = true; });
    html += row('我（本机）', Object.keys(days).length + ' 天 · ' + db.records.length + ' 条');
    html += row('待审补卡', pending.length + ' 条');
    html += '</div>';
    html += '<div class="muted" style="text-align:center;font-size:11px;margin-top:12px;padding:0 20px;line-height:1.8">' +
      '审批通过会新增一条记录并接入哈希链，不会改写历史数据</div>';
    html += '</div>';

    $body.innerHTML = html;

    $body.querySelectorAll('[data-approve]').forEach(function (el) {
      el.onclick = function () {
        var id = el.getAttribute('data-approve');
        var p1 = db.patches.filter(function (x) { return x.id === id; })[0];
        if (!p1) return;
        openSheet({
          title: '通过补卡',
          body: p1.dateKey + ' 的' + (p1.type === 'out' ? '下班' : '上班') + '卡\n原因：' + p1.reason +
            '\n\n通过后会新增一条记录接入哈希链（不改历史）。',
          confirmText: '通过',
          onConfirm: function () {
            p1.status = 'approved';
            p1.reviewedAt = Date.now();
            var info = R.shiftOfDay(rulesOf(), p1.dateKey);
            db.records = L.append(db.records, {
              uid: db.boot.uid, dateKey: p1.dateKey, type: p1.type || 'in', at: Date.now(), clientAt: Date.now(),
              source: 'patch', lat: null, lng: null, acc: null, dist: null, note: '审批补卡：' + p1.reason, patchId: id,
              geoSkipped: true, shiftId: info.shift ? info.shift.id : null, shiftName: info.name,
            }, Date.now());
            db.records[db.records.length - 1].id = L.makeId(db.boot.uid, Date.now(), db.records[db.records.length - 1].seq);
            save();
            toast('已通过，生成一条补卡记录');
            renderAdmin();
          },
        });
      };
    });
  }

  /* ======================= 路由 ======================= */

  var PAGE_ORDER = { index: 0, records: 1, me: 2, rules: 3, stats: 4, admin: 5 };
  var ROOT_PAGES = { index: 1, records: 1, me: 1 };

  function go(page) {
    if (!PAGE_TITLES[page]) return;
    state.page = page;
    render();
  }

  /* 初始化 tabbar 图标：单色 SVG，选中态由 color 继承 */
  function initTabIcons() {
    document.querySelectorAll('[data-icon]').forEach(function (el) {
      var name = el.getAttribute('data-icon');
      if (PC_ICONS[name]) el.innerHTML = PC_ICONS[name](18);
    });
  }

  function render() {
    $navTitle.textContent = PAGE_TITLES[state.page] || '考勤打卡';
    var isRoot = !!ROOT_PAGES[state.page];
    $navBack.classList.toggle('show', !isRoot);

    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-page') === state.page ||
        (state.page === 'rules' && t.getAttribute('data-page') === 'me') ||
        (state.page === 'admin' && t.getAttribute('data-page') === 'me') ||
        (state.page === 'stats' && t.getAttribute('data-page') === 'records'));
    });

    clearTimeout(clockTimer);

    if (state.page === 'index') renderIndex();
    else if (state.page === 'records') renderRecords();
    else if (state.page === 'stats') renderStats();
    else if (state.page === 'rules') renderRules();
    else if (state.page === 'admin') renderAdmin();
    else renderMe();

    $body.scrollTop = 0;
  }

  $navBack.onclick = function () {
    if (state.page === 'rules' || state.page === 'admin') go('me');
    else if (state.page === 'stats') go('records');
    else go('index');
  };

  document.querySelectorAll('.tab').forEach(function (t) {
    t.onclick = function () { go(t.getAttribute('data-page')); };
  });

  $body.addEventListener('scroll', function () {
    $topbar.classList.toggle('scrolled', $body.parentElement.scrollTop > 4 || window.scrollY > 4);
  });

  // 键盘 Esc 关闭弹层
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSheet();
  });

  /* 首次进入自动试一次定位；不支持/非 HTTPS 时静默，等用户点按钮 */
  /** 背景变体：?bg=0(纯净) 1(照片头部+浅蒙版) 2(照片头部+深蒙版) 3(整屏照片) */
  function applyBgVariant() {
    var n = (location.search.match(/bg=([0-5])/) || [])[1] || '0';
    document.body.setAttribute('data-bg', n);
    return n;
  }

  function boot() {
    applyBgVariant();
    initTabIcons();
    render();
    var r = rulesOf();
    if (r.geo.enabled && geoSupported() && window.isSecureContext) {
      navigator.permissions && navigator.permissions.query
        ? navigator.permissions.query({ name: 'geolocation' }).then(function (st) {
            if (st.state === 'granted') requestGeo();
          }).catch(function () {})
        : null;
    }
  }

  // 暴露给自动化测试
  window.__pc = {
    go: go,
    state: state,
    db: function () { return db; },
    setGeo: function (o) { state.geo = Object.assign({ status: 'ok', ok: true, dist: 100, acc: 20, error: '' }, o || {}); render(); },
    punch: function (o) { writePunch(o); },
    rule: function (t) { db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { type: t })); save(); render(); },
  };

  boot();
})();
