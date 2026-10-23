import { api } from './client.js'

/**
 * 取一周课表。不带 week 时取当前周，响应里同时带全部可选周次与节次模式。
 * @param {{ week?: number, mode?: string }} options
 * @returns {Promise<object>} 解析后的周课表 { week, mode, date, weeks, modes, days, periods, courses }
 */
export const fetchTimetable = (sessionId, { week, mode } = {}) =>
  api('/api/jwgl/timetable', {
    method: 'POST',
    body: week === undefined && mode === undefined
      ? { sessionId }
      : { sessionId, ...(week !== undefined ? { week } : {}), ...(mode !== undefined ? { mode } : {}) },
  }).then((data) => data.timetable)
