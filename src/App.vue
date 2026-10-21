<script setup>
import { onMounted, ref } from 'vue'
import { api } from './api/client.js'
import { auth } from './composables/auth.js'
import LoginPanel from './components/LoginPanel.vue'

const state = ref('checking')
const detail = ref('')

onMounted(async () => {
  try {
    await api('/api/health')
    state.value = 'ok'
  } catch (error) {
    state.value = 'error'
    detail.value = error.message
  }

  // 刷新页面后恢复登录态。失效的一侧会被 restore() 清掉，不会留一个假登录。
  await auth.restore()
})
</script>

<template>
  <main class="shell">
    <h1>BUPT-week</h1>
    <p class="subtitle">查课表 · 看作业 · 交作业跳转</p>

    <p :class="['status', `status-${state}`]">
      <span v-if="state === 'checking'">正在连接后端…</span>
      <span v-else-if="state === 'ok'">后端已连接</span>
      <span v-else>后端连接失败：{{ detail }}</span>
    </p>

    <LoginPanel :auth="auth" />

    <p class="hint">
      课表走教务处、作业走云邮教学空间，两边共用同一套统一身份认证，所以只需登录一次。
      实施进度见 <code>docs/roadmap.md</code>。
    </p>
  </main>
</template>
