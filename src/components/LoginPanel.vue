<script setup>
import { computed, onMounted, ref } from 'vue'
import { wecomStartUrl } from '../api/auth.js'

const props = defineProps({
  auth: { type: Object, required: true },
})

// 在微信内置浏览器里打开时，企业微信身份可以被自动识别，无需输学号密码。
//  MicroMessenger 是微信 webview 的 UA 标识；企业微信的 UA 也带它。
const inWechat = computed(() => /MicroMessenger/i.test(navigator.userAgent))

const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')

// 企业微信流程结束后会带参数跳回来，把结果展示出来
onMounted(() => {
  const hash = new URLSearchParams(location.hash.slice(1))
  const wecom = hash.get('wecom')
  const failure = hash.get('error')

  if (wecom === 'ok') {
    props.auth.restore()
    notice.value = '已通过企业微信登录'
  } else if (failure?.startsWith('wecom-')) {
    error.value = {
      'wecom-cancelled': '企业微信登录未完成',
      'wecom-connect': '连不上统一认证服务，请稍后重试',
      'wecom-no-ticket': '企业微信登录未能完成，请改用学号密码',
    }[failure] || '企业微信登录失败'
  }

  // 清掉 hash，避免刷新时重复提示
  if (wecom || failure) history.replaceState(null, '', location.pathname + location.search)
})

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
    </p>

    <div v-if="auth.loggedIn.value" class="logged-in">
      <p class="who">
        {{ auth.realName.value || auth.username.value }}
        <span class="muted">（{{ auth.username.value }}）</span>
      </p>
      <button class="button-secondary" type="button" @click="auth.signOut()">退出登录</button>
    </div>

    <template v-else>
      <p v-if="notice" class="notice success" role="status">{{ notice }}</p>
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
        在微信里也可以直接用上面的企业微信登录，无需输入学号密码。
      </p>
    </template>
  </section>
</template>

<style scoped>
.panel {
  padding: 1.25rem;
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  background: #fff;
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
  border-radius: 999px;
  font-size: 0.75rem;
}

.badge-ok {
  color: var(--ok);
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
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
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  font: inherit;
  color: var(--ink);
  background: #fff;
}

.login-form input:disabled {
  background: #f9fafb;
}

.notice {
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  line-height: 1.5;
}

.notice.error {
  color: var(--error);
  background: #fef2f2;
  border: 1px solid #fecaca;
}

.notice.success {
  color: var(--ok);
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
}

button,
.wecom {
  justify-self: start;
  padding: 0.5rem 1rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.button-primary {
  color: #fff;
  background: var(--ink);
}

.wecom {
  margin-top: 0.875rem;
  color: var(--ok);
  background: #f0fdf4;
  border-color: #bbf7d0;
}

.button-secondary {
  color: var(--ink);
  background: #fff;
  border-color: var(--line);
}
</style>
