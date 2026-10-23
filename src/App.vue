<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from './api/client.js'
import { auth } from './composables/auth.js'
import { wecomStartUrl } from './api/auth.js'
import LoginPanel from './components/LoginPanel.vue'
import TimetableView from './views/TimetableView.vue'
import AssignmentView from './views/AssignmentView.vue'

const state = ref('checking')
const detail = ref('')
const view = ref('timetable')

// 本次会话是否已自动试过企业微信。用它防循环：失败后清掉，
// 让用户能用学号密码兜底，而不是一遍遍被弹走。
const AUTO_WECOM_KEY = 'bupt-week-auto-wecom-tried'

// 在微信内置浏览器里打开时，UA 带 MicroMessenger（企业微信的 webview 也带）。
const inWechat = computed(() => /MicroMessenger/i.test(navigator.userAgent))

onMounted(async () => {
  try {
    await api('/api/health')
    state.value = 'ok'
  } catch (error) {
    state.value = 'error'
    detail.value = error.message
  }

  // 企业微信回流：后端把 sessionId 放在 URL fragment 里带回来（不进 Referer）。
  // 落地后第一件事就是消费它并把 URL 清干净——留着等于把凭证放在地址栏
  // 和历史记录里。无效（过期/伪造）就当没发生，走常规 restore。
  //
  // hash 形如 #/login?wecom=ok&sessionId=…：路由路径在前、参数在问号后，
  // 直接拿整段喂 URLSearchParams 会把「/login?wecom」当成键名。
  const hashQuery = new URLSearchParams(location.hash.split('?')[1] || '')
  const wecomSessionId = hashQuery.get('wecom') === 'ok' ? hashQuery.get('sessionId') || '' : ''
  if (wecomSessionId) {
    history.replaceState(null, '', location.pathname + location.search)
    try {
      await auth.adoptWecomSession(wecomSessionId)
    } catch {
      // 会话无效，保持未登录，登录面板就在下面
    }
  }

  await auth.restore()

  // 微信里：未登录就自动发起企业微信识别，不用用户点。
  // 只在本次会话试一次，失败后交给用户手动选择，避免卡死在循环里。
  if (inWechat.value && !auth.loggedIn.value && !sessionStorage.getItem(AUTO_WECOM_KEY)) {
    sessionStorage.setItem(AUTO_WECOM_KEY, '1')
    location.href = wecomStartUrl
    return
  }

  // 企业微信回调失败：清掉标记。面板未登录时本就展开，用户可以直接用学号密码兜底。
  if (hashQuery.get('error')?.startsWith('wecom-')) {
    sessionStorage.removeItem(AUTO_WECOM_KEY)
    history.replaceState(null, '', location.pathname + location.search)
  }
})

</script>

<template>
  <div class="shell">
    <header class="topbar">
      <h1>BUPT-week</h1>

      <!-- 登录是页面里的常驻元素，不是门禁：未登录也能进、能切视图 -->
      <div class="topbar-auth">
        <template v-if="auth.loggedIn.value">
          <span class="who">{{ auth.realName.value || auth.username.value }}</span>
          <button class="link-button" type="button" @click="auth.signOut()">退出</button>
        </template>
        <span v-else class="who muted">未登录</span>
      </div>
    </header>

    <p v-if="state === 'error'" class="banner banner-error">
      后端连接失败：{{ detail }}
    </p>

    <!-- 登录面板：未登录时常驻。它不挡下面的视图，页面照常进、照常切。 -->
    <LoginPanel v-if="!auth.loggedIn.value" :auth="auth" />

    <nav class="tabs" aria-label="功能切换">
      <button
        :class="['tab', { 'tab-active': view === 'timetable' }]"
        type="button"
        :aria-current="view === 'timetable'"
        @click="view = 'timetable'"
      >
        课表
      </button>
      <button
        :class="['tab', { 'tab-active': view === 'assignment' }]"
        type="button"
        :aria-current="view === 'assignment'"
        @click="view = 'assignment'"
      >
        作业
      </button>
    </nav>

    <main class="view">
      <TimetableView v-if="view === 'timetable'" :ready="auth.jwglReady.value" />
      <AssignmentView v-else :ready="auth.ucloudReady.value" />
    </main>

    <footer class="footnote">
      <span v-if="state === 'checking'">正在连接后端…</span>
      <span v-else-if="state === 'ok'">后端已连接</span>
      <span v-else>后端未连接</span>
    </footer>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: #fff;
  border-bottom: 1px solid var(--line);
}

h1 {
  margin: 0;
  font-size: 1.0625rem;
}

.topbar-auth {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
}

.who {
  color: var(--ink);
  font-weight: 500;
}

.link-button {
  min-height: 44px;
  padding: 0 0.5rem;
  border: none;
  background: none;
  color: var(--muted);
  font: inherit;
  cursor: pointer;
}

.banner {
  margin: 0;
  padding: 0.625rem 1rem;
  font-size: 0.8125rem;
}

.banner-error {
  color: var(--error);
  background: #fef2f2;
  border-bottom: 1px solid #fecaca;
}

.tabs {
  display: flex;
  gap: 0;
  padding: 0 1rem;
  background: #fff;
  border-bottom: 1px solid var(--line);
}

.tab {
  flex: 1;
  min-height: 44px;
  padding: 0 0.5rem;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--muted);
  font: inherit;
  cursor: pointer;
}

.tab-active {
  color: var(--ink);
  font-weight: 500;
  border-bottom-color: var(--ink);
}

.view {
  flex: 1;
  padding: 1rem;
}

.footnote {
  padding: 0.75rem 1rem 1.5rem;
  color: var(--muted);
  font-size: 0.75rem;
  text-align: center;
}

@media (min-width: 48rem) {
  .shell {
    max-width: 48rem;
    margin: 0 auto;
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
    background: #fff;
  }
}
</style>
