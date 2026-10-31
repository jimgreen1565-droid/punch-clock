/**
 * 把公司/权限接入 webapp/app.js（第二版：按行定位，不依赖大段上下文）
 *
 * 上一版用大段多行锚点，app.js 稍有换行/空格差异就匹配不上。
 * 这一版改成"在指定行附近做小范围替换"，容错高得多。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const f = path.join(ROOT, 'webapp', 'app.js');
let s = fs.readFileSync(f, 'utf8');
// Windows 下 app.js 可能是 CRLF；统一成 LF 再匹配
if (s.indexOf('\r\n') >= 0) s = s.replace(/\r\n/g, '\n');
const done = [];

function once(pattern, replacement, tag) {
  const re = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : pattern;
  if (!re.test(s)) throw new Error('not found: ' + tag);
  s = s.replace(re, replacement);
  done.push(tag);
}

/* ---------- 1. boot 初始化公司 ---------- */
once(
  /  function boot\(\) \{\n    applyBgVariant\(\);\n    applyPalette\(\);/,
  `  function boot() {
    applyBgVariant();
    applyPalette();
    // 初始化公司：首次打开自动建一家，自己成为创建者
    if (window.PC_COMPANY) {
      PC_COMPANY.ensureCompany(db.boot.nickname);
      var c0 = PC_COMPANY.getCompany();
      if (c0 && c0.ruleSet) db.ruleSet = c0.ruleSet;
    }`,
  'boot'
);

/* ---------- 2. renderRules 开头取权限 ---------- */
once(
  /  function renderRules\(\) \{\n    var r = rulesOf\(\);/,
  `  function renderRules() {
    var r = rulesOf();
    // 权限：没有 rule.edit 就进只读模式
    var canEdit = window.PC_COMPANY ? PC_COMPANY.canDo('rule.edit') : true;
    var meName = window.PC_COMPANY && PC_COMPANY.memberOf(PC_COMPANY.currentUid())
      ? PC_COMPANY.memberOf(PC_COMPANY.currentUid()).nickname : '';`,
  'canEdit'
);

/* ---------- 3. 只读提示（插在"选择考勤规则"标签前）---------- */
once(
  /    html \+= '<div class="section-label">选择考勤规则<\/div><div class="options">';/,
  `    if (!canEdit) {
      html += '<div class="readonly-note">考勤规则由管理员统一设置，你可以查看但不能修改。如需调整请联系管理员。</div>';
    }

    html += '<div class="section-label">选择考勤规则</div><div class="options">';`,
  'readonly note'
);

/* ---------- 4. 规则选项加 readonly 类 ---------- */
once(
  /      html \+= '<button class="option ' \+ \(active \? 'active' : ''\) \+ '" data-type="' \+ t\.id \+ '">';/,
  `      html += '<button class="option ' + (active ? 'active' : '') + (canEdit ? '' : ' readonly') + '" data-type="' + t.id + '">';`,
  'option readonly class'
);

/* ---------- 5. 规则选项点击门禁 ---------- */
once(
  /    \$body\.querySelectorAll\('\[data-type\]'\)\.forEach\(function \(el\) \{\n      el\.onclick = function \(\) \{\n        var t = el\.getAttribute\('data-type'\);/,
  `    $body.querySelectorAll('[data-type]').forEach(function (el) {
      el.onclick = function () {
        if (!canEdit) {
          toast('考勤规则由管理员设置，你只能查看');
          return;
        }
        var t = el.getAttribute('data-type');`,
  'option click guard'
);

/* ---------- 6. patchRule 统一门禁 + 同步公司 ---------- */
once(
  /  function patchRule\(patch\) \{\n    db\.ruleSet = R\.normalizeRuleSet\(Object\.assign\(\{\}, db\.ruleSet, patch\)\);/,
  `  function patchRule(patch) {
    // 统一门禁：没有 rule.edit 直接拒绝（不只是隐藏入口）
    if (window.PC_COMPANY && !PC_COMPANY.canDo('rule.edit')) {
      toast('考勤规则由管理员设置，你只能查看');
      return;
    }
    db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, patch));`,
  'patchRule guard'
);

/* ---------- 7. 规则切换写回公司 ---------- */
once(
  /            db\.ruleSet = R\.normalizeRuleSet\(Object\.assign\(\{\}, db\.ruleSet, \{ type: t \}\)\);\n            save\(\);/,
  `            db.ruleSet = R.normalizeRuleSet(Object.assign({}, db.ruleSet, { type: t }));
            if (window.PC_COMPANY) PC_COMPANY.setCompanyRuleSet(db.ruleSet);
            save();`,
  'switch sync company'
);

/* ---------- 8. 规则参数区：只读时用静态行 ---------- */
once(
  /    html \+= '<div class="section-label">规则参数<\/div><div class="card">';\n    if \(r\.type === 'fixed'\) \{/,
  `    html += '<div class="section-label">规则参数</div><div class="card">';
    if (!canEdit) {
      var ro = function (k, v) { return '<div class="row"><span class="k">' + k + '</span><span class="v dim">' + v + '</span></div>'; };
      if (r.type === 'fixed') {
        html += ro('上班时间', r.start) + ro('下班时间', r.end) + ro('工作日', R.weekdaysText(r.weekdays))
          + ro('午休时段', r.breakStart ? r.breakStart + '-' + r.breakEnd : '未设置')
          + ro('迟到宽限', r.lateGrace + ' 分钟') + ro('早退宽限', r.earlyGrace + ' 分钟');
      } else if (r.type === 'flexible') {
        html += ro('最晚上班', r.latestStart) + ro('最早下班', r.earliestEnd)
          + ro('每日应满工时', R.fmtMinuteText(r.requiredMinutes)) + ro('工作日', R.weekdaysText(r.weekdays));
      } else if (r.type === 'shift') {
        html += ro('周期轮换', r.rotation.enabled ? '已开启' : '未开启');
        if (r.rotation.enabled) {
          html += ro('轮换周期', r.rotation.cycleDays + ' 天');
          html += ro('班次顺序', r.rotation.slots.map(R.slotName(r)).join(' → '));
        } else {
          html += ro('上班时间', r.start) + ro('下班时间', r.end);
        }
        html += ro('工作日', R.weekdaysText(r.weekdays));
      } else {
        html += ro('每日目标工时', R.fmtMinuteText(r.dailyTargetMinutes)) + ro('判定方式', '不判迟到早退');
      }
      html += '</div>';
    } else if (r.type === 'fixed') {`,
  'params readonly'
);

/* ---------- 9. 补卡规则区：只读 ---------- */
once(
  /    html \+= rowTappable\('允许补卡', /,
  `    if (!canEdit) {
      html += '<div class="row"><span class="k">允许补卡</span><span class="v dim">' + (r.patch.allow ? '允许' : '不允许') + '</span></div>';
      if (r.patch.allow) {
        html += '<div class="row"><span class="k">可补天数</span><span class="v dim">' + (r.patch.maxDays === 0 ? '仅当天' : '过去 ' + r.patch.maxDays + ' 天') + '</span></div>';
        html += '<div class="row"><span class="k">每月上限</span><span class="v dim">' + (r.patch.maxPerMonth === 0 ? '不限' : r.patch.maxPerMonth + ' 次') + '</span></div>';
      }
      html += '<div class="muted" style="padding-top:var(--s2)">本月已提交 ' + usedPatchCount() + ' 次补卡申请</div>';
      html += '</div>';
    } else {
    html += rowTappable('允许补卡', `,
  'patch readonly'
);

/* 关闭上面那个 else 块：补卡区结尾的 </div> 之后 */
once(
  /    html \+= '<div class="muted" style="padding-top:' \+ 'var\(--s2\)' \+ '">本月已提交 ' \+ usedPatchCount\(\) \+ ' 次补卡申请<\/div>';\n    html \+= '<\/div>';\n\n    html \+= '<div class="section-label">打卡方式<\/div><div class="card">';/,
  `    html += '<div class="muted" style="padding-top:' + 'var(--s2)' + '">本月已提交 ' + usedPatchCount() + ' 次补卡申请</div>';
    html += '</div>';
    }

    html += '<div class="section-label">打卡方式</div><div class="card">';`,
  'patch readonly close'
);

/* ---------- 10. 打卡方式区：只读 ---------- */
once(
  /      html \+= rowTappable\('打卡点坐标', r\.geo\.lat\.toFixed\(5\) \+ ', ' \+ r\.geo\.lng\.toFixed\(5\), 'here'\);\n      html \+= rowTappable\('范围半径', r\.geo\.radius \+ ' 米', 'num', 'radius'\);\n      html \+= rowTappable\('范围外打卡', r\.geo\.strict \? '禁止' : '允许（填外勤原因）', 'strict'\);\n      html \+= rowTappable\('位置校验', r\.geo\.enabled \? '已开启（点击关闭）' : '已关闭（点击开启）', 'geoToggle'\);/,
  `      if (canEdit) {
        html += rowTappable('打卡点坐标', r.geo.lat.toFixed(5) + ', ' + r.geo.lng.toFixed(5), 'here');
        html += rowTappable('范围半径', r.geo.radius + ' 米', 'num', 'radius');
        html += rowTappable('范围外打卡', r.geo.strict ? '禁止' : '允许（填外勤原因）', 'strict');
        html += rowTappable('位置校验', r.geo.enabled ? '已开启（点击关闭）' : '已关闭（点击开启）', 'geoToggle');
      } else {
        html += '<div class="row"><span class="k">打卡点坐标</span><span class="v dim">' + r.geo.lat.toFixed(5) + ', ' + r.geo.lng.toFixed(5) + '</span></div>';
        html += '<div class="row"><span class="k">范围半径</span><span class="v dim">' + r.geo.radius + ' 米</span></div>';
        html += '<div class="row"><span class="k">范围外打卡</span><span class="v dim">' + (r.geo.strict ? '禁止' : '允许（填外勤原因）') + '</span></div>';
      }`,
  'geo readonly'
);

/* ---------- 11. 模板区：只读时整块不给 ---------- */
once(
  /    html \+= '<div class="section-label">规则模板<\/div><div class="card">';/,
  `    if (canEdit) {
    html += '<div class="section-label">规则模板</div><div class="card">';`,
  'templates open'
);

once(
  /    html \+= '<button class="btn" id="savePreset">保存当前规则为模板<\/button><\/div>';\n\n    html \+= '<div class="muted" style="text-align:center;font-size:11px;margin-top:12px;padding:0 20px;line-height:1.85">' \+\n      '切换规则后今天的判定按新规则重算，但已产生的打卡记录不会被改写（哈希不变）<\/div>';/,
  `    html += '<button class="btn" id="savePreset">保存当前规则为模板</button></div>';
    }

    html += '<div class="muted" style="text-align:center;font-size:11px;margin-top:12px;padding:0 20px;line-height:1.85">' +
      (canEdit
        ? '切换规则后今天的判定按新规则重算，但已产生的打卡记录不会被改写（哈希不变）'
        : '规则由管理员统一设置，所有成员看到的是同一份') + '</div>';`,
  'templates close'
);

fs.writeFileSync(f, s);
console.log('✓ 全部 %d 处接入完成:', done.length);
done.forEach((t) => console.log('   -', t));
