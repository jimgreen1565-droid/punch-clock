/**
 * 小程序工程静态校验（在没有微信开发者工具的环境里，尽可能把"编译不过"提前拦住）
 *
 * 检查 8 类问题：
 *   1. app.json 里每个 pages 条目，四件套（js/json/wxml/wxss）是否齐全
 *   2. tabBar 的 iconPath / selectedIconPath 是否真实存在，且 PNG 头合法、尺寸 ≤ 81x81 规定
 *   3. WXML 标签是否闭合、属性引号是否成对、{{ }} 是否配对
 *   4. WXML 里 {{foo}} 引用的字段，是否在 Page 的 data 里声明（或来自 wx:for 的 item/index）
 *   5. WXML 里 bindtap="fn" 绑定的事件，Page 对象上是否有该函数
 *   6. JSON 文件是否能解析、页面 json 是否只有合法键
 *   7. 所有 js 文件语法检查（node --check 的等价：new Function）
 *   8. 是否误用了小程序不支持的特性（wx:for 缺 wx:key 提示、require 绝对路径等）
 *
 * 退出码非 0 表示有 error。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

const errors = [];
const warns = [];

function err(file, msg) {
  errors.push(path.relative(ROOT, file) + ': ' + msg);
}
function warn(file, msg) {
  warns.push(path.relative(ROOT, file) + ': ' + msg);
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    err(file, 'JSON 解析失败 — ' + e.message);
    return null;
  }
}

/* ---------------- 1 & 2: app.json / 四件套 / 图标 ---------------- */

const appJson = readJSON(path.join(MP, 'app.json'));
if (!appJson) {
  errors.push('app.json 不可用，中止');
  report();
}

const pages = appJson.pages || [];
const EXT = ['js', 'json', 'wxml', 'wxss'];

pages.forEach((p) => {
  const base = path.join(MP, p);
  EXT.forEach((ext) => {
    const f = base + '.' + ext;
    if (!fs.existsSync(f)) {
      // wxss / json 允许缺省，但 js + wxml 必须有
      if (ext === 'js' || ext === 'wxml') err(path.join(MP, 'app.json'), 'pages 缺少文件 ' + p + '.' + ext);
      else warn(path.join(MP, p + '.' + ext), '建议补上该文件（可选）');
    }
  });
});

/** 校验 PNG 头部与尺寸（tabBar 图标规范：81x81，≤40KB） */
function checkPng(file) {
  if (!fs.existsSync(file)) {
    err(file, '图标文件不存在');
    return null;
  }
  const buf = fs.readFileSync(file);
  if (buf.length < 24) {
    err(file, '不是合法 PNG（过短）');
    return null;
  }
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) {
      err(file, 'PNG 签名不合法');
      return null;
    }
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (buf.length > 40 * 1024) warn(file, '文件 ' + (buf.length / 1024).toFixed(0) + 'KB，tabBar 图标建议 <40KB');
  return { w, h, bytes: buf.length };
}

if (appJson.tabBar && appJson.tabBar.list) {
  appJson.tabBar.list.forEach((item) => {
    const iconFile = path.join(MP, item.iconPath || '');
    const activeFile = path.join(MP, item.selectedIconPath || '');
    const a = checkPng(iconFile);
    const b = checkPng(activeFile);
    [a, b].forEach((info, i) => {
      if (!info) return;
      const f = i === 0 ? iconFile : activeFile;
      if (info.w > 81 || info.h > 81) err(f, '尺寸 ' + info.w + 'x' + info.h + ' 超过 81x81 限制');
      if (info.w !== info.h) warn(f, '非正方形 ' + info.w + 'x' + info.h);
    });
    // tabBar 页面必须在 pages 里
    if (pages.indexOf(item.pagePath) < 0) err(path.join(MP, 'app.json'), 'tabBar 页面未在 pages 声明: ' + item.pagePath);
  });
}

/* ---------------- 3 & 4 & 5: WXML 检查 ---------------- */

/** 极简 WXML 解析：栈式扫描标签，跳过注释、跳过自闭合 */
function parseWxml(src, file) {
  const tags = [];
  const stack = [];
  const bindings = [];
  const mustaches = [];

  // 去掉注释
  const clean = src.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));

  // 扫描 {{ }}
  const mRe = /\{\{([\s\S]*?)\}\}/g;
  let mm;
  while ((mm = mRe.exec(clean))) {
    mustaches.push(mm[1]);
  }
  // {{ 与 }} 数量必须一致
  const openCount = (clean.match(/\{\{/g) || []).length;
  const closeCount = (clean.match(/\}\}/g) || []).length;
  if (openCount !== closeCount) err(file, '{{ 与 }} 数量不匹配 (' + openCount + ' vs ' + closeCount + ')');

  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
  let tm;
  while ((tm = tagRe.exec(clean))) {
    const raw = tm[0];
    const name = tm[1];
    const attrs = tm[2] || '';
    const selfClose = tm[3] === '/';
    const isClose = raw.startsWith('</');

    // 属性引号成对
    const quotes = (attrs.match(/"/g) || []).length;
    if (quotes % 2 !== 0) err(file, '标签 <' + name + '> 属性引号不成对: ' + attrs.slice(0, 60));

    // 收集事件绑定
    const bindRe = /\b(?:bind|catch)(?::)?([a-zA-Z]+)\s*=\s*"([^"]*)"/g;
    let bm;
    while ((bm = bindRe.exec(attrs))) {
      bindings.push({ event: bm[1], handler: bm[2].trim() });
    }

    if (selfClose) continue;
    if (isClose) {
      const top = stack.pop();
      if (!top) {
        err(file, '多余的闭合标签 </' + name + '>');
      } else if (top !== name) {
        err(file, '标签嵌套错误：<' + top + '> 未闭合就出现 </' + name + '>');
      }
    } else {
      stack.push(name);
      tags.push(name);
    }
  }
  stack.forEach((t) => err(file, '标签 <' + t + '> 未闭合'));

  return { mustaches, bindings };
}

/** 从 {{ }} 表达式里提取顶层 data 字段名（排除 item/index 等循环变量） */
function extractTopFields(exprs, locals) {
  const fields = new Set();
  const skip = locals || new Set(['item', 'index']);
  ['true', 'false', 'null', 'undefined'].forEach((x) => skip.add(x));
  exprs.forEach((expr) => {
    // 去掉字符串字面量，避免误采集
    const s = expr.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    // 三目/运算里的标识符
    const idRe = /(^|[^.\w$])([a-zA-Z_$][\w$]*)/g;
    let im;
    while ((im = idRe.exec(s))) {
      const name = im[2];
      if (skip.has(name)) continue;
      if (/^(Math|Date|JSON|String|Number|Boolean|null)$/.test(name)) continue;
      fields.add(name);
    }
  });
  return fields;
}

/** 收集 wx:for 的别名（wx:for-item / wx:for-index）以及模板作用域局部变量 */
function collectLocals(src) {
  const locals = new Set(['item', 'index']);
  const re = /wx:for-(?:item|index)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    const v = m[1].trim();
    if (v) locals.add(v);
  }
  return locals;
}

/* 从每个页面 JS 里拿 data 键与 Page 方法名：用沙箱执行 page 文件 */
function loadPageInfo(pagePath) {
  const jsFile = path.join(MP, pagePath + '.js');
  const src = fs.readFileSync(jsFile, 'utf8');
  let captured = null;

  const sandbox = {
    Page: (cfg) => {
      captured = cfg;
    },
    getApp: () => ({ globalData: {}, refreshBadge() {} }),
    wx: {},
    console,
    module: { exports: {} },
    require: (p) => {
      // 递归加载相对路径，返回模块 exports（用真实 require 最简单）
      return require(path.resolve(path.dirname(jsFile), p));
    },
  };

  // 用 vm 执行，避免污染
  const vm = require('vm');
  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(src, ctx, { filename: jsFile, timeout: 5000 });
  } catch (e) {
    err(jsFile, '页面脚本执行失败 — ' + e.message);
    return { dataKeys: new Set(), methods: new Set() };
  }
  if (!captured) {
    err(jsFile, '未调用 Page({})');
    return { dataKeys: new Set(), methods: new Set() };
  }
  const dataKeys = new Set(Object.keys(captured.data || {}));
  const methods = new Set(
    Object.keys(captured).filter((k) => typeof captured[k] === 'function')
  );
  return { dataKeys, methods, config: captured };
}

pages.forEach((p) => {
  const wxmlFile = path.join(MP, p + '.wxml');
  if (!fs.existsSync(wxmlFile)) return;
  const src = fs.readFileSync(wxmlFile, 'utf8');
  const { mustaches, bindings } = parseWxml(src, wxmlFile);

  const info = loadPageInfo(p);
  const fields = extractTopFields(mustaches, collectLocals(src));

  // 4: 字段必须在 data 里
  fields.forEach((f) => {
    if (!info.dataKeys.has(f)) {
      err(wxmlFile, '{{' + f + '}} 未在 Page data 中声明');
    }
  });

  // 5: 事件处理函数必须存在
  bindings.forEach((b) => {
    if (!info.methods.has(b.handler)) {
      err(wxmlFile, 'bind' + b.event + '="' + b.handler + '" 在 Page 上不存在');
    }
  });

  // 8: wx:for 必须有 wx:key
  const forTags = [];
  const forRe = /<([a-zA-Z][\w-]*)([^>]*wx:for=[^>]*)>/g;
  let fm;
  while ((fm = forRe.exec(src))) {
    if (!/wx:key/.test(fm[2])) forTags.push(fm[1]);
  }
  forTags.forEach((t) => warn(wxmlFile, '<' + t + '> 有 wx:for 但缺 wx:key（会触发控制台告警并影响复用）'));
});

/* ---------------- 6: 页面 json 合法键 ---------------- */

const PAGE_JSON_KEYS = new Set(['navigationBarTitleText', 'navigationBarBackgroundColor', 'navigationBarTextStyle', 'backgroundColor', 'backgroundTextStyle', 'enablePullDownRefresh', 'onReachBottomDistance', 'disableScroll', 'usingComponents']);
pages.forEach((p) => {
  const f = path.join(MP, p + '.json');
  if (!fs.existsSync(f)) return;
  const j = readJSON(f);
  if (!j) return;
  Object.keys(j).forEach((k) => {
    if (!PAGE_JSON_KEYS.has(k)) warn(f, '页面 json 出现非常规键 ' + k);
  });
});

/* ---------------- 7: 所有 js 语法 ---------------- */

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) walk(f, out);
    else out.push(f);
  });
  return out;
}

const allJs = walk(path.join(ROOT, 'miniprogram'), []).concat(walk(path.join(ROOT, 'cloudfunctions'), [])).filter((f) => f.endsWith('.js'));

allJs.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vmScript(src, f);
  } catch (e) {
    err(f, '语法错误 — ' + e.message);
  }
});

function vmScript(src, filename) {
  const vm = require('vm');
  new vm.Script(src, { filename });
}

/* ---------------- 8: 其它约定 ---------------- */

// 小程序不支持 require 绝对路径
allJs.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const m = /require\(\s*['"]\/([^'"]+)['"]\s*\)/.exec(src);
  if (m) err(f, "不要用绝对路径 require('/" + m[1] + "')");
});

// app.json 必需字段
if (!appJson.window) err(path.join(MP, 'app.json'), '缺少 window 配置');
if (!appJson.sitemapLocation) warn(path.join(MP, 'app.json'), '建议声明 sitemapLocation');

/* ---------------- 输出 ---------------- */

function report() {
  if (warns.length) {
    console.log('\n⚠  ' + warns.length + ' 条提示');
    warns.forEach((w) => console.log('   ' + w));
  }
  if (errors.length) {
    console.log('\n✖  ' + errors.length + ' 条错误');
    errors.forEach((e) => console.log('   ' + e));
    process.exit(1);
  }
  console.log('\n✔ 静态校验通过（' + allJs.length + ' 个 js，' + pages.length + ' 个页面）');
  process.exit(0);
}

report();
