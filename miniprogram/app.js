/**
 * 小程序入口
 */
const store = require('./utils/store');
const cloud = require('./utils/cloud');

App({
  globalData: {
    uid: null,
    nickname: '',
    cloudReady: false,
    env: 'local',
    todoCount: 0,
  },

  onLaunch() {
    store.init();
    const boot = store.getBootInfo();
    this.globalData.uid = boot.uid;
    this.globalData.nickname = boot.nickname || '';
    this.globalData.env = boot.env;

    const ok = cloud.init();
    this.globalData.cloudReady = ok;
    if (ok) this.globalData.env = 'cloud';

    this.refreshBadge();
  },

  onShow() {
    this.refreshBadge();
  },

  /** 刷新「记录」tab 的小红点：今日异常 + 待审补卡 */
  refreshBadge() {
    try {
      const n = store.unresolvedCount();
      this.globalData.todoCount = n;
      if (n > 0) {
        wx.setTabBarBadge({ index: 1, text: String(n > 99 ? '99+' : n) });
      } else {
        wx.removeTabBarBadge({ index: 1 });
      }
    } catch (e) {
      // tabBar 未渲染完成时会报错，忽略
    }
  },
});
