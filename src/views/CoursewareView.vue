<script setup>
import { computed, onMounted, watch } from 'vue'
import { coursewareStore } from '../composables/coursewareStore.js'
import { downloadsStore } from '../composables/downloads.js'

const props = defineProps({
  /** 云邮登录态是否就绪。 */
  ready: { type: Boolean, default: false },
})

/** 当前课的资料行（拉平结果）。 */
const rows = computed(() => coursewareStore.trees.value[coursewareStore.currentSiteId.value]?.rows || [])
const treeState = computed(
  () => coursewareStore.trees.value[coursewareStore.currentSiteId.value]?.state || 'idle',
)
const treeError = computed(
  () => coursewareStore.trees.value[coursewareStore.currentSiteId.value]?.error || '',
)

const currentCourseName = computed(() => {
  const course = coursewareStore.courses.value.find((item) => item.id === coursewareStore.currentSiteId.value)
  return course?.name || ''
})

function startLoad() {
  if (props.ready && coursewareStore.coursesState.value === 'idle') {
    coursewareStore.loadCourses()
  }
}

onMounted(startLoad)
watch(() => props.ready, startLoad)
</script>

<template>
  <section class="pane">
    <header class="pane-head">
      <h2>课件</h2>
      <span v-if="coursewareStore.fileCount.value" class="counter">
        {{ coursewareStore.fileCount.value }} 份资料
      </span>
    </header>

    <p v-if="!ready" class="empty">
      登录后可以按课程浏览课件并下载。未登录也能浏览此页面，只是没有数据。
    </p>

    <template v-else>
      <!-- 课程选择：横向滚动 chips，选中的加实底 -->
      <div v-if="coursewareStore.coursesState.value === 'done' && coursewareStore.courses.value.length" class="course-chips" role="tablist" aria-label="选择课程">
        <button
          v-for="course in coursewareStore.courses.value"
          :key="course.id"
          type="button"
          role="tab"
          class="chip"
          :class="{ 'chip-active': course.id === coursewareStore.currentSiteId.value }"
          :aria-selected="course.id === coursewareStore.currentSiteId.value"
          @click="coursewareStore.openCourse(course.id)"
        >
          {{ course.name }}
        </button>
      </div>

      <div v-if="coursewareStore.coursesState.value === 'loading'" class="empty">正在获取课程列表…</div>
      <div v-else-if="coursewareStore.coursesState.value === 'error'" class="notice notice-error" role="alert">
        <span class="notice-text">课程列表获取失败：{{ coursewareStore.coursesError.value }}</span>
        <button class="notice-action" type="button" @click="coursewareStore.loadCourses()">重试</button>
      </div>
      <p v-else-if="coursewareStore.coursesState.value === 'done' && !coursewareStore.courses.value.length" class="empty">
        本学期没有开课记录。
      </p>

      <template v-if="coursewareStore.currentSiteId.value">
        <div v-if="treeState === 'loading'" class="empty">正在获取{{ currentCourseName }}的课件…</div>
        <div v-else-if="treeState === 'error'" class="notice notice-error" role="alert">
          <span class="notice-text">课件获取失败：{{ treeError }}</span>
          <button class="notice-action" type="button" @click="coursewareStore.retryTree(coursewareStore.currentSiteId.value)">重试</button>
        </div>
        <p v-else-if="treeState === 'done' && !rows.length" class="empty">
          这门课还没有上传过课件资料。
        </p>

        <!-- 一页铺开：目录行 + 文件行交错，按深度缩进。文件行点名字即下载
             （与作业附件同一入口，进度文案/进度条/防连点全共用）。 -->
        <ul v-else-if="rows.length" class="resource-list">
          <li
            v-for="row in rows"
            :key="row.key"
            class="resource-row"
            :class="{ 'resource-node': row.isNode }"
            :style="{ paddingInlineStart: `${row.depth * 1.1}rem` }"
          >
            <template v-if="row.isNode">
              <span class="node-name">{{ row.name }}</span>
              <span v-if="row.meta" class="node-meta">{{ row.meta }}</span>
            </template>
            <template v-else-if="row.isLink">
              <a class="link-button" :href="row.link" target="_blank" rel="noopener">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M6.5 9.5l3-3M5 11l6-6m-6 6h2.5m2.5 0H12M4 8V4.5h8V8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span>{{ row.name }}</span>
              </a>
            </template>
            <template v-else>
              <button
                class="link-button"
                type="button"
                :disabled="downloadsStore.isBusy(row.resourceId)"
                @click="downloadsStore.start(row.resourceId, row.name)"
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8M3.5 12.5h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span>{{ row.name }}</span>
              </button>
              <span v-if="row.meta" class="file-meta">{{ row.meta }}</span>
              <span v-if="downloadsStore.hintFor(row.resourceId)" class="detail-hint download-hint" aria-live="polite">
                {{ downloadsStore.hintFor(row.resourceId) }}
              </span>
              <span v-if="downloadsStore.progressRatioFor(row.resourceId) !== null" class="deadline-track" aria-hidden="true">
                <span
                  class="deadline-fill bar-normal"
                  :style="{ width: Math.round(downloadsStore.progressRatioFor(row.resourceId) * 100) + '%' }"
                ></span>
              </span>
            </template>
          </li>
        </ul>
      </template>
    </template>

    <p class="note">
      课件来自云邮教学空间，按老师建的课程目录结构展示。文件名旁是格式与大小，点击文件名下载。
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

/* 课程 chips：一行放不下就横向滚动（手机上课程多）。 */
.course-chips {
  display: flex;
  gap: 0.375rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
  -webkit-overflow-scrolling: touch;
}

.chip {
  flex-shrink: 0;
  min-height: var(--touch);
  padding: 0.25rem 0.875rem;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink-soft);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
  white-space: nowrap;
}

.chip-active {
  color: #fff;
  background: var(--brand-600);
  border-color: var(--brand-600);
}

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

.resource-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.125rem;
}

.resource-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.375rem;
  min-height: var(--touch);
  align-content: center;
  border-bottom: 1px solid var(--line-soft);
}

.resource-row:last-child {
  border-bottom: none;
}

/* 目录行：比文件行重一档，读者先扫目录再挑文件 */
.resource-node {
  min-height: 2.2rem;
  align-content: center;
}

.node-name {
  font-weight: 500;
  color: var(--ink);
  font-size: 0.875rem;
}

.node-meta {
  font-size: 0.6875rem;
  color: var(--muted);
}

.link-button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: var(--touch);
  padding: 0 0.5rem 0 0;
  border: none;
  background: none;
  color: var(--brand-600);
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
  text-align: left;
  border-radius: var(--radius-sm);
  text-decoration: none;
}

.link-button:hover:not(:disabled) {
  text-decoration: underline;
}

.link-button:disabled {
  opacity: 0.55;
  cursor: default;
}

.file-meta {
  font-size: 0.6875rem;
  color: var(--muted);
}

.download-hint {
  font-size: 0.75rem;
  color: var(--muted);
  line-height: 1.5;
  flex-basis: 100%;
  padding-left: 1.4rem;
}

/* 进度条铺满整行（文件行是 wrap 的，进度条自己占一行） */
.resource-row .deadline-track {
  flex-basis: 100%;
  height: 4px;
  margin-top: 0.125rem;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  overflow: hidden;
}

@supports not (background: color-mix(in srgb, red 10%, blue)) {
  .resource-row .deadline-track {
    background: var(--surface-sunken);
  }
}

.resource-row .deadline-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--brand-500);
  transition: width 0.3s ease;
}

@media (prefers-color-scheme: dark) {
  .link-button {
    color: var(--brand-500);
  }
}

.note {
  margin: 0;
  color: var(--ink-soft);
  font-size: 0.75rem;
  line-height: 1.6;
}
</style>
