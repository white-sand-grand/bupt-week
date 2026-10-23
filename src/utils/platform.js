/**
 * 运行环境判定。全站唯一入口——微信 webview 的行为分支
 * （自动企微识别、企微登录按钮）都依赖它，散落各处会改漏。
 */

/** 是否跑在微信内置浏览器里。企业微信的 webview UA 也带 MicroMessenger。 */
export function isInWechatBrowser() {
  return /MicroMessenger/i.test(navigator.userAgent)
}
