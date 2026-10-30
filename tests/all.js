/**
 * 一键跑全部测试：node tests/all.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const files = ['core.test.js', 'hash-consistency.test.js', 'server-rules.test.js', 'rule-compare.test.js', 'pages.test.js', 'cloud.test.js', 'web.test.js'];
let failed = 0;

files.forEach((f) => {
  const abs = path.join(__dirname, f);
  process.stdout.write('\n=== ' + f + ' ===\n');
  const r = spawnSync(process.execPath, [abs], { stdio: 'inherit', timeout: 120000 });
  if (r.status !== 0) failed += 1;
});

process.stdout.write('\n' + (failed ? 'FAILED suites: ' + failed : 'ALL SUITES PASSED') + '\n');
process.exit(failed ? 1 : 0);
