<script setup>
import { computed, onMounted, watch } from 'vue'
import { auth } from '../composables/auth.js'
import { assignmentsStore } from '../composables/assignments.js'
import { downloadResource } from '../api/files.js'
import { buildAssignmentUrl } from '../utils/assignment-url.js'

const props = defineProps({
  /** 云邮登录态是否就绪。 */
  ready: { type: Boolean, default: false },
})

const LEVEL_CLASS = {
  overdue: 'badge-overdue',
  danger: 'badge-danger',
  warning: 'badge-warning',
  normal: 'badge-normal',
  submitted: 'badge-submitted',
  missed: 'badge-missed',
}

const downloadErrors = {}

function deadlineText(assignment) {
  if (!assignment.deadline) return ''
  return assignment.deadline.replace('T', ' ').slice(0, 16)
}

async function download(attachment) {
  try {
    await downloadResource(attachment.resourceId, attachment.resourceName)
  } catch (error) {
    downloadErrors[attachment.resourceId] = error.message || '下载失败'
  }
}

function startLoad() {
  if (props.ready && assignmentsStore.state.value === 'idle') {
    assignmentsStore.load()
  }
}

onMounted(startLoad)
watch(() => props.ready, startLoad)

const groups = computed(() => assignmentsStore.groups.value)
</script>

<template>
  <section class="pane">
    <header class="pane-head">
      <h2>作业</h2>
      <span v-if="assignmentsStore.unfinishedCount.value" class="counter">
        {{ assignmentsStore.unfinishedCount.value }} 项未完成
      </span>
    </header>

    <p v-if="!ready" class="empty">
      登录后可以查看作业列表、下载附件，并直接跳转到提交页。
      未登录也能浏览此页面，只是没有数据。
    </p>
    <p v-else-if="assignmentsStore.state.value === 'loading'" class="empty">正在获取作业…</p>
    <p v-else-if="assignmentsStore.state.value === 'error'" class="notice error" role="alert">
      {{ assignmentsStore.error.value }}
    </p>
    <p v-else-if="!groups.length" class="empty">本学期没有作业记录。</p>

    <template v-else>
      <section v-for="group in groups" :key="group.courseName" class="course-group">
        <h3>{{ group.courseName }}<span class="course-count">{{ group.items.length }}</span></h3>

        <article
          v-for="assignment in group.items"
          :key="assignment.id"
          class="card"
          :class="{ 'card-done': assignment.isCompleted, 'card-open': assignmentsStore.expanded.value[assignment.id] }"
        >
          <button class="card-main" type="button" @click="assignmentsStore.toggle(assignment.id)">
            <span class="card-title">{{ assignment.title }}</span>
            <span v-if="assignment.chapter" class="card-chapter">{{ assignment.chapter }}</span>
            <span class="card-meta">
              <span class="badge" :class="LEVEL_CLASS[assignment.level]">{{ assignment.status }}</span>
              <span v-if="deadlineText(assignment)" class="deadline">截止 {{ deadlineText(assignment) }}</span>
            </span>
          </button>

          <div v-if="assignmentsStore.expanded.value[assignment.id]" class="card-detail">
            <template v-if="assignmentsStore.attachmentState.value[assignment.id] === 'loading'">
              <p class="detail-hint">正在加载附件…</p>
            </template>
            <template v-else-if="assignmentsStore.attachmentState.value[assignment.id] === 'error'">
              <p class="detail-hint">附件加载失败，可重试展开</p>
            </template>
            <template v-else>
              <p v-if="!assignmentsStore.attachments.value[assignment.id]?.length" class="detail-hint">
                这份作业没有附件。
              </p>
              <ul v-else class="attachment-list">
                <li v-for="attachment in assignmentsStore.attachments.value[assignment.id]" :key="attachment.resourceId">
                  <button class="link-button" type="button" @click="download(attachment)">
                    ⬇ {{ attachment.resourceName }}
                  </button>
                  <span v-if="downloadErrors[attachment.resourceId]" class="detail-hint">
                    {{ downloadErrors[attachment.resourceId] }}
                  </span>
                </li>
              </ul>
            </template>

            <!-- 新标签打开云邮提交页。无云邮会话时会先落 CAS 登录页，登一次即回（§3.2 补充） -->
            <a
              class="go-submit"
              :href="buildAssignmentUrl(assignment.id)"
              target="_blank"
              rel="noopener"
            >去交作业</a>
            <p class="detail-hint">在云邮页面提交。若提示登录，登一次统一身份认证即可回到这份作业。</p>
          </div>
        </article>
      </section>
    </template>

    <p class="note">
      作业来自云邮教学空间。按紧急度排序：已逾期 → 今天/明天截止 → 一周内 → 待完成 → 已提交。
    </p>
  </section>
</template>

<style scoped>
.pane {
  display: grid;
  gap: 0.75rem;
}

.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

h2 {
  margin: 0;
  font-size: 1.25rem;
}

.counter {
  font-size: 0.8125rem;
  color: var(--muted);
}

.notice.error {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  color: var(--error);
  background: #fef2f2;
  border: 1px solid #fecaca;
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

.course-group {
  display: grid;
  gap: 0.5rem;
}

h3 {
  margin: 0.5rem 0 0;
  font-size: 0.9375rem;
  color: var(--ink);
}

.course-count {
  margin-left: 0.375rem;
  font-size: 0.75rem;
  color: var(--muted);
  font-weight: 400;
}

.card {
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  background: #fff;
  overflow: hidden;
}

.card-done {
  opacity: 0.72;
}

.card-open {
  border-color: #bae6fd;
}

.card-main {
  display: grid;
  gap: 0.25rem;
  width: 100%;
  min-height: 44px;
  padding: 0.625rem 0.75rem;
  border: none;
  background: none;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.card-title {
  font-weight: 500;
  color: var(--ink);
}

.card-chapter {
  font-size: 0.75rem;
  color: var(--muted);
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
}

.badge {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  white-space: nowrap;
}

.badge-overdue { color: #b91c1c; background: #fee2e2; }
.badge-danger { color: #c2410c; background: #ffedd5; }
.badge-warning { color: #a16207; background: #fef9c3; }
.badge-normal { color: var(--muted); background: #f1f5f9; }
.badge-submitted { color: #15803d; background: #dcfce7; }
.badge-missed { color: #64748b; background: #f1f5f9; }

.deadline {
  color: var(--muted);
}

.card-detail {
  padding: 0 0.75rem 0.75rem;
  display: grid;
  gap: 0.5rem;
}

.detail-hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--muted);
  line-height: 1.5;
}

.attachment-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.25rem;
}

.link-button {
  min-height: 44px;
  padding: 0 0.5rem;
  border: none;
  background: none;
  color: #0369a1;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.link-button:hover {
  text-decoration: underline;
}

.go-submit {
  justify-self: start;
  min-height: 44px;
  padding: 0.5rem 1rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  color: #fff;
  background: var(--ink);
  font: inherit;
  cursor: pointer;
}

.note {
  margin: 0;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.6;
}
</style>
