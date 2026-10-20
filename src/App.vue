<script setup>
import { onMounted, ref } from 'vue'
import { api } from './api/client.js'
import { jwglAuth, ucloudAuth } from './composables/auth.js'
import LoginPanel from './components/LoginPanel.vue'

// 第 1 期的界面：两个系统分别登录。课表和作业各走一套，凭证不通用。
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

  // 刷新页面后恢复登录态。失效的会被 restore() 清掉，不会留一个假登录。
  await Promise.all([ucloudAuth.restore(), jwglAuth.restore()])
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

    <div class="panels">
      <LoginPanel
        :auth="ucloudAuth"
        name-label="学号"
        title="云邮教学空间"
        hint="作业在这里。登录后才能看作业列表和下载附件。"
      />
      <LoginPanel
        :auth="jwglAuth"
        name-label="学号"
        title="教务处"
        hint="课表在这里。和云邮是两套系统，密码相同但要分别登录。"
      />
    </div>

    <p class="hint">
      课表和作业来自两个不同系统，凭证互不通用，所以需要分别登录。
      实施进度见 <code>docs/roadmap.md</code>。
    </p>
  </main>
</template>
