import { computed, ref } from 'vue'
import { ApiError } from '../api/client.js'
import {
  checkJwglSession,
  checkUcloudSession,
  login,
  logoutJwgl,
  logoutUcloud,
  submitJwglweixinPassword,
} from '../api/auth.js'

const UCLOUD_KEY = 'bupt-week-ucloud-auth'
const JWGL_KEY = 'bupt-week-jwgl-auth'

/**
 * 统一登录态。
 *
 * 对外是一个登录态（一个学号密码框），内部仍是两个系统的独立凭证——
 * 任一侧过期只禁用对应功能，不级联。localStorage 里只放 sessionId、学号、
 * 过期时间：**不放密码，不放 token**，tests/ 里有断言守着这条。
 */
const ucloud = ref(read(UCLOUD_KEY))
const jwgl = ref(read(JWGL_KEY))

function read(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    return saved && typeof saved.sessionId === 'string' && saved.sessionId && saved.expiresAt > Date.now()
      ? saved
      : null
  } catch {
    return null
  }
}

function write(key, value) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value))
    else localStorage.removeItem(key)
  } catch {
    // 隐私模式下写不进去，当前页面仍可用，刷新后要重登
  }
}

// 多标签页同步：一个标签页退出，其他标签页跟着退出
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === UCLOUD_KEY || event.key === null) ucloud.value = read(UCLOUD_KEY)
    if (event.key === JWGL_KEY || event.key === null) jwgl.value = read(JWGL_KEY)
  })
}

export const auth = {
  loggedIn: computed(() => Boolean(ucloud.value || jwgl.value)),
  username: computed(() => ucloud.value?.username || jwgl.value?.username || ''),
  realName: computed(() => ucloud.value?.realName || ''),
  /** 云邮（作业）是否可用 */
  ucloudReady: computed(() => Boolean(ucloud.value)),
  /** 教务处（课表）是否可用 */
  jwglReady: computed(() => Boolean(jwgl.value)),

  async signIn(username, password) {
    const data = await login(username, password)

    ucloud.value = {
      sessionId: data.ucloud.sessionId,
      username: data.ucloud.username,
      realName: data.ucloud.realName || '',
      expiresAt: data.expiresAt,
    }
    // 教务侧降级（教务系统不可达，见登录接口的 jwglMessage）时 data.jwgl 为
    // null：云邮照常登录，jwgl 侧置空（write(null) 会清掉残留的旧 key）。
    // 与企微回流一样只建立单侧登录态，课表视图按「已登录但教务不可用」呈现。
    jwgl.value = data.jwgl
      ? {
          sessionId: data.jwgl.sessionId,
          username: data.jwgl.username,
          expiresAt: data.expiresAt,
        }
      : null
    write(UCLOUD_KEY, ucloud.value)
    write(JWGL_KEY, jwgl.value)
    return data
  },

  /**
   * 企业微信回流落地：后端把 sessionId 放在 URL fragment 里带回来（不进
   * Referer），由 App.vue 在挂载时交给我们。企微流程只登云邮这一侧。
   * 先向后端核一遍（顺带取学号姓名），无效就抛给调用方按未登录处理。
   */
  async adoptWecomSession(sessionId) {
    const data = await checkUcloudSession(sessionId)
    ucloud.value = {
      sessionId: data.sessionId,
      username: data.username || '',
      realName: data.realName || '',
      expiresAt: data.expiresAt,
    }
    write(UCLOUD_KEY, ucloud.value)
  },

  /**
   * 补填教务密码（统一登录假定教务密码=统一身份密码，不同的人在这里补）。
   * 成功后 jwgl 侧登录态生效（ready 变 true，课表视图自动开始同步）；
   * 密码仍不对抛给调用方展示。密码不落任何存储。
   */
  async submitJwglPassword(password) {
    const ucloudId = ucloud.value?.sessionId
    if (!ucloudId) throw new Error('请先登录')
    const data = await submitJwglweixinPassword(ucloudId, password)
    jwgl.value = {
      sessionId: data.sessionId,
      username: data.username || ucloud.value.username,
      expiresAt: data.expiresAt,
    }
    write(JWGL_KEY, jwgl.value)
  },

  /**
   * 校验并续期。失效的一侧会被清掉，不会留一个假登录。
   *
   * 只在后端明确判 401 时才清本地态：网络错误（后端不可达、断网）不是
   * 会话失效，本地态保留，下次进页面再试——服务端会话其实还活着。
   */
  async restore() {
    const results = await Promise.allSettled([
      ucloud.value ? checkUcloudSession(ucloud.value.sessionId) : Promise.resolve(null),
      jwgl.value ? checkJwglSession(jwgl.value.sessionId) : Promise.resolve(null),
    ])

    const [ucloudResult, jwglResult] = results
    const invalid = (result) => result.reason instanceof ApiError && result.reason.status === 401

    if (ucloudResult.status === 'fulfilled' && ucloudResult.value) {
      ucloud.value = { ...ucloud.value, ...ucloudResult.value }
      write(UCLOUD_KEY, ucloud.value)
    } else if (ucloudResult.status === 'rejected' && invalid(ucloudResult)) {
      ucloud.value = null
      write(UCLOUD_KEY, null)
    }

    if (jwglResult.status === 'fulfilled' && jwglResult.value) {
      jwgl.value = { ...jwgl.value, ...jwglResult.value }
      write(JWGL_KEY, jwgl.value)
    } else if (jwglResult.status === 'rejected' && invalid(jwglResult)) {
      jwgl.value = null
      write(JWGL_KEY, null)
    }

    return Boolean(ucloud.value || jwgl.value)
  },

  /** 某一侧的 sessionId（课表/作业模块直接取用）；该侧未登录返回空串。 */
  sessionIdFor(kind) {
    const side = kind === 'jwgl' ? jwgl.value : ucloud.value
    return side?.sessionId || ''
  },

  async signOut() {
    const ucloudId = ucloud.value?.sessionId
    const jwglId = jwgl.value?.sessionId
    ucloud.value = null
    jwgl.value = null
    write(UCLOUD_KEY, null)
    write(JWGL_KEY, null)

    // 本地已经退出；远程注销失败也无妨，凭证仍受有效期限制
    await Promise.allSettled([
      ucloudId ? logoutUcloud(ucloudId) : Promise.resolve(),
      jwglId ? logoutJwgl(jwglId) : Promise.resolve(),
    ])
  },
}
