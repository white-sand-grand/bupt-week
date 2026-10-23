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
