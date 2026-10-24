/**
 * 交作业深链。全部参数集中在这一个函数——云邮改路由只改这里。
 *
 * 依据 docs/api-reference.md §3.2【实测】：详情页 mounted 直接从
 * $route.query 读 assignmentId 并立即请求作业信息，不依赖任何前置状态。
 * 不带 refresh_token（§3.4 的安全权衡：长效凭证不进 URL）。
 * 不能深链列表页（§3.3：它从 site-id cookie 读课程，冷启动会空）。
 *
 * 2026-10-24 晚补充（二次实测，见 api-reference §3.2.1）：浏览器没有云邮
 * 会话时会被弹到 CAS，而 CAS 桌面皮肤对现代浏览器服务端故障（皮肤 iframe
 * 400 → 白屏）。dev=1 强制老式表单的方案同样证伪：浏览器带 CAS cookie 后
 * dev=1 链接稳定 400。桌面端登录云邮的路目前被学校服务端堵死；微信内
 * CAS 自动企微识别不受影响，手机上始终可用。所以这里就是裸深链——
 * 有云邮会话的浏览器直达，没有的靠前端文案引导。
 */
export function buildAssignmentUrl(assignmentId) {
  return 'https://ucloud.bupt.edu.cn/uclass/course.html#/student/assignmentDetails_fullpage'
    + `?activeTabName=first&assignmentId=${encodeURIComponent(assignmentId)}`
}
