<script setup>
import { computed, ref } from 'vue'
import { wecomStartUrl } from '../api/auth.js'
import { isInWechatBrowser } from '../utils/platform.js'

const props = defineProps({
  auth: { type: Object, required: true },
})

// 在微信内置浏览器里打开时，企业微信身份可以被自动识别，无需输学号密码。
const inWechat = computed(isInWechatBrowser)

const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await props.auth.signIn(username.value, password.value)
    password.value = ''
  } catch (caught) {
    // msg 是后端给人看的，直接展示；stage 只用于排查，不透出
    error.value = caught.message || '登录失败，请稍后重试'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <h2>登录</h2>
      <span v-if="auth.loggedIn.value" class="badge badge-ok">已登录</span>
    </header>

    <p class="hint">
      课表和作业共用同一套统一身份认证，<strong>登录一次即可</strong>。
      不登录也能浏览页面，只是没有数据。
    </p>

    <div v-if="auth.loggedIn.value" class="logged-in">
      <p class="who">
        {{ auth.realName.value || auth.username.value }}
        <span class="muted">（{{ auth.username.value }}）</span>
      </p>
      <button class="button-secondary" type="button" @click="auth.signOut()">退出登录</button>
    </div>

    <template v-else>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>

      <!-- 微信里优先走企业微信自动识别，省掉输密码 -->
      <a v-if="inWechat" class="button-primary wecom" :href="wecomStartUrl">企业微信登录</a>

      <form class="login-form" @submit.prevent="submit">
        <label>
          <span>学号</span>
          <input v-model.trim="username" type="text" autocomplete="username" :disabled="busy" required />
        </label>
        <label>
          <span>密码</span>
          <input v-model="password" type="password" autocomplete="current-password" :disabled="busy" required />
        </label>

        <button class="button-primary" type="submit" :disabled="busy">
          {{ busy ? '登录中…' : '登录' }}
        </button>
      </form>

      <p v-if="inWechat" class="hint hint-small">
        在微信里通常会自动识别企业微信身份；识别不了再用上面的按钮手动登录。
      </p>
    </template>
  </section>
</template>

<style scoped>
.panel {
  margin: 1rem 1rem 0;
  padding: 1.25rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  position: relative;
}

/* 顶部一条品牌色细带，给面板一个视觉锚点 */
.panel::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: linear-gradient(90deg, var(--brand-600), var(--brand-500));
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

h2 {
  margin: 0;
  font-size: 1.05rem;
}

.badge {
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-pill);
  font-size: 0.75rem;
}

.badge-ok {
  color: var(--ok);
  background: var(--ok-bg);
  border: 1px solid var(--ok-line);
}

.hint {
  margin: 0.5rem 0 0;
  color: var(--muted);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.hint-small {
  margin-top: 0.75rem;
  font-size: 0.75rem;
}

.logged-in {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 0.875rem;
}

.who {
  margin: 0;
  font-weight: 500;
}

.muted {
  color: var(--muted);
  font-weight: 400;
}

.login-form {
  display: grid;
  gap: 0.75rem;
  margin-top: 0.875rem;
}

.login-form label {
  display: grid;
  gap: 0.3rem;
  font-size: 0.8125rem;
  color: var(--muted);
}

.login-form input {
  min-height: var(--touch);
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  /* 只继承字体族；字号钉 16px——label 是 13px，用 font:inherit 会连带继承，
     iOS/微信聚焦输入框时就会放大整页（styles.css 的全局 16px 会被覆盖） */
  font-family: inherit;
  font-size: 16px;
  color: var(--ink);
  background: var(--surface);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.login-form input:focus {
  outline: none;
  border-color: var(--brand-500);
  box-shadow: 0 0 0 3px var(--brand-050);
}

@media (prefers-color-scheme: dark) {
  .login-form input:focus {
    box-shadow: 0 0 0 3px var(--brand-100);
  }
}

.login-form input:disabled {
  background: var(--surface-sunken);
}

.notice {
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-sm);
  font-size: 0.8125rem;
  line-height: 1.5;
}

.notice.error {
  color: var(--error);
  background: var(--error-bg);
  border: 1px solid var(--error-line);
}

button,
.wecom {
  justify-self: start;
  /* 微信里是手指点，触摸目标不小于 44px */
  min-height: var(--touch);
  padding: 0.5rem 1.25rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font: inherit;
  text-decoration: none;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.1s ease;
}

button:active,
.wecom:active {
  filter: brightness(0.96);
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.button-primary {
  color: #fff;
  background: linear-gradient(180deg, var(--brand-600), var(--brand-700));
  box-shadow: var(--shadow-sm);
  font-weight: 500;
}

.wecom {
  margin-top: 0.875rem;
  color: var(--ok);
  background: var(--ok-bg);
  border-color: var(--ok-line);
}

.button-secondary {
  color: var(--ink);
  background: var(--surface);
  border-color: var(--line);
}

@media (min-width: 48rem) {
  .panel {
    margin: 1.25rem 1.25rem 0;
  }
}
</style>
