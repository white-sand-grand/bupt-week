import { computed, ref } from 'vue'
import {
  checkJwglSession,
  checkUcloudSession,
  loginJwgl,
  loginUcloud,
  logoutJwgl,
  logoutUcloud,
} from '../api/auth.js'

/**
 * 登录态存储。
 *
 * localStorage 里只放 sessionId、学号、过期时间——**不放密码，不放 token**。
 * tests/ 里有断言守着这条。
 *
 * 两个系统各一个实例，互不影响：任一侧过期只禁用对应功能，不级联。
 */
function createAuthStore({ storageKey, login, check, logout }) {
  const credential = ref(read())

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
      return saved && typeof saved.sessionId === 'string' && saved.sessionId && saved.expiresAt > Date.now()
        ? saved
        : null
    } catch {
      return null
    }
  }

  function write(value) {
    credential.value = value
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value))
      else localStorage.removeItem(storageKey)
    } catch {
      // 隐私模式下写不进去，当前页面仍可用，刷新后要重登
    }
  }

  // 多标签页同步：一个标签页退出，其他标签页跟着退出
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === storageKey || event.key === null) credential.value = read()
    })
  }

  return {
    sessionId: computed(() => credential.value?.sessionId || ''),
    username: computed(() => credential.value?.username || ''),
    realName: computed(() => credential.value?.realName || ''),
    loggedIn: computed(() => Boolean(credential.value)),

    async signIn(username, password) {
      const data = await login(username, password)
      write({
        sessionId: data.sessionId,
        username: data.username,
        realName: data.realName || '',
        expiresAt: data.expiresAt,
      })
      return data
    },

    /** 校验并续期。失效时清掉本地状态，让调用方好知道要重新登。 */
    async restore() {
      if (!credential.value) return false
      try {
        const data = await check(credential.value.sessionId)
        write({
          sessionId: data.sessionId,
          username: data.username,
          realName: data.realName || '',
          expiresAt: data.expiresAt,
        })
        return true
      } catch {
        write(null)
        return false
      }
    },

    async signOut() {
      const sessionId = credential.value?.sessionId
      write(null)
      if (sessionId) {
        try {
          await logout(sessionId)
        } catch {
          // 本地已经退出，远程凭证仍受有效期限制
        }
      }
    },
  }
}

export const ucloudAuth = createAuthStore({
  storageKey: 'bupt-week-ucloud-auth',
  login: loginUcloud,
  check: checkUcloudSession,
  logout: logoutUcloud,
})

export const jwglAuth = createAuthStore({
  storageKey: 'bupt-week-jwgl-auth',
  login: loginJwgl,
  check: checkJwglSession,
  logout: logoutJwgl,
})
