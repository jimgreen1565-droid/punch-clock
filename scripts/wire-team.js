/**
 * 给 app.js 加最小的 4 个钩子（第二版，最小侵入）
 *
 * 前两版试图插入大段代码，互相覆盖、锚点失配。这一版只做 4 件事：
 *   1. PAGE_TITLES 加 team
 *   2. render 路由分流到 EXTRA_PAGES
 *   3. 我的页菜单加"公司与成员"入口（一行）
 *   4. 我的页插入"身份切换"块（一行）
 * 具体渲染全部在 team.js 里，app.js 不承担任何团队逻辑。
 */
const fs = require('fs');
const path = require('path');

const f = path.resolve(__dirname, '..', 'webapp', 'app.js');
let s = fs.readFileSync(f, 'utf8');
// Windows 下 app.js 可能是 CRLF；统一成 LF 再匹配，最后按原样写回（保持 LF）
const hadCRLF = s.indexOf('\r\n') >= 0;
if (hadCRLF) s = s.replace(/\r\n/g, '\n');
const done = [];
function once(re, rep, tag) {
  if (!re.test(s)) throw new Error('MISS: ' + tag);
  s = s.replace(re, rep);
  done.push(tag);
}

/* 1. 标题表 + 扩展表 */
once(
  /  var PAGE_TITLES = \{ index: '考勤打卡', records: '打卡记录', stats: '考勤统计', me: '我的', rules: '考勤规则', admin: '审批与异常' \};/,
  `  var PAGE_TITLES = { index: '考勤打卡', records: '打卡记录', stats: '考勤统计', me: '我的', rules: '考勤规则', admin: '审批与异常', team: '公司与成员' };

  /* 外部页面注册表（team.js 填入），以及"我的页"附加块 */
  var EXTRA_PAGES = {};
  var ME_EXTRA = [];`,
  'titles+extra'
);

/* 2. render 路由 */
once(
  /    else renderMe\(\);/,
  `    else if (EXTRA_PAGES[state.page]) {
      var pg = EXTRA_PAGES[state.page];
      $body.innerHTML = pg.render();
      if (pg.bind) pg.bind($body, render, toast);
      bindGo();
    }
    else renderMe();`,
  'render route'
);

/* 3. 我的页菜单入口：紧跟"考勤规则"那一行之前插入 */
once(
  /    html \+= '<button class="menu-item" data-go="rules"><span class="mi-left"><span class="mi-title">考勤规则<\/span>' \+/,
  `    if (window.PC_COMPANY && window.PC_COMPANY.getCompany()) {
      var _c = window.PC_COMPANY.getCompany();
      var _rl = window.PC_COMPANY.roleOf();
      if (_c && _rl) {
        html += '<button class="menu-item" data-go="team"><span class="mi-left"><span class="mi-title">公司与成员</span>' +
          '<span class="mi-desc">' + h(_c.name) + ' · ' + h(window.PC_COMPANY.roleName(_rl)) +
          ' · ' + window.PC_COMPANY.getMembers().length + ' 人</span></span>' +
          '<span class="mi-right"><span class="mi-badge">' + h(window.PC_COMPANY.roleName(_rl)) + '</span><span class="mi-arrow">›</span></span></button>';
      }
    }
    html += '<button class="menu-item" data-go="rules"><span class="mi-left"><span class="mi-title">考勤规则</span>' +`,
  'me company entry'
);

/* 4. 我的页插入身份切换块 + 绑定 */
once(
  /    \$body\.innerHTML = html;\n\n    bindGo\(\);\n\n    document\.getElementById\('editName'\)/,
  `    if (ME_EXTRA.length) {
      var _x = ME_EXTRA.map(function (d) { return d.html ? d.html() : ''; }).join('');
      if (_x) html = html.replace('<div class="section-label">考勤规则</div>', _x + '<div class="section-label">考勤规则</div>');
    }

    $body.innerHTML = html;

    bindGo();

    if (ME_EXTRA.length) {
      ME_EXTRA.forEach(function (d) { if (d.bind) d.bind($body, toast); });
    }

    document.getElementById('editName')`,
  'me extra inject'
);

/* 5. 暴露注册 API 与 reload */
once(
  /    rule: function \(t\) \{ db\.ruleSet = R\.normalizeRuleSet\(Object\.assign\(\{\}, db\.ruleSet, \{ type: t \}\)\); save\(\); render\(\); \},\n  \};/,
  `    rule: function (t) { db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { type: t })); if (window.PC_COMPANY) PC_COMPANY.setCompanyRuleSet(db.ruleSet); save(); render(); },
    registerPage: function (key, def) { EXTRA_PAGES[key] = def; if (def.title) PAGE_TITLES[key] = def.title; },
    registerMeExtra: function (def) { ME_EXTRA.push(def); },
    openSheet: openSheet,
    toast: toast,
    reloadWithIdentity: function () { location.reload(); },
    currentPage: function () { return state.page; },
  };`,
  'register api'
);

fs.writeFileSync(f, s);
console.log('✓ %d 个钩子接入:', done.length);
done.forEach((t) => console.log('   -', t));
