/**
 * 把 cloudfunctions/_shared/common.js 复制到每个云函数目录。
 * 云函数之间不能互相 import，否则上传时会缺文件。
 * 用法：node scripts/sync-shared.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const shared = path.join(root, 'cloudfunctions', '_shared', 'common.js');
const src = fs.readFileSync(shared, 'utf8');

const targets = fs
  .readdirSync(path.join(root, 'cloudfunctions'))
  .filter((d) => d !== '_shared' && fs.existsSync(path.join(root, 'cloudfunctions', d, 'index.js')));

targets.forEach((d) => {
  const dst = path.join(root, 'cloudfunctions', d, 'common.js');
  fs.writeFileSync(dst, src, 'utf8');
  console.log('  ->', path.relative(root, dst));
});
console.log('synced shared/common.js into', targets.length, 'functions');
