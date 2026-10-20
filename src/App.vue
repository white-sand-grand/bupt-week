<script setup>
import { onMounted, ref } from 'vue'
import { api } from './api/client.js'

// 第 0 期唯一的界面：确认前端 → Vite 代理 → 后端 → JSON 形状这条链路是通的。
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

    <p class="hint">
      尚未实现登录、课表与作业。实施顺序见
      <code>docs/roadmap.md</code>。
    </p>
  </main>
</template>
