<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from './api/client.js'
import { auth } from './composables/auth.js'
import { theme } from './composables/theme.js'
import { wecomStartUrl } from './api/auth.js'
import { isInWechatBrowser } from './utils/platform.js'
import LoginPanel from './components/LoginPanel.vue'
import TimetableView from './views/TimetableView.vue'
import AssignmentView from './views/AssignmentView.vue'
import CoursewareView from './views/CoursewareView.vue'
import ClassView from './views/ClassView.vue'
import SourcesView from './views/SourcesView.vue'

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
  'wecom-no-ticket': '企业微信识别已完成，但登录凭证交换没有成功。请用学号密码登录；若反复出现请把这条提示截图反馈。',
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
        <h1>BUPT-week</h1>
        <span class="brand-caption">校园日程</span>
      </div>

      <div class="topbar-tools">
        <button
          class="theme-toggle"
          type="button"
          :aria-label="theme.mode.value === 'dark' ? '切换到亮色模式' : '切换到暗色模式'"
          :title="theme.mode.value === 'dark' ? '切换到亮色模式' : '切换到暗色模式'"
          @click="theme.toggle()"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <template v-if="theme.mode.value === 'light'">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
            </template>
            <path v-else d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />
          </svg>
          <span class="theme-label">{{ theme.mode.value === 'dark' ? '暗色' : '亮色' }}</span>
        </button>
        <!-- 登录不挡下面的视图；主题与退出操作各自独立。 -->
        <div class="topbar-auth">
          <template v-if="auth.loggedIn.value">
            <span class="who" :title="auth.realName.value || auth.username.value">{{ auth.realName.value || auth.username.value }}</span>
            <button class="link-button" type="button" @click="auth.signOut()">退出</button>
          </template>
          <span v-else class="who muted">未登录</span>
        </div>
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
        data-index="01"
        :class="['tab', { 'tab-active': view === 'timetable' }]"
        type="button"
        :aria-current="view === 'timetable'"
        @click="view = 'timetable'"
      >
        课表
      </button>
      <button
        data-index="02"
        :class="['tab', { 'tab-active': view === 'assignment' }]"
        type="button"
        :aria-current="view === 'assignment'"
        @click="view = 'assignment'"
      >
        作业
      </button>
      <button
        data-index="03"
        :class="['tab', { 'tab-active': view === 'courseware' }]"
        type="button"
        :aria-current="view === 'courseware'"
        @click="view = 'courseware'"
      >
        课件
      </button>
      <button
        data-index="04"
        :class="['tab', { 'tab-active': view === 'class' }]"
        type="button"
        :aria-current="view === 'class'"
        @click="view = 'class'"
      >
        班级
      </button>
      <button
        data-index="05"
        :class="['tab', { 'tab-active': view === 'sources' }]"
        type="button"
        :aria-current="view === 'sources'"
        @click="view = 'sources'"
      >
        添加源
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
      <CoursewareView v-else-if="view === 'courseware'" :ready="auth.ucloudReady.value" />
      <ClassView v-else-if="view === 'class'" />
      <SourcesView v-else />
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
  max-width: 72rem;
  margin: 0 auto;
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
  gap: 0.5rem;
  min-height: 5rem;
  padding: 0.75rem var(--gutter);
  background: var(--page);
  border-bottom: 1px solid var(--line);
}

.brand {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-shrink: 0;
}

.brand-caption {
  padding-left: 1rem;
  border-left: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
}

h1 {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.04em;
}

.topbar-tools {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 1rem;
}

.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-width: var(--touch);
  min-height: var(--touch);
  padding: 0 0.75rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink-soft);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.theme-toggle:hover {
  border-color: var(--brand-500);
  color: var(--brand-600);
  background: var(--brand-050);
}

.topbar-auth {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
}

.who {
  max-width: 8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-weight: 500;
}

.link-button {
  min-height: var(--touch);
  padding: 0 0.5rem;
  border: 1px solid transparent;
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
  margin: 0.75rem var(--gutter) 0;
  padding: 0.625rem 0.875rem;
  border-radius: var(--radius-md);
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
}

/* 以编号和细下划线组织功能入口，保持工具界面的轻量感。 */
.tabs {
  display: flex;
  gap: 1.5rem;
  margin: 0.75rem var(--gutter) 0;
  border-bottom: 1px solid var(--line);
}

.tab {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  min-height: var(--touch);
  padding: 0.75rem 0;
  margin-bottom: -1px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}

.tab::before {
  content: attr(data-index);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  opacity: 0.65;
}

.tab:hover {
  color: var(--ink);
}

.tab-active {
  color: var(--brand-600);
  font-weight: 500;
  border-bottom-color: var(--brand-500);
}

.view {
  flex: 1;
  min-width: 0;
  padding: 1.75rem var(--gutter) 2rem;
}

.footnote {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 0.4rem;
  margin: 0 var(--gutter);
  padding: 1rem 0 calc(1.25rem + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
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

@media (max-width: 40rem) {
  .brand-caption,
  .theme-label {
    display: none;
  }

  .topbar {
    min-height: 4.5rem;
  }

  .topbar-tools {
    gap: 0.375rem;
  }

  .theme-toggle {
    padding: 0;
  }

  .who {
    max-width: 4.5rem;
  }

  .tabs {
    gap: 0.5rem;
  }

  .tab {
    flex: 1;
    gap: 0.375rem;
    min-width: 0;
    white-space: nowrap;
  }

  .tab[data-index='05'] {
    flex: 1.4;
  }
}
</style>
