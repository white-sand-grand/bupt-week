<script setup>
defineProps({
  /** 云邮登录态是否就绪。就绪也不代表有数据——第 3 期才接。 */
  ready: { type: Boolean, default: false },
})
</script>

<template>
  <section class="pane">
    <h2>作业</h2>

    <p v-if="ready" class="empty">
      作业功能正在开发中（第 3 期）。登录状态正常，数据接口尚未接入。
    </p>
    <p v-else class="empty">
      登录后可以查看作业列表、下载附件，并直接跳转到提交页。
      未登录也能浏览此页面，只是没有数据。
    </p>

    <p class="note">
      作业来自云邮教学空间。附件下载与"去交作业"的跳转链接已就绪，
      等作业列表接入后即可使用。
    </p>
  </section>
</template>

<style scoped>
.pane {
  display: grid;
  gap: 0.75rem;
}

h2 {
  margin: 0;
  font-size: 1.25rem;
}

.empty {
  margin: 0;
  padding: 2rem 1rem;
  border: 1px dashed var(--line);
  border-radius: 0.75rem;
  color: var(--muted);
  font-size: 0.875rem;
  line-height: 1.6;
  text-align: center;
}

.note {
  margin: 0;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.6;
}
</style>
