<script setup>
import { ref } from 'vue'

const props = defineProps({
  title: { type: String, required: true },
  hint: { type: String, default: '' },
  auth: { type: Object, required: true },
  nameLabel: { type: String, default: '学号' },
})

const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  error.value = ''

  // 空值由 input 上的 required 拦住；v-model.trim 会把纯空白变成空，同样被拦住。
  // 所以这里不再重复判一遍空——那条分支从 UI 根本走不到。
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
      <h2>{{ title }}</h2>
      <span v-if="auth.loggedIn.value" class="badge badge-ok">已登录</span>
    </header>

    <p v-if="hint" class="hint">{{ hint }}</p>

    <div v-if="auth.loggedIn.value" class="logged-in">
      <p class="who">
        {{ auth.realName.value || auth.username.value }}
        <span class="muted">（{{ nameLabel }} {{ auth.username.value }}）</span>
      </p>
      <button class="button-secondary" type="button" @click="auth.signOut()">退出登录</button>
    </div>

    <form v-else class="login-form" @submit.prevent="submit">
      <label>
        <span>{{ nameLabel }}</span>
        <input v-model.trim="username" type="text" autocomplete="username" :disabled="busy" required />
      </label>
      <label>
        <span>密码</span>
        <input v-model="password" type="password" autocomplete="current-password" :disabled="busy" required />
      </label>

      <p v-if="error" class="notice error" role="alert">{{ error }}</p>

      <button class="button-primary" type="submit" :disabled="busy">
        {{ busy ? '登录中…' : '登录' }}
      </button>
    </form>
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
  margin: 0;
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

button {
  justify-self: start;
  padding: 0.5rem 1rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  font: inherit;
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

.button-secondary {
  color: var(--ink);
  background: #fff;
  border-color: var(--line);
}
</style>
