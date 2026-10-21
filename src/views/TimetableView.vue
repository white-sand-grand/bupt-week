<script setup>
defineProps({
  /** 对应系统的登录态是否就绪。就绪也不代表有数据——第 2 期才接。 */
  ready: { type: Boolean, default: false },
})
</script>

<template>
  <section class="pane">
    <h2>课表</h2>

    <p v-if="ready" class="empty">
      课表功能正在开发中（第 2 期）。登录状态正常，数据接口尚未接入。
    </p>
    <p v-else class="empty">
      登录后可以查看课表。未登录也能浏览此页面，只是没有数据。
    </p>

    <p class="note">
      课表来自教务处系统，与作业共用同一套统一身份认证，登录一次即可。
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
