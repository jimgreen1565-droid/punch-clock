/**
 * 云端封装（微信云开发）
 *
 * 目标：同一套页面代码，既能跑"没有云环境"的本地演示，也能在开通云开发后无缝切云端。
 * 约定：所有云函数入参 { action, payload }，返回 { ok, data, error }。
 */
const ENV_ID = ''; // 填入你的云环境 ID，例如 'punch-prod-8gxxxx'；留空 = 纯本地模式

let ready = false;
let failedReason = '';

function init() {
  if (ready) return true;
  if (!ENV_ID) {
    failedReason = 'no-env-id';
    return false;
  }
  if (!wx.cloud) {
    failedReason = 'no-cloud-sdk';
    return false;
  }
  try {
    wx.cloud.init({ env: ENV_ID, traceUser: true });
    ready = true;
    return true;
  } catch (e) {
    failedReason = e && e.message ? e.message : 'init-failed';
    return false;
  }
}

function isReady() {
  return ready;
}

function reason() {
  return failedReason;
}

/**
 * 调用云函数。云端不可用时返回 { ok:false, offline:true }，调用方自行降级本地。
 */
function call(name, action, payload) {
  return new Promise((resolve) => {
    if (!init()) {
      resolve({ ok: false, offline: true, error: failedReason || 'offline' });
      return;
    }
    wx.cloud.callFunction({
      name,
      data: { action, payload: payload || {} },
      success: (res) => {
        const r = res && res.result;
        if (r && typeof r === 'object') resolve(r);
        else resolve({ ok: false, error: 'bad-response' });
      },
      fail: (err) => {
        resolve({ ok: false, offline: true, error: (err && err.errMsg) || 'call-failed' });
      },
    });
  });
}

module.exports = { ENV_ID, init, isReady, reason, call };
