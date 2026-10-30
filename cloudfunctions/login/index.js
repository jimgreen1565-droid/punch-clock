/**
 * 云函数：login
 * 作用：下发 openid / appid，注册或读取员工档案，返回员工所属公司与班次配置
 */
const cloud = require('wx-server-sdk');
const C = require('./common');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COL_USER = 'pc_users';

exports.main = async (event) => {
  const { OPENID, APPID, UNIONID } = cloud.getWXContext();
  if (!OPENID) return C.fail('NO_OPENID', '无法获取 openid，请确认从小程序内调用');

  const { action, payload } = C.parseEvent(event);
  const now = Date.now();

  try {
    if (action === 'profile') {
      const r = await db.collection(COL_USER).where({ openid: OPENID }).limit(1).get();
      const doc = r.data && r.data[0];
      return C.ok({ openid: OPENID, appid: APPID, unionid: UNIONID || null, profile: doc || null });
    }

    // 默认：login / upsert
    const r = await db.collection(COL_USER).where({ openid: OPENID }).limit(1).get();
    let doc = r.data && r.data[0];
    if (!doc) {
      const add = {
        openid: OPENID,
        appid: APPID,
        unionid: UNIONID || null,
        nickname: (payload && payload.nickname) || '',
        role: (payload && payload.role) || 'employee',
        companyId: (payload && payload.companyId) || 'default',
        createdAt: now,
        lastLoginAt: now,
        status: 'active',
      };
      const ins = await db.collection(COL_USER).add({ data: add });
      doc = Object.assign({ _id: ins._id }, add);
    } else {
      await db.collection(COL_USER).doc(doc._id).update({
        data: { lastLoginAt: now, appid: APPID },
      });
    }

    return C.ok({
      openid: OPENID,
      appid: APPID,
      role: doc.role,
      companyId: doc.companyId,
      nickname: doc.nickname,
      isNew: !r.data || !r.data.length,
    });
  } catch (e) {
    return C.fail('DB_ERROR', (e && e.message) || 'db error');
  }
};
