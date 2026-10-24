<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from './api/client.js'
import { auth } from './composables/auth.js'
import { wecomStartUrl } from './api/auth.js'
import { isInWechatBrowser } from './utils/platform.js'
import LoginPanel from './components/LoginPanel.vue'
import TimetableView from './views/TimetableView.vue'
import AssignmentView from './views/AssignmentView.vue'
import ClassView from './views/ClassView.vue'

const state = ref('checking')
const detail = ref('')
const view = ref('timetable')
// 企微自动识别失败的human readable原因（回流 hash 里的 error 码翻译）
const wecomError = ref('')

// 企微回流的失败码 → 说人话。全部给出路：重试按钮就在登录面板里。
const WECOM_ERROR_TEXT = {
  'wecom-cancelled': '企业微信识别被中断了（可能中途返回了微信）。可点下方按钮重试，或用学号密码登录。',
  'wecom-state': '企业微信识别的安全校验没有通过（通常是识别过程停留太久）。请重试一次；仍失败就用学号密码登录。',
  'wecom-connect': '学校认证服务暂时连不上，企业微信识别没有完成。可以用学号密码登录，稍后再试自动识别。',
  'wecom-no-ticket': '企业微信识别走完了，但学校网关没有带回登录凭证。请用学号密码登录，并把这条提示截图反馈，便于排查校方接口。',
}

// 本次会话是否已自动试过企业微信。用它防循环：失败后清掉，
// 让用户能用学号密码兜底，而不是一遍遍被弹走。
const AUTO_WECOM_KEY = 'bupt-week-auto-wecom-tried'

// 在微信内置浏览器里打开时（企业微信 webview 也算），未登录就自动识别身份。
const inWechat = computed(isInWechatBrowser)

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

  // 企业微信回调失败：清掉标记（用户可手动再试），并把失败原因说给人听——
  // 静默退回登录框会让「为什么识别失败」变成永久盲区。
  const wecomErrorCode = hashQuery.get('error') || ''
  if (wecomErrorCode.startsWith('wecom-')) {
    sessionStorage.removeItem(AUTO_WECOM_KEY)
    wecomError.value = WECOM_ERROR_TEXT[wecomErrorCode]
      || `企业微信自动识别没有完成（${wecomErrorCode}）。可以用学号密码登录。`
    history.replaceState(null, '', location.pathname + location.search)
  }
})

</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">周</span>
        <h1>BUPT-week</h1>
      </div>

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
    <div v-if="wecomError && !auth.loggedIn.value" class="banner banner-warn" role="status">
      {{ wecomError }}
    </div>
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
      <button
        :class="['tab', { 'tab-active': view === 'class' }]"
        type="button"
        :aria-current="view === 'class'"
        @click="view = 'class'"
      >
        班级
      </button>
    </nav>

    <main class="view">
      <!-- degraded = 已登录但教务侧不可用（降级登录/企微登录），课表视图要给出黄条说明 -->
      <TimetableView
        v-if="view === 'timetable'"
        :ready="auth.jwglReady.value"
        :degraded="auth.loggedIn.value && !auth.jwglReady.value"
      />
      <AssignmentView v-else-if="view === 'assignment'" :ready="auth.ucloudReady.value" />
      <ClassView v-else />
    </main>

    <footer class="footnote">
      <span class="status-dot" :class="`status-dot-${state === 'ok' ? 'ok' : state === 'checking' ? 'checking' : 'down'}`" aria-hidden="true"></span>
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
  padding: 0.625rem 1rem;
  /* 先给实底再叠半透明混合：不支持 color-mix 的旧内核拿到实底，顶栏不会透 */
  background: var(--surface);
  background: color-mix(in srgb, var(--surface) 86%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.5rem;
  background: linear-gradient(135deg, var(--brand-600), var(--brand-500));
  box-shadow: var(--shadow-sm), inset 0 1px 0 rgb(255 255 255 / 0.25);
  color: #fff;
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1;
}

h1 {
  margin: 0;
  font-size: 1.0625rem;
  letter-spacing: 0.01em;
}

.topbar-auth {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.8125rem;
}

.who {
  color: var(--ink);
  font-weight: 500;
}

.link-button {
  min-height: var(--touch);
  padding: 0 0.75rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: none;
  color: var(--ink-soft);
  font-size: 0.8125rem;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.link-button:active {
  color: var(--ink);
  background: var(--surface-sunken);
}

@media (prefers-color-scheme: dark) {
  /* 深色下顶栏对比弱，给退出一个实底避免融进背景 */
  .link-button {
    background: var(--surface-sunken);
    border-color: var(--line);
    color: var(--ink-soft);
  }
}

.banner {
  margin: 0;
  padding: 0.625rem 1rem;
  font-size: 0.8125rem;
}

.banner-error {
  color: var(--error);
  background: var(--error-bg);
  border-bottom: 1px solid var(--error-line);
}

.banner-warn {
  margin: 0.75rem 1rem 0;
  padding: 0.625rem 0.875rem;
  border-radius: var(--radius-md);
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid #fde68a;
}

@media (prefers-color-scheme: dark) {
  .banner-warn {
    border-color: #55461a;
  }
}

/* 分段控件：圆角容器内滑动高亮，比下划线 tab 更醒目 */
.tabs {
  display: flex;
  gap: 0.25rem;
  margin: 0.75rem 1rem 0;
  padding: 0.25rem;
  background: var(--surface-sunken);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-pill);
}

.tab {
  flex: 1;
  min-height: var(--touch);
  padding: 0 0.5rem;
  border: none;
  background: none;
  color: var(--ink-soft);
  font: inherit;
  cursor: pointer;
  border-radius: var(--radius-pill);
  transition: color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
}

.tab-active {
  color: var(--brand-700);
  font-weight: 600;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

@media (prefers-color-scheme: dark) {
  .tab-active {
    color: #cfe0fa;
    background: #2c313a;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
  }
}

.view {
  flex: 1;
  padding: 1rem;
}

.footnote {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.75rem 1rem calc(1.5rem + env(safe-area-inset-bottom, 0px));
  color: var(--muted);
  font-size: 0.75rem;
}

.status-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
}

.status-dot-ok {
  background: var(--ok);
}

.status-dot-checking {
  background: var(--warn);
  animation: pulse 1.2s ease-in-out infinite;
}

.status-dot-down {
  background: var(--error);
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

@media (min-width: 48rem) {
  .shell {
    max-width: 64rem;
    margin: 0 auto;
    background: var(--surface);
    box-shadow: var(--shadow-md);
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  }

  /* 桌面上两个 tab 占满 64rem 太空，收窄居中成分段胶囊 */
  .tabs {
    max-width: 26rem;
    margin: 1rem auto 0;
  }

  .view {
    padding: 1.25rem;
  }
}
</style>
