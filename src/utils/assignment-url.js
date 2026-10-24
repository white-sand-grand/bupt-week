/**
 * 交作业深链。全部参数集中在这一个函数——云邮改路由只改这里。
 *
 * 依据 docs/api-reference.md §3.2【实测】：详情页 mounted 直接从
 * $route.query 读 assignmentId 并立即请求作业信息，不依赖任何前置状态。
 * 不带 refresh_token（§3.4 的安全权衡：长效凭证不进 URL）。
 * 不能深链列表页（§3.3：它从 site-id cookie 读课程，冷启动会空）。
 */
export function buildAssignmentUrl(assignmentId) {
  return 'https://ucloud.bupt.edu.cn/uclass/course.html#/student/assignmentDetails_fullpage'
    + `?activeTabName=first&assignmentId=${encodeURIComponent(assignmentId)}`
}

/**
 * 「去交作业」的落地入口：经统一身份认证，且强制 CAS 的老式登录表单。
 *
 * 为什么不直接开深链（2026-10-24 实测，详见 api-reference §3.2）：
 * 浏览器没有云邮会话时，深链会被 SPA 弹到 CAS 登录页，而 CAS 桌面皮肤
 * 的 login-normal.html（iframe 方案）从浏览器发起【稳定 400】——用户看到
 * 的就是白屏，表单在 DOM 里但在视口外且页面 overflow:hidden。微信 UA 会在
 * 加载皮肤前就被 CAS 自动转去企微识别，不受影响；坏的只是桌面浏览器路径。
 *
 * `dev=1` 是 CAS 自己留的开关（init.js）：跳过 iframe，直接显示内联老式
 * 表单，实测 3/3 稳定渲染。service 用完整深链（CAS 前缀匹配放行，实测），
 * 这样浏览器里已有云邮会话的人会被 CAS 自动直通到这份作业；没有会话的人
 * 登录后落在云邮首页，回本页再点一次「去交作业」即可。
 */
export function buildAssignmentEntryUrl(assignmentId) {
  return 'https://auth.bupt.edu.cn/authserver/login?service='
    + encodeURIComponent(buildAssignmentUrl(assignmentId))
    + '&dev=1'
}
