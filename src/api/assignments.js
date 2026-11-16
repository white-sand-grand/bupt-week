import { api } from './client.js'

/** 全量作业列表（所有课程，前端分组排序）。 */
export const fetchAssignments = (sessionId) =>
  api('/api/ucloud/assignments', { method: 'POST', body: { sessionId } })
    .then((data) => data.assignments)

/**
 * 单个作业详情（正文要求、补充说明与附件）。卡片展开时懒加载。
 * @returns {Promise<{ content: string, description: string, attachments: Array<{resourceId, resourceName, resourceType}> }>}
 */
export const fetchAssignmentDetail = (sessionId, assignmentId) =>
  api('/api/ucloud/assignment/detail', { method: 'POST', body: { sessionId, assignmentId } })
