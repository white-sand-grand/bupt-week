import { readonly, ref } from 'vue'
import { auth } from './auth.js'
import { downloadResource } from '../api/files.js'
import { friendlyError } from '../utils/errors.js'
import { formatBytes } from '../utils/format.js'

/**
 * 附件下载状态：每个 resourceId 一条。
 *
 *   idle（无记录）→ resolving（换下载地址）→ downloading（拉流，带进度）
 *   → done（自动消失）或 error（可再点重试）。
 *
 * 模块级而不是组件级：AssignmentView 是 v-if 切换的，切去课表再切回来
 * 组件会重挂载——下载本身还在后台跑，进度和防连点必须活得比组件久。
 * 退出登录不清（进度里没有敏感数据，页面刷新自然清空）。
 */

const items = ref({})

/** 「已下载」收尾反馈停留多久；浏览器的下载气泡之后自然接手 */
const DONE_LINGER_MS = 5000

function patch(id, extra) {
  items.value = { ...items.value, [id]: { ...items.value[id], ...extra } }
}

function remove(id) {
  const { [id]: _drop, ...rest } = items.value
  items.value = rest
}

/**
 * 下载一个附件。在途（换地址/拉流）时直接返回——同一附件不允许叠两份
 * 下载；失败后再点即重试。
 */
async function start(resourceId, filename) {
  const current = items.value[resourceId]
  if (current && (current.phase === 'resolving' || current.phase === 'downloading')) return

  patch(resourceId, { phase: 'resolving', received: 0, total: null, message: '' })
  try {
    await downloadResource(auth.sessionIdFor('ucloud'), resourceId, filename, {
      onProgress({ received, total }) {
        patch(resourceId, { phase: 'downloading', received, total })
      },
    })
    patch(resourceId, { phase: 'done', received: 0, total: null, message: '' })
    setTimeout(() => {
      if (items.value[resourceId]?.phase === 'done') remove(resourceId)
    }, DONE_LINGER_MS)
  } catch (error) {
    patch(resourceId, { phase: 'error', message: friendlyError(error) })
  }
}

/**
 * 附件行的状态文案（作业附件与课件共用）：换地址中 / 进度（带百分比与
 * 已下载量）/ 收尾 / 错误。无记录返回空串。
 */
function hintFor(resourceId) {
  const item = items.value[resourceId]
  if (!item) return ''
  if (item.phase === 'resolving') return '正在获取下载地址…'
  if (item.phase === 'downloading') {
    return item.total
      ? `正在下载 ${Math.round((item.received / item.total) * 100)}%（${formatBytes(item.received)} / ${formatBytes(item.total)}）`
      : `已下载 ${formatBytes(item.received)}`
  }
  if (item.phase === 'done') return '已下载'
  if (item.phase === 'error') return item.message
  return ''
}

/** 0~1 的进度比值；总大小未知或不处于下载中时为 null（只靠文案，不画条）。 */
function progressRatioFor(resourceId) {
  const item = items.value[resourceId]
  return item?.phase === 'downloading' && item.total ? item.received / item.total : null
}

/** 换地址/下载中都算在途：按钮置灰防连点。 */
function isBusy(resourceId) {
  const phase = items.value[resourceId]?.phase
  return phase === 'resolving' || phase === 'downloading'
}

export const downloadsStore = {
  items: readonly(items),
  start,
  hintFor,
  progressRatioFor,
  isBusy,
}
