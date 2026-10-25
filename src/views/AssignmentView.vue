<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { auth } from '../composables/auth.js'
import { assignmentsStore } from '../composables/assignments.js'
import { downloadsStore } from '../composables/downloads.js'
import { buildAssignmentUrl } from '../utils/assignment-url.js'
import { deadlineProgress, formatCountdown } from '../utils/deadline.js'
import { formatUpdatedAt, beijingDateString } from '../utils/format.js'

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

/** 「更新于 X」：数据新旧可感知。 */
const savedAtText = computed(() => formatUpdatedAt(assignmentsStore.savedAt.value))

// ── 附件下载（状态与文案助手都在 downloadsStore：切视图重挂载也不丢）──

/** 附件行内的状态文案与进度：见 composables/downloads.js hintFor/progressRatioFor。 */

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

/** 进度条的时间基准。它随分钟走，截止临近时填充和颜色才会自己动起来。 */
const now = ref(Date.now())
let progressClock = null

/** 倒计时的锚定时刻：页面打开那一刻，不随时钟走（要求不实时刷新，
 *  重新打开或刷新页面才重新取时间）。模块级而不是组件级——切视图重挂载
 *  也不重置。 */
const anchoredNow = Date.now()

/** 班级手动录入的作业（siteId 形如 class:{id}）：卡片上标注来源班级。 */
function isClassAssignment(assignment) {
  return typeof assignment.courseId === 'string' && assignment.courseId.startsWith('class:')
}

/** 未提交的作业才有进度可言；已提交的返回 null（不画条）。 */
function progressOf(assignment) {
  if (assignment.isCompleted) return null
  return deadlineProgress(assignment.beginTime, assignment.deadline, now.value)
}

/** 距截止倒计时（精确到分钟）：未提交且未过截止才有。 */
function countdownOf(assignment) {
  if (assignment.isCompleted) return ''
  return formatCountdown(assignment.deadline, anchoredNow)
}

function startLoad() {
  if (props.ready && assignmentsStore.state.value === 'idle') {
    assignmentsStore.load()
  }
}

onMounted(() => {
  startLoad()
  progressClock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
watch(() => props.ready, startLoad)
onUnmounted(() => clearInterval(progressClock))

const groups = computed(() => assignmentsStore.groups.value)
</script>

<template>
  <section class="pane">
    <header class="pane-head">
      <h2>作业</h2>
      <div class="head-actions">
        <!-- 过滤开关：文案即按下后的动作（只看未提交 ⇄ 显示全部）。
             往期作业上游已滤掉，这里只在本学期列表里切。 -->
        <button
          v-if="ready"
          class="filter-toggle"
          :class="{ 'filter-toggle-on': assignmentsStore.unsubmittedOnly.value }"
          type="button"
          @click="assignmentsStore.toggleUnsubmittedOnly()"
        >{{ assignmentsStore.unsubmittedOnly.value ? '显示全部' : '只看未提交' }}</button>
        <span v-if="assignmentsStore.unfinishedCount.value" class="counter">
          {{ assignmentsStore.unfinishedCount.value }} 项未完成
        </span>
      </div>
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

    <!-- 「只看未提交」开着但一条不剩：说明全交了，不是没数据，口径要分开说 -->
    <p v-else-if="assignmentsStore.filteredEmpty.value" class="empty">
      没有未提交的作业，全部作业都交了。
      想看已提交的，点右上角「显示全部」。
    </p>

    <p v-else-if="!groups.length" class="empty">本学期没有作业记录。</p>

    <template v-else>
      <section v-for="group in groups" :key="group.key || group.courseName" class="course-group">
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
            <span v-if="assignment.chapter || isClassAssignment(assignment)" class="card-chapter">
              {{ assignment.chapter }}<span v-if="isClassAssignment(assignment)" class="class-source">{{ assignment.courseName }}</span>
            </span>
            <span class="card-meta">
              <span class="badge" :class="LEVEL_CLASS[assignment.level]">{{ assignment.status }}</span>
              <span v-if="deadlineLabel(assignment)" class="deadline">{{ deadlineLabel(assignment) }}</span>
              <span v-if="countdownOf(assignment)" class="countdown">{{ countdownOf(assignment) }}</span>
            </span>
            <!-- 截止进度：细长一条，颜色与左侧色条同源（颜色即紧急度）。装饰性——
                 语义已由徽标和时间文本承载，进度条只是视觉冗余，对读屏隐藏。 -->
            <span
              v-if="progressOf(assignment) !== null"
              class="deadline-track"
              aria-hidden="true"
            >
              <span
                class="deadline-fill"
                :class="LEVEL_BAR_CLASS[assignment.level]"
                :style="{ width: Math.round(progressOf(assignment) * 100) + '%' }"
              ></span>
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
                  <!-- 下载中禁用：同一附件不允许叠两份下载（防连点在 store 里，这里只是可见的收口） -->
                  <button
                    class="link-button"
                    type="button"
                    :disabled="downloadsStore.isBusy(attachment.resourceId)"
                    @click="downloadsStore.start(attachment.resourceId, attachment.resourceName)"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path d="M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8M3.5 12.5h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <span>{{ attachment.resourceName }}</span>
                  </button>
                  <span v-if="downloadsStore.hintFor(attachment.resourceId)" class="detail-hint download-hint" aria-live="polite">
                    {{ downloadsStore.hintFor(attachment.resourceId) }}
                  </span>
                  <!-- 进度条与截止进度同款（deadline-track）：同一套视觉语言。
                       总大小未知时只有文案，不画条假装精确。 -->
                  <span v-if="downloadsStore.progressRatioFor(attachment.resourceId) !== null" class="deadline-track" aria-hidden="true">
                    <span
                      class="deadline-fill bar-normal"
                      :style="{ width: Math.round(downloadsStore.progressRatioFor(attachment.resourceId) * 100) + '%' }"
                    ></span>
                  </span>
                </li>
              </ul>
            </template>

            <!-- 云邮作业：新标签打开云邮提交页。浏览器已有云邮会话则直达；没有会话会被
                 弹到统一身份认证，而学校的 CAS 桌面登录页对现代浏览器服务端故障（白屏，
                 见 utils/assignment-url.js 注释）——微信内不受影响（企微自动识别）。
                 班级录入的作业不在云邮系统里，按钮置灰不给跳转。 -->
            <a
              v-if="!isClassAssignment(assignment)"
              class="go-submit"
              :href="buildAssignmentUrl(assignment.id)"
              target="_blank"
              rel="noopener"
            >去交作业</a>
            <button v-else class="go-submit" type="button" disabled>去交作业</button>
            <p v-if="isClassAssignment(assignment)" class="detail-hint">
              班级录入的作业不在云邮系统里，没有在线提交入口；提交方式写在作业内容里。
            </p>
            <p v-else class="detail-hint">
              在云邮页面提交。已登录过云邮会直达这份作业；若打开后是空白页，
              请在手机微信里打开本站再点（会自动识别企业微信身份），或稍后再试。
            </p>
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

.head-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* 过滤开关：开着时用品牌底色标出当前模式（明暗两套主题都取 counter 的配色对） */
.filter-toggle {
  min-height: var(--touch);
  padding: 0 0.875rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--ink-soft);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.filter-toggle-on {
  color: var(--brand-700);
  background: var(--brand-050);
  border-color: var(--brand-100);
}

@media (prefers-color-scheme: dark) {
  .filter-toggle {
    /* 深色下 surface 与页面背景对比弱，给个实底（与顶栏退出按钮同理） */
    background: var(--surface-sunken);
  }

  .filter-toggle-on {
    color: var(--brand-600);
  }
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

/* 截止进度条：细长（4px）一条，铺在时间行下方，颜色复用上面的 level 色条。
   track 用暗一档的底色兜住未填充部分，暗色主题下也够对比。 */
.deadline-track {
  display: block;
  height: 4px;
  margin-top: 0.5rem;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  overflow: hidden;
}

@supports not (background: color-mix(in srgb, red 10%, blue)) {
  .deadline-track {
    background: var(--surface-sunken);
  }
}

.deadline-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  transition: width 0.3s ease;
}

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

/* 班级作业的来源班级 chip：作业栏按科目分组后，靠它区分来自哪个班 */
.class-source {
  margin-left: 0.375rem;
  padding: 0.05rem 0.45rem;
  border-radius: var(--radius-pill);
  font-size: 0.6875rem;
  color: var(--brand-700);
  background: var(--brand-050);
  border: 1px solid var(--brand-100);
  vertical-align: 1px;
}

@media (prefers-color-scheme: dark) {
  .class-source {
    color: var(--brand-600);
  }
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

/* 距截止倒计时：按页面打开时刻算的静态值，比截止时间更醒目一档 */
.countdown {
  color: var(--ink-soft);
  font-weight: 500;
  white-space: nowrap;
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

.link-button:hover:not(:disabled) {
  text-decoration: underline;
}

/* 在途下载：视觉上明确「按了没用了」，等这轮结束自动恢复 */
.link-button:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 状态文案缩进对齐文件名（图标宽 + 间距），别顶着行首 */
.download-hint {
  padding-left: 1.4rem;
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

/* 班级录入的作业没有云邮提交页：置灰占位，别让同学去点一个不存在的跳转 */
.go-submit:disabled {
  border-color: var(--line);
  color: var(--muted);
  background: var(--surface-sunken);
  box-shadow: none;
  cursor: not-allowed;
}

.note {
  margin: 0;
  color: var(--ink-soft);
  font-size: 0.75rem;
  line-height: 1.6;
}
</style>
