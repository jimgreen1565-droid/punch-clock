/**
 * 定位与围栏计算
 *
 * 关键取舍：
 * - 用 Haversine（球面距离），不用平面勾股：300 米量级两者差 < 1 米可忽略，
 *   但跨纬度/大范围时 Haversine 才是对的，成本也一样。
 * - accuracy（GPS 精度圆）必须参与判定：精度 500 米的定位落在圆心也不能算"到了"，
 *   否则等于没校验。判定用 dist - acc <= radius 的"宽松有效范围"，
 *   同时在结果里同时返回 dist / acc / effective 三个数，让用户看到为什么被拒。
 * - 拿不到定位不等于失败：允许"无定位打卡"并打上 geoSkipped 标记，交由管理端审核。
 */
const EARTH_R = 6371008.8; // 米，IUGG 平均半径

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** 两点球面距离（米） */
function distance(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every((v) => typeof v === 'number' && isFinite(v))) return null;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_R * c;
}

/**
 * 围栏判定
 * @param {object} pos {lat, lng, acc}
 * @param {object} fence {lat, lng, radius}
 * @returns {{ok, dist, acc, effective, margin, reason}}
 */
function inFence(pos, fence) {
  if (!pos || !fence) {
    return { ok: false, dist: null, acc: null, effective: null, margin: null, reason: 'no-position' };
  }
  const dist = distance(pos.lat, pos.lng, fence.lat, fence.lng);
  if (dist === null) {
    return { ok: false, dist: null, acc: null, effective: null, margin: null, reason: 'bad-coord' };
  }
  const acc = typeof pos.acc === 'number' && isFinite(pos.acc) ? Math.max(0, pos.acc) : 0;
  const radius = Math.max(0, Number(fence.radius) || 0);
  const effective = dist - acc; // 保守估计：最坏情况下可能离得最近的距离
  // 两道门槛：① 有效距离进圈 ② 精度圆本身不能比围栏还大（否则等于没校验）
  const ok = effective <= radius && acc <= radius;
  let reason = 'ok';
  if (!ok) {
    if (acc > radius) reason = 'low-accuracy';
    else reason = 'out-of-range';
  }
  return {
    ok,
    dist: Math.round(dist * 10) / 10,
    acc: Math.round(acc * 10) / 10,
    effective: Math.round(effective * 10) / 10,
    margin: Math.round((radius - effective) * 10) / 10,
    radius,
    reason,
  };
}

/**
 * 获取定位。type: 'gcj02'（微信地图坐标，与 wx.openLocation 一致）
 * 兼容新版 wx.getLocation 的 success/fail 与 Promise 双形态。
 */
function getLocation(options) {
  return new Promise((resolve) => {
    const opts = Object.assign(
      { type: 'gcj02', isHighAccuracy: true, highAccuracyExpireTime: 4000 },
      options || {}
    );
    wx.getLocation({
      type: opts.type,
      isHighAccuracy: opts.isHighAccuracy,
      highAccuracyExpireTime: opts.highAccuracyExpireTime,
      success: (res) => {
        resolve({
          ok: true,
          lat: res.latitude,
          lng: res.longitude,
          acc: typeof res.accuracy === 'number' ? res.accuracy : null,
          provider: res.provider || '',
          altitude: res.altitude,
        });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || 'getLocation:fail';
        const denied = /auth|deny|denied|authorize/i.test(msg);
        resolve({ ok: false, denied, error: msg });
      },
    });
  });
}

/** 当前 WiFi 信息（用于 WiFi 辅助校验；小程序只能在部分机型拿到 SSID） */
function getWifi() {
  return new Promise((resolve) => {
    const api = wx.getWifiList ? wx.getConnectedWifi : null;
    if (!api) {
      resolve({ ok: false, error: 'unsupported' });
      return;
    }
    api({
      partialInfo: true,
      success: (res) => resolve({ ok: true, ssid: (res && res.wifi && res.wifi.SSID) || '', bssid: (res && res.wifi && res.wifi.BSSID) || '' }),
      fail: (err) => resolve({ ok: false, error: (err && err.errMsg) || 'wifi-fail' }),
    });
  });
}

module.exports = { distance, inFence, getLocation, getWifi, EARTH_R };
