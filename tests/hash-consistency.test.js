/**
 * 客户端 / 云端哈希一致性测试
 *
 * 这是"防篡改"的地基：两端算出的 hash 必须完全一致，否则云端 verify
 * 会把客户端写上去的记录全判为篡改。
 *
 * 对比：miniprogram/core/ledger.js  <->  cloudfunctions/_shared/common.js
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const clientLedger = require('../miniprogram/core/ledger');
const cloudCommon = require(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'common.js'));

const samples = [
  {
    name: 'typical fixed in-punch',
    rec: { uid: 'U1', dateKey: '2026-10-30', type: 'in', at: 1793321820000, clientAt: 1793321820000, source: 'miniprogram', lat: 39.90871, lng: 116.397412, acc: 22, dist: 96, note: '', patchId: null, geoSkipped: false },
  },
  {
    name: 'chinese note (must not be escaped)',
    rec: { uid: 'U2', dateKey: '2026-10-29', type: 'out', at: 1793400000000, clientAt: 1793400001000, source: 'manual', lat: 31.230416, lng: 121.473701, acc: 55.5, dist: 301.25, note: '外勤：客户现场', patchId: 'Pabc', geoSkipped: false },
  },
  {
    name: 'no-geo record with nulls',
    rec: { uid: 'U3', dateKey: '2026-10-28', type: 'in', at: 1793300000000, clientAt: 1793300000000, source: 'miniprogram', lat: null, lng: null, acc: null, dist: null, note: '', patchId: null, geoSkipped: true },
  },
  {
    name: 'negative rounding',
    rec: { uid: 'U4', dateKey: '2026-10-27', type: 'out', at: 1793200000000, clientAt: 1793200000000, source: 'cloud', lat: 39.9000001, lng: 116.3999999, acc: 0.4, dist: 12.34, note: '', patchId: null, geoSkipped: false },
  },
  {
    name: 'emoji + surrogate note',
    rec: { uid: 'U5', dateKey: '2026-10-26', type: 'in', at: 1793100000000, clientAt: 1793100000000, source: 'miniprogram', lat: 39.908823, lng: 116.39747, acc: 12, dist: 3, note: '电梯里打的卡 😀', patchId: null, geoSkipped: false },
  },
  {
    name: 'wifi assisted',
    rec: { uid: 'U6', dateKey: '2026-10-25', type: 'in', at: 1793050000000, clientAt: 1793050000000, source: 'miniprogram', lat: 39.908823, lng: 116.39747, acc: 18, dist: 4, note: '', patchId: null, geoSkipped: false, wifiSsid: 'Corp-5G' },
  },
  {
    name: 'shift record',
    rec: { uid: 'U7', dateKey: '2026-10-24', type: 'out', at: 1793000000000, clientAt: 1793000000000, source: 'miniprogram', lat: 39.908823, lng: 116.39747, acc: 18, dist: 4, note: '', patchId: null, geoSkipped: false, shiftId: 'B', shiftName: '中班' },
  },
];

test('client ledger hash === cloud common hash for every sample', () => {
  samples.forEach(({ name, rec }) => {
    assert.equal(clientLedger.hashOf(rec, 'genesis'), cloudCommon.hashRecord(rec, 'genesis'), 'hash mismatch: ' + name);
  });
});

test('chained prev hash also matches across both impls', () => {
  const prev = 'b'.repeat(64);
  samples.forEach(({ name, rec }) => {
    assert.equal(clientLedger.hashOf(rec, prev), cloudCommon.hashRecord(rec, prev), 'chained mismatch: ' + name);
  });
});

test('both normalize lat/lng/acc/dist/at identically', () => {
  const rec = { uid: 'U9', dateKey: '2026-10-26', type: 'in', at: 1793100000.6, clientAt: 1793100000.4, source: 'miniprogram', lat: 39.9087104999, lng: 116.3974120002, acc: 22.0000001, dist: 95.9999999, note: '', patchId: null, geoSkipped: false };
  assert.equal(clientLedger.hashOf(rec, 'genesis'), cloudCommon.hashRecord(rec, 'genesis'));
  const n = clientLedger.normalize(rec);
  assert.equal(n.at, 1793100001);
  assert.equal(n.clientAt, 1793100000);
  assert.equal(n.lat, 39.90871);
  assert.equal(n.acc, 22);
  assert.equal(n.dist, 96);
});

test('stableStringify sorts keys recursively', () => {
  assert.equal(clientLedger.stableStringify({ b: 1, a: { d: 2, c: 1 } }), '{"a":{"c":1,"d":2},"b":1}');
  assert.equal(clientLedger.stableStringify({ a: { c: 1, d: 2 }, b: 1 }), clientLedger.stableStringify({ b: 1, a: { d: 2, c: 1 } }));
});

test('HASH_FIELDS identical between client and cloud', () => {
  assert.deepEqual(clientLedger.HASH_FIELDS.slice().sort(), cloudCommon.HASH_FIELDS.slice().sort());
});

test('client-built chain is verifiable by cloud algorithm', () => {
  let list = [];
  ['in', 'out'].forEach((type, i) => {
    list = clientLedger.append(
      list,
      { uid: 'U7', dateKey: '2026-10-30', type, at: 1793321820000 + i * 3600000, clientAt: 1793321820000, source: 'miniprogram', lat: 39.90871, lng: 116.397412, acc: 20, dist: 96, note: '', patchId: null, geoSkipped: false },
      1793400000000
    );
  });
  let prev = 'genesis';
  list.forEach((r) => {
    assert.equal(cloudCommon.hashRecord(r, prev), r.hash);
    prev = r.hash;
  });
  assert.equal(clientLedger.verifyChain(list).ok, true);
});

test('extra fields (shiftName 等) 不参与哈希，改动它们不影响校验', () => {
  const base = { uid: 'U8', dateKey: '2026-10-30', type: 'in', at: 1793321820000, clientAt: 1793321820000, source: 'miniprogram', lat: 39.90871, lng: 116.397412, acc: 20, dist: 96, note: '', patchId: null, geoSkipped: false };
  const h1 = clientLedger.hashOf(base, 'genesis');
  const withExtra = Object.assign({}, base, { shiftName: '中班', shiftId: 'B', wifiSsid: 'Corp' });
  const h2 = clientLedger.hashOf(withExtra, 'genesis');
  // 参与哈希的字段是白名单，额外字段一律不参与 —— 这是有意设计：
  // shiftName 属于「展示层派生信息」，改它不应该让记录变成"被篡改"
  assert.equal(h1, h2);
});
