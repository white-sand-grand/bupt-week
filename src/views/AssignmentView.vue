<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { auth } from '../composables/auth.js'
import { assignmentsStore } from '../composables/assignments.js'
import { downloadResource } from '../api/files.js'
import { buildAssignmentUrl } from '../utils/assignment-url.js'
import { formatUpdatedAt, beijingDateString } from '../utils/format.js'
import { friendlyError } from '../utils/errors.js'

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

/** 卡片左侧紧急度色条与角标同源：颜色即优先级，扫一眼就能分层。 */
const LEVEL_BAR_CLASS = {
  overdue: 'bar-overdue',
  danger: 'bar-danger',
  warning: 'bar-warning',
  normal: 'bar-normal',
  submitted: 'bar-submitted',
  missed: 'bar-missed',
}

/** 逾期/临期卡片整体铺一层极淡的对应色，颜色语义从色条扩展到整卡。 */
const LEVEL_CARD_CLASS = {
  overdue: 'card-overdue',
  danger: 'card-danger',
}

const downloadErrors = ref({})

/** 「更新于 X」：数据新旧可感知。 */
const savedAtText = computed(() => formatUpdatedAt(assignmentsStore.savedAt.value))

/** 截止时间的口语化表述：今天/明天直接点名，其余落回「月/日 时:分」。
 *  deadline 是无时区的北京时间墙上钟，因此也按北京日期比较；
 *  格式不合预期（脏数据）时返回空串，宁可不显示也不给垃圾文本。 */
function deadlineLabel(assignment) {
  const raw = assignment.deadline
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw || '')) return ''
  const date = raw.slice(0, 10)
  const time = raw.slice(11, 16)
  if (date === beijingDateString(0)) return `今天 ${time} 截止`
  if (date === beijingDateString(1)) return `明天 ${time} 截止`
  return `${date.slice(5).replace('-', '/')} ${time} 截止`
}

async function download(attachment) {
  try {
    await downloadResource(attachment.resourceId, attachment.resourceName)
  } catch (error) {
    // 网络黑话（Failed to fetch）换成人话，附上重试方式（再点一次即可）
    downloadErrors.value[attachment.resourceId] = friendlyError(error)
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

    <!-- 有缓存数据但刷新失败：数据照常可用，黄条说明来龙去脉（独立于列表渲染链） -->
    <div v-if="ready && assignmentsStore.stale.value" class="notice notice-warn" role="status">
      <span class="notice-text">
        作业刷新失败：{{ assignmentsStore.error.value }}。
        <span v-if="savedAtText">以下为 {{ savedAtText }} 缓存的数据。</span>
        截止时间过了的话，列表可能已经变化。
      </span>
      <button class="notice-action" type="button" @click="assignmentsStore.retry()">重新刷新</button>
    </div>

    <p v-if="!ready" class="empty">
      登录后可以查看作业列表、下载附件，并直接跳转到提交页。
      未登录也能浏览此页面，只是没有数据。
    </p>
    <p v-else-if="assignmentsStore.state.value === 'loading' && !groups.length" class="empty">正在获取作业…</p>

    <!-- 彻底失败（手里没有任何数据）：说人话 + 重试出路 -->
    <div v-else-if="assignmentsStore.state.value === 'error'" class="notice notice-error" role="alert">
      <span class="notice-text">作业列表获取失败：{{ assignmentsStore.error.value }}</span>
      <button class="notice-action" type="button" @click="assignmentsStore.retry()">重试</button>
    </div>

    <p v-else-if="!groups.length" class="empty">本学期没有作业记录。</p>

    <template v-else>
      <section v-for="group in groups" :key="group.courseName" class="course-group">
        <h3>{{ group.courseName }}<span class="course-count">{{ group.items.length }} 项</span></h3>

        <article
          v-for="assignment in group.items"
          :key="assignment.id"
          class="card"
          :class="[{ 'card-done': assignment.isCompleted, 'card-open': assignmentsStore.expanded.value[assignment.id] }, LEVEL_CARD_CLASS[assignment.level]]"
        >
          <span class="level-bar" :class="LEVEL_BAR_CLASS[assignment.level]" aria-hidden="true"></span>
          <button class="card-main" type="button" @click="assignmentsStore.toggle(assignment.id)">
            <span class="card-row">
              <span class="card-title">{{ assignment.title }}</span>
              <svg
                class="chevron"
                :class="{ 'chevron-open': assignmentsStore.expanded.value[assignment.id] }"
                viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
              >
                <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <span v-if="assignment.chapter" class="card-chapter">{{ assignment.chapter }}</span>
            <span class="card-meta">
              <span class="badge" :class="LEVEL_CLASS[assignment.level]">{{ assignment.status }}</span>
              <span v-if="deadlineLabel(assignment)" class="deadline">{{ deadlineLabel(assignment) }}</span>
            </span>
          </button>

          <div v-if="assignmentsStore.expanded.value[assignment.id]" class="card-detail">
            <template v-if="assignmentsStore.attachmentState.value[assignment.id] === 'loading'">
              <p class="detail-hint">正在加载附件…</p>
            </template>
            <template v-else-if="assignmentsStore.attachmentState.value[assignment.id] === 'error'">
              <p class="detail-hint">附件加载失败，可能是网络不稳定。</p>
              <button
                class="notice-action notice-action-inline"
                type="button"
                @click="assignmentsStore.retryAttachment(assignment.id)"
              >重试加载附件</button>
            </template>
            <template v-else>
              <p v-if="!assignmentsStore.attachments.value[assignment.id]?.length" class="detail-hint">
                这份作业没有附件。
              </p>
              <ul v-else class="attachment-list">
                <li v-for="attachment in assignmentsStore.attachments.value[assignment.id]" :key="attachment.resourceId">
                  <button class="link-button" type="button" @click="download(attachment)">
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path d="M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8M3.5 12.5h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <span>{{ attachment.resourceName }}</span>
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
      <span v-if="savedAtText && !assignmentsStore.stale.value">数据更新于 {{ savedAtText }}。</span>
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
  padding: 0.25rem 0.75rem;
  border-radius: var(--radius-pill);
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--brand-700);
  background: var(--brand-050);
  border: 1px solid var(--brand-100);
}

@media (prefers-color-scheme: dark) {
  .counter {
    color: var(--brand-600);
  }
}

/* 状态提示与课表视图同一套语言：红=彻底失败（带重试），黄=有数据但刷新失败 */
.notice-error {
  margin: 0;
  padding: 0.625rem 0.75rem;
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  color: var(--error);
  background: var(--error-bg);
  border: 1px solid var(--error-line);
  font-size: 0.8125rem;
}

.notice-warn {
  margin: 0;
  padding: 0.625rem 0.75rem;
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid #fde68a;
  font-size: 0.8125rem;
}

.notice-text {
  line-height: 1.55;
}

.notice-action {
  align-self: flex-start;
  min-height: var(--touch);
  padding: 0.4rem 1rem;
  border: 1px solid currentColor;
  border-radius: var(--radius-pill);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}

.notice-action-inline {
  justify-self: start;
  color: var(--brand-600);
  border-color: var(--brand-500);
}

@media (prefers-color-scheme: dark) {
  .notice-warn {
    border-color: #55461a;
  }

  .notice-action-inline {
    color: var(--brand-500);
  }
}

.empty {
  margin: 0;
  padding: 2rem 1rem;
  border: 1px dashed var(--line);
  border-radius: var(--radius-md);
  color: var(--muted);
  font-size: 0.875rem;
  line-height: 1.6;
  text-align: center;
  background: var(--surface);
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
  padding: 0.05rem 0.45rem;
  border-radius: var(--radius-pill);
  font-size: 0.6875rem;
  color: var(--muted);
  background: var(--surface-sunken);
  border: 1px solid var(--line-soft);
  font-weight: 400;
  vertical-align: 1px;
}

.card {
  position: relative;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.card-overdue {
  background: rgba(185, 28, 28, 0.04);
  background: color-mix(in srgb, var(--error) 4%, var(--surface));
}

.card-danger {
  background: rgba(234, 88, 12, 0.04);
  background: color-mix(in srgb, #ea580c 4%, var(--surface));
}

.card-open {
  border-color: var(--brand-500);
  box-shadow: var(--shadow-md);
}

.card-done {
  opacity: 0.72;
}

/* 紧急度色条：贴卡片左缘，颜色与角标语义一致（展开式写法，兼容旧 webview 内核） */
.level-bar {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 4px;
}

.bar-overdue { background: #dc2626; }
.bar-danger { background: #ea580c; }
.bar-warning { background: #ca8a04; }
.bar-normal { background: var(--brand-500); }
.bar-submitted { background: #16a34a; }
.bar-missed { background: #94a3b8; }

.card-main {
  display: grid;
  gap: 0.25rem;
  width: 100%;
  min-height: var(--touch);
  padding: 0.625rem 0.875rem 0.625rem 1rem;
  border: none;
  background: none;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.card-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.card-title {
  flex: 1;
  font-weight: 500;
  color: var(--ink);
}

.chevron {
  flex-shrink: 0;
  color: var(--muted);
  transition: transform 0.18s ease;
}

.chevron-open {
  transform: rotate(180deg);
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
  border-radius: var(--radius-pill);
  font-size: 0.6875rem;
  white-space: nowrap;
}

.badge-overdue { color: #b91c1c; background: var(--error-bg); border: 1px solid var(--error-line); }
.badge-danger { color: #ea580c; background: var(--danger-bg); }
.badge-warning { color: var(--warn); background: var(--warn-bg); }
.badge-normal { color: var(--muted); background: var(--surface-sunken); }
.badge-submitted { color: var(--ok); background: var(--ok-bg); border: 1px solid var(--ok-line); }
.badge-missed { color: var(--muted); background: var(--surface-sunken); }

.deadline {
  color: var(--muted);
}

.card-detail {
  padding: 0.25rem 0.875rem 0.75rem 1rem;
  display: grid;
  gap: 0.5rem;
  animation: slide-in 0.18s ease;
}

@keyframes slide-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
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
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: var(--touch);
  padding: 0 0.5rem;
  border: none;
  background: none;
  color: var(--brand-600);
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
  text-align: left;
  border-radius: var(--radius-sm);
}

.link-button:hover {
  text-decoration: underline;
}

@media (prefers-color-scheme: dark) {
  .link-button {
    color: var(--brand-500);
  }
}

.go-submit {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  min-height: var(--touch);
  padding: 0.5rem 1.25rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: #fff;
  background: linear-gradient(180deg, var(--brand-600), var(--brand-700));
  box-shadow: var(--shadow-sm);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  transition: filter 0.15s ease;
}

.go-submit:active {
  filter: brightness(0.96);
}

.note {
  margin: 0;
  color: var(--ink-soft);
  font-size: 0.75rem;
  line-height: 1.6;
}
</style>
