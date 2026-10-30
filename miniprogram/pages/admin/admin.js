const store = require('../../utils/store');
const cloud = require('../../utils/cloud');
const rules = require('../../core/rules');

const FLAG_LABEL = {
  geoSkipped: '未定位',
  outOfRange: '范围外',
  timeSkew: '时钟异常',
  patched: '补卡',
  outside: '外勤',
};

const FLAG_TONE = {
  geoSkipped: 'bad',
  outOfRange: 'warn',
  timeSkew: 'bad',
  patched: 'brand',
  outside: 'warn',
};

Page({
  data: {
    pending: [],
    abnormal: [],
    summary: [],
    recordCount: 0,
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    const month = rules.monthKeyOf(Date.now());

    if (cloud.isReady()) {
      const [p, s] = await Promise.all([
        cloud.call('admin', 'pending', { month }),
        cloud.call('admin', 'summary', { month }),
      ]);
      if (p && p.ok) {
        this.setData({
          pending: (p.data.patches || []).map((x) => ({
            id: x._id || x.id,
            dateKey: x.dateKey,
            type: x.type,
            reason: x.reason || '未填写',
          })),
          abnormal: (p.data.abnormal || []).map(shapeAbnormal),
        });
      }
      if (s && s.ok) {
        this.setData({
          summary: (s.data.users || []).map((u) => ({
            key: u.openid,
            name: u.openid.slice(-6),
            days: u.days,
            abnormal: u.abnormal,
            otHours: Math.round((u.overtimeMinutes / 60) * 10) / 10,
          })),
        });
      }
      this.setData({ recordCount: store.verifyLocalChain().count });
      return;
    }

    // 本地模式：只看自己
    const patches = store.getPatches().filter((x) => x.status === 'pending');
    const rs = store.getRuleSet();
    const records = store.getRecords();
    const chain = store.verifyLocalChain();

    const abnormal = records
      .filter((r) => r.geoSkipped || (typeof r.dist === 'number' && r.dist > rs.geo.radius))
      .slice(-12)
      .reverse()
      .map((r) =>
        shapeAbnormal({
          _id: r.id,
          dateKey: r.dateKey,
          at: r.at,
          type: r.type,
          dist: r.dist,
          acc: r.acc,
          lat: r.lat,
          lng: r.lng,
          seq: r.seq,
          hash: r.hash,
          note: r.note,
          hashFlags: r.geoSkipped ? ['geoSkipped'] : ['outOfRange'],
        })
      );

    const now = Date.now();
    const days = new Set();
    let abn = 0;
    let ot = 0;
    records.forEach((r) => {
      if (!days.has(r.dateKey)) {
        days.add(r.dateKey);
        const d = rules.pairDay(records, rs, r.dateKey, now);
        if (['late', 'early', 'missing', 'absent', 'under'].indexOf(d.status) >= 0) abn += 1;
        ot += d.overtimeMinutes;
      }
    });

    this.setData({
      pending: patches.map((x) => ({ id: x.id, dateKey: x.dateKey, type: x.type || 'in', reason: x.reason || '未填写' })),
      abnormal,
      summary: [
        {
          key: 'me',
          name: '我（本机）',
          days: days.size,
          abnormal: abn,
          otHours: Math.round((ot / 60) * 10) / 10,
        },
      ],
      recordCount: chain.count,
    });
  },

  async approve(e) {
    const id = e.currentTarget.dataset.id;
    if (cloud.isReady()) {
      const r = await cloud.call('admin', 'approvePatch', { patchId: id, approve: true });
      if (!r.ok) {
        wx.showToast({ title: (r.error && r.error.message) || '失败', icon: 'none' });
        return;
      }
    } else {
      store.resolvePatch(id, 'approved');
      // 本地模式：审批通过时补一条 source=patch 的记录（与云端行为一致）
      const p = store.getPatches().find((x) => x.id === id);
      if (p) {
        const info = rules.shiftOfDay(store.getRuleSet(), p.dateKey);
        store.addRecord({
          type: p.type || 'in',
          at: Date.now(),
          dateKey: p.dateKey,
          source: 'manual',
          note: '审批补卡：' + (p.reason || ''),
          patchId: id,
          shiftId: info.shift ? info.shift.id : null,
          shiftName: info.name,
        });
      }
    }
    wx.showToast({ title: '已通过', icon: 'success' });
    this.refresh();
  },

  reject(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '驳回补卡',
      content: '确认驳回这条补卡申请？',
      confirmColor: '#ef4444',
      success: async (r) => {
        if (!r.confirm) return;
        if (cloud.isReady()) {
          const res = await cloud.call('admin', 'approvePatch', { patchId: id, approve: false });
          if (!res.ok) {
            wx.showToast({ title: (res.error && res.error.message) || '失败', icon: 'none' });
            return;
          }
        } else {
          store.resolvePatch(id, 'rejected');
        }
        wx.showToast({ title: '已驳回', icon: 'none' });
        this.refresh();
      },
    });
  },
});

function shapeAbnormal(x) {
  const flags = (x.hashFlags || []).map((f) => ({
    key: f,
    label: FLAG_LABEL[f] || f,
    tone: FLAG_TONE[f] || 'warn',
  }));
  const bits = [];
  if (typeof x.dist === 'number' && x.dist !== null) bits.push('距 ' + Math.round(x.dist) + ' 米');
  if (typeof x.acc === 'number' && x.acc !== null) bits.push('精度 ±' + Math.round(x.acc));
  if (x.note) bits.push('备注：' + x.note);
  bits.push('序列 ' + x.seq);
  return {
    id: x._id,
    dayKey: x.dateKey,
    hhmm: rules.hhmmOf(x.at),
    type: x.type,
    metaText: bits.join(' · '),
    hashShort: (x.hash || '').slice(0, 14),
    flags,
  };
}
