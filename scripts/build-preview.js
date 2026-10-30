/**
 * 把 miniprogram/core/ 与 utils/geo.js 打包成浏览器可直接用的 bundle
 *
 * 为什么连 geo 也打包进来：Web 版用 navigator.geolocation，但围栏判定算法
 * （Haversine + accuracy 门槛）必须与小程序完全一致，否则同一坐标两种结论。
 * geo.js 里的距离/围栏函数本身不含 wx API，可以直接复用。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const coreFiles = ['sha256.js', 'rules.js', 'ledger.js'];
const out = path.join(root, 'demo', 'core-bundle.js');
const outWeb = path.join(root, 'webapp', 'core-bundle.js');

let js = '(function(){\nvar __mods = {};\nvar __cache = {};\n';
js += 'function __req(name){\n  var k = name.replace(/^(\\.\\/|\\.\\.\\/)+/,"").replace(/\\.js$/,"");\n';
js += '  if(__cache[k]) return __cache[k].exports;\n  var m = { exports: {} };\n  __cache[k] = m;\n  __mods[k](m, m.exports, __req);\n  return m.exports;\n}\n';

coreFiles.forEach((f) => {
  const src = fs.readFileSync(path.join(root, 'miniprogram', 'core', f), 'utf8');
  const name = f.replace(/\.js$/, '');
  js += '__mods["' + name + '"] = function(module, exports, require){\n' + src + '\n};\n';
});

// geo.js：去掉 module.exports 之外的东西照原样打进来，需要的只是纯函数
const geoPath = path.join(root, 'miniprogram', 'utils', 'geo.js');
let geoSrc = fs.readFileSync(geoPath, 'utf8');
// geo.js 里有 wx.getLocation/getWifi 这类小程序 API；Web 版不用它们，但打包不能因此报错。
// 用一个空 wx 兜底，保证 require 阶段不炸（真正调用走 Web 自己的 navigator 实现）。
const wxStub = 'var wx = (typeof window !== "undefined" && window.wx) || { getLocation: function(){}, getWifiList: function(){} };\n';
js += '__mods["geo"] = function(module, exports, require){\n' + wxStub + geoSrc + '\n};\n';

js += 'window.PC = {\n  rules: __req("rules"),\n  ledger: __req("ledger"),\n  sha256: __req("sha256"),\n  geo: __req("geo")\n};\n';
js += '})();\n';

fs.writeFileSync(out, js, 'utf8');
fs.writeFileSync(outWeb, js, 'utf8');
console.log('wrote core-bundle.js ->', path.relative(root, out), '&', path.relative(root, outWeb), (js.length / 1024).toFixed(1) + 'KB');
