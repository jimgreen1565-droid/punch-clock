/**
 * 云函数逻辑测试（不连真云，用内存版 wx-server-sdk 替身）
 *
 * 为什么必须测：
 *   服务端授时/复算围栏/哈希链这三件事是"打卡可信"的全部根基，
 *   一旦这里写错（比如用了客户端 at），前端再漂亮也等于没有考勤。
 *   这里用内存数据库把 punch 云函数真跑一遍，逐条核对：
 *     1. at 必须等于服务端时钟，不能用客户端传的
 *     2. 时钟偏移要打 timeSkew 标记但依然可打卡
 *     3. 范围外 strictGeo=true 时必须拒绝
 *     4. 连续打卡 hash 链必须串得上，且 verify 返回 ok
 *     5. 改一条记录后 verify 必须报 hash-mismatch
 *     6. 频率限制生效
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

/* ---------- 内存版 wx-server-sdk ---------- */

function makeDb() {
  const store = {}; // collection -> array of docs
  let autoId = 0;

  function coll(name) {
    if (!store[name]) store[name] = [];
    return store[name];
  }

  function matches(doc, where) {
    return Object.keys(where || {}).every((k) => {
      const cond = where[k];
      if (cond && typeof cond === 'object' && cond._gt !== undefined) return doc[k] >= cond._gt;
      if (cond && typeof cond === 'object' && cond._in !== undefined) return cond._in.indexOf(doc[k]) >= 0;
      if (cond && typeof cond === 'object' && cond._neq !== undefined) return doc[k] !== cond._neq;
      return doc[k] === cond;
    });
  }

  function query(name) {
    const state = { where: null, order: null, lim: 1000 };
    const api = {
      where(w) {
        state.where = w;
        return api;
      },
      orderBy(field, dir) {
        state.order = { field, dir };
        return api;
      },
      limit(n) {
        state.lim = n;
        return api;
      },
      async get() {
        let rows = coll(name).filter((d) => matches(d, state.where));
        if (state.order) {
          const { field, dir } = state.order;
          rows = rows.slice().sort((a, b) => (dir === 'desc' ? (b[field] > a[field] ? 1 : -1) : a[field] > b[field] ? 1 : -1));
        }
        return { data: rows.slice(0, state.lim) };
      },
      async count() {
        return { total: coll(name).filter((d) => matches(d, state.where)).length };
      },
      async update(payload) {
        const rows = coll(name).filter((d) => matches(d, state.where));
        rows.forEach((d) => Object.assign(d, payload.data));
        return { updated: rows.length };
      },
      async add(payload) {
        const id = 'doc' + ++autoId;
        const doc = Object.assign({ _id: id }, payload.data);
        coll(name).push(doc);
        return { _id: id };
      },
    };
    return api;
  }

  return {
    command: {
      gte: (v) => ({ _gt: v }),
      in: (arr) => ({ _in: arr }),
      neq: (v) => ({ _neq: v }),
    },
    collection(name) {
      const api = query(name);
      api.doc = (id) => ({
        async get() {
          const doc = coll(name).find((d) => d._id === id);
          if (!doc) throw new Error('not found');
          return { data: doc };
        },
        async update(payload) {
          const doc = coll(name).find((d) => d._id === id);
          if (doc) Object.assign(doc, payload.data);
          return { updated: 1 };
        },
      });
      return api;
    },
    _store: store,
  };
}

const fakeDb = makeDb();
const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'fake',
  init: () => {},
  database: () => fakeDb,
  getWXContext: () => ({ OPENID: 'openid-test-1', APPID: 'wx_test' }),
};

// 拦截 require('wx-server-sdk')
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'wx-server-sdk') return 'wx-server-sdk';
  return origResolve.call(this, request, ...args);
};
require.cache['wx-server-sdk'] = { id: 'wx-server-sdk', filename: 'wx-server-sdk', loaded: true, exports: fakeSdk };

function loadCloudFunction(name) {
  // 云函数目录里有 index.js + common.js
  const dir = path.join(__dirname, '..', 'cloudfunctions', name);
  const commonPath = path.join(dir, 'common.js');
  const indexPath = path.join(dir, 'index.js');
  // 确保 common.js 已同步
  delete require.cache[commonPath];
  delete require.cache[indexPath];
  const mod = require(indexPath);
  return mod.main;
}

/* ---------- 测试 ---------- */

function resetCloud() {
  Object.keys(fakeDb._store).forEach((k) => delete fakeDb._store[k]);
}

function seedConfig(env, opts) {
  const cfg = Object.assign(
    {
      companyId: 'default',
      company: { name: '示例科技', lat: 39.908823, lng: 116.39747, radius: 300 },
      shift: { start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], lateGrace: 5, earlyGrace: 5, overtimeMin: 30 },
      strictGeo: true,
      allowSkipGeo: true,
    },
    opts || {}
  );
  fakeDb._store.pc_configs = [{ _id: 'cfg1', ...cfg }];
  fakeDb._store.pc_users = [{ _id: 'u1', openid: 'openid-test-1', role: 'employee', companyId: 'default', status: 'active' }];
}

test('punch: uses SERVER time, never the client-supplied at', async () => {
  resetCloud();
  seedConfig();
  const punch = loadCloudFunction('punch');
  // 客户端谎报自己是 09:00 准点到（实际服务端现在可能是任何时间）
  const fakeClientAt = (() => {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : n);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 1, 0) + ''; // 大致 09:00 +8
  })();

  const r = await punch({
    action: 'punch',
    payload: { type: 'in', clientAt: Number(fakeClientAt), lat: 39.90871, lng: 116.397412, acc: 20 },
  });

  assert.equal(r.ok, true);
  const rec = fakeDb._store.pc_punches[0];
  const drift = Math.abs(rec.at - rec.clientAt);
  assert.ok(rec.at > Date.now() - 5000, 'at 应接近服务端当前时间');
  assert.ok(drift > 0, '客户端谎报时间应与服务端不一致（drift=' + drift + '）');
  assert.ok(r.data.hashFlags.indexOf('timeSkew') >= 0 || drift <= 90000, '偏移超阈值应打 timeSkew');
});

test('punch: strict geofence rejects far-away coordinates', async () => {
  resetCloud();
  seedConfig();
  const punch = loadCloudFunction('punch');
  const r = await punch({
    action: 'punch',
    payload: { type: 'in', lat: 40.5, lng: 117.5, acc: 20, clientAt: Date.now() },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OUT_OF_RANGE');
  assert.ok(r.geo.dist > 300, 'dist should exceed radius');
  assert.equal(fakeDb._store.pc_punches ? fakeDb._store.pc_punches.length || 0 : 0, 0, 'must not write when rejected');
});

test('punch: low-accuracy position inside radius is still rejected', async () => {
  resetCloud();
  seedConfig();
  const punch = loadCloudFunction('punch');
  // 坐标就在公司点上，但精度 ±600 米 -> 无法确认，应拒绝
  const r = await punch({
    action: 'punch',
    payload: { type: 'in', lat: 39.908823, lng: 116.39747, acc: 600, clientAt: Date.now() },
  });
  assert.equal(r.ok, false);
  assert.equal(r.geo.reason, 'low-accuracy');
});

test('punch: skip-geo allowed but flagged', async () => {
  resetCloud();
  seedConfig();
  const punch = loadCloudFunction('punch');
  const r = await punch({ action: 'punch', payload: { type: 'in', geoSkipped: true, clientAt: Date.now() } });
  assert.equal(r.ok, true);
  assert.ok(r.data.hashFlags.indexOf('geoSkipped') >= 0);
  assert.equal(fakeDb._store.pc_punches[0].geoSkipped, true);
});

test('punch: hash chain links sequential punches and verify passes', async () => {
  resetCloud();
  seedConfig();
  const punch = loadCloudFunction('punch');

  const a = await punch({ action: 'punch', payload: { type: 'in', lat: 39.90871, lng: 116.397412, acc: 20, clientAt: Date.now() } });
  assert.equal(a.data.seq, 1);
  assert.equal(a.data.prevHash, 'genesis');

  const b = await punch({ action: 'punch', payload: { type: 'out', lat: 39.90871, lng: 116.397412, acc: 20, clientAt: Date.now() } });
  assert.equal(b.data.seq, 2);
  assert.equal(b.data.prevHash, a.data.hash);

  const v = await punch({ action: 'verify', payload: {} });
  assert.equal(v.data.ok, true);
  assert.equal(v.data.count, 2);
});

test('punch: tampering a stored record breaks verify', async () => {
  resetCloud();
  seedConfig();
  const punch = loadCloudFunction('punch');
  await punch({ action: 'punch', payload: { type: 'in', lat: 39.90871, lng: 116.397412, acc: 20, clientAt: Date.now() } });
  await punch({ action: 'punch', payload: { type: 'out', lat: 39.90871, lng: 116.397412, acc: 20, clientAt: Date.now() } });

  // 模拟有人直接改数据库：把第一条的迟到分钟改掉
  fakeDb._store.pc_punches[0].lateMinutes = 0;
  fakeDb._store.pc_punches[0].dist = 5;

  const v = await punch({ action: 'verify', payload: {} });
  assert.equal(v.data.ok, false);
  assert.equal(v.data.reason, 'hash-mismatch');
  assert.equal(v.data.brokenAt, 0);
});

test('punch: rate limit kicks in after 5 punches in a minute', async () => {
  resetCloud();
  seedConfig();
  const punch = loadCloudFunction('punch');
  let blocked = 0;
  for (let i = 0; i < 7; i++) {
    const r = await punch({ action: 'punch', payload: { type: 'in', lat: 39.90871, lng: 116.397412, acc: 20, clientAt: Date.now() } });
    if (!r.ok && r.error.code === 'RATE_LIMITED') blocked += 1;
  }
  assert.ok(blocked >= 1, 'expected at least one rate-limited response, got ' + blocked);
});

test('punch: list returns only this user month records', async () => {
  resetCloud();
  seedConfig();
  const punch = loadCloudFunction('punch');
  await punch({ action: 'punch', payload: { type: 'in', lat: 39.90871, lng: 116.397412, acc: 20, clientAt: Date.now() } });
  const r = await punch({ action: 'list', payload: {} });
  assert.equal(r.ok, true);
  assert.equal(r.data.records.length, 1);
  assert.ok(r.data.month.length === 7);
  assert.equal(typeof r.data.serverNow, 'number');
});

test('login: creates profile once then reuses it', async () => {
  resetCloud();
  fakeDb._store.pc_users = [];
  const login = loadCloudFunction('login');

  const first = await login({ action: 'login', payload: { nickname: '阿伟' } });
  assert.equal(first.ok, true);
  assert.equal(first.data.openid, 'openid-test-1');
  assert.equal(first.data.isNew, true);
  assert.equal(fakeDb._store.pc_users.length, 1);

  const second = await login({ action: 'login', payload: {} });
  assert.equal(second.data.isNew, false);
  assert.equal(fakeDb._store.pc_users.length, 1, 'must not duplicate profile');
});

test('admin: non-admin is rejected for summary', async () => {
  resetCloud();
  seedConfig();
  const admin = loadCloudFunction('admin');
  const r = await admin({ action: 'summary', payload: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'FORBIDDEN');
});

test('admin: manager can read summary and approve a patch', async () => {
  resetCloud();
  seedConfig();
  fakeDb._store.pc_users[0].role = 'manager';
  fakeDb._store.pc_patches = [
    { _id: 'p1', openid: 'openid-test-1', dateKey: '2026-10-28', type: 'in', reason: '忘记打卡', status: 'pending', createdAt: Date.now(), companyId: 'default' },
  ];
  const admin = loadCloudFunction('admin');

  const s = await admin({ action: 'summary', payload: {} });
  assert.equal(s.ok, true);
  assert.ok(Array.isArray(s.data.users));

  const a = await admin({ action: 'approvePatch', payload: { patchId: 'p1', approve: true, at: Date.now() } });
  assert.equal(a.ok, true);
  assert.equal(a.data.status, 'approved');
  assert.equal(fakeDb._store.patches ? 0 : fakeDb._store.pc_patches[0].status, 'approved');
  // 生成了一条 source=patch 的打卡记录
  const recs = fakeDb._store.pc_punches || [];
  assert.ok(recs.some((x) => x.source === 'patch'), 'patch approval should append a record');

  // 重复审批被拒
  const again = await admin({ action: 'approvePatch', payload: { patchId: 'p1', approve: true } });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'ALREADY_DONE');
});
