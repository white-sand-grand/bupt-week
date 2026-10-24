import { api } from './client.js'

/** 课程列表：课件视图的选课 chips。返回 [{ id, name }]。 */
export async function fetchCourses(sessionId) {
  const { courses } = await api('/api/ucloud/courses', {
    method: 'POST',
    body: { sessionId },
  })
  return courses
}

/** 一门课的课件资料树（原样透传，拉平在前端做）。 */
export async function fetchCourseware(sessionId, siteId) {
  const { tree } = await api('/api/ucloud/courseware', {
    method: 'POST',
    body: { sessionId, siteId },
  })
  return tree
}
