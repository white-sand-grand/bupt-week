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

const currentCourse = computed(() => coursewareStore.courses.value.find(
  (item) => item.id === coursewareStore.currentSiteId.value,
))
const currentCourseName = computed(() => currentCourse.value?.name || '')

function onCourseKeydown(event, index) {
  const last = coursewareStore.courses.value.length - 1
  let next
  if (event.key === 'ArrowDown') next = index === last ? 0 : index + 1
  else if (event.key === 'ArrowUp') next = index === 0 ? last : index - 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = last
  else return

  event.preventDefault()
  coursewareStore.openCourse(coursewareStore.courses.value[next].id)
  event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus()
}

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
    <h2>课件</h2>

    <p v-if="!ready" class="empty">
      登录后可以按课程浏览课件并下载。未登录也能浏览此页面，只是没有数据。
    </p>

    <template v-else>
      <div v-if="coursewareStore.coursesState.value === 'loading'" class="empty">正在获取课程列表…</div>
      <div v-else-if="coursewareStore.coursesState.value === 'error'" class="notice notice-error" role="alert">
        <span class="notice-text">课程列表获取失败：{{ coursewareStore.coursesError.value }}</span>
        <button class="notice-action" type="button" @click="coursewareStore.loadCourses()">重试</button>
      </div>
      <p v-else-if="coursewareStore.coursesState.value === 'done' && !coursewareStore.courses.value.length" class="empty">
        本学期没有开课记录。
      </p>

      <div v-if="coursewareStore.coursesState.value === 'done' && coursewareStore.courses.value.length" class="courseware-layout">
        <aside class="course-sidebar" aria-labelledby="course-list-title">
          <div class="sidebar-head">
            <h3 id="course-list-title">选择课程</h3>
            <span class="course-count">{{ coursewareStore.courses.value.length }} 门</span>
          </div>
          <div class="course-chips" role="tablist" aria-label="选择课程" aria-orientation="vertical">
            <button
              v-for="(course, index) in coursewareStore.courses.value"
              :id="`course-tab-${course.id}`"
              :key="course.id"
              type="button"
              role="tab"
              class="chip"
              :class="{ 'chip-active': course.id === coursewareStore.currentSiteId.value }"
              :aria-selected="course.id === coursewareStore.currentSiteId.value"
              :tabindex="course.id === coursewareStore.currentSiteId.value ? 0 : -1"
              aria-controls="courseware-files"
              @click="coursewareStore.openCourse(course.id)"
              @keydown="onCourseKeydown($event, index)"
            >
              <span class="course-name">{{ course.name }}</span>
              <span class="course-teacher">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <circle cx="8" cy="5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.3" />
                  <path d="M3 13a5 5 0 0110 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                </svg>
                <span>任课老师：{{ course.teacher || '暂未提供' }}</span>
              </span>
            </button>
          </div>
        </aside>

        <section
          v-if="currentCourse"
          id="courseware-files"
          class="files-panel"
          role="tabpanel"
          :aria-labelledby="`course-tab-${coursewareStore.currentSiteId.value}`"
          :aria-busy="treeState === 'loading'"
          tabindex="0"
        >
          <header class="files-head">
            <div class="files-heading">
              <p class="files-label">课件文件</p>
              <h3>{{ currentCourseName }}</h3>
              <p class="files-teacher">任课老师：{{ currentCourse.teacher || '暂未提供' }}</p>
            </div>
            <span v-if="treeState === 'done'" class="counter">{{ coursewareStore.fileCount.value }} 份资料</span>
          </header>
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
                <svg class="folder-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M2 4h4l1.5 1.5H14v7H2zM2 4V2.5h4L7.5 4H13v1.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                </svg>
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
          <p class="note">课件来自云邮教学空间，按课程目录展示。点击文件名下载，外部链接将在新页面打开。</p>
        </section>
      </div>
    </template>
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

.counter {
  flex-shrink: 0;
  padding: 0.25rem 0.75rem;
  border-radius: var(--radius-pill);
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--brand-700);
  background: var(--brand-050);
  border: 1px solid var(--brand-100);
}

.courseware-layout {
  display: grid;
  grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr);
  align-items: start;
  gap: 1.25rem;
}

.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.25rem 0.25rem 0.75rem;
}

.sidebar-head h3 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 500;
}

.course-count,
.files-label,
.course-teacher {
  color: var(--muted);
  font-size: 0.75rem;
}

.course-chips {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 36rem;
  overflow-y: auto;
  scrollbar-width: thin;
  padding: 0.25rem;
}

.chip {
  flex-shrink: 0;
  display: grid;
  gap: 0.375rem;
  min-height: var(--touch);
  padding: 0.875rem 1rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  cursor: pointer;
  text-align: left;
  overflow-wrap: anywhere;
}

.chip:hover:not(.chip-active) {
  background: var(--brand-050);
  border-color: var(--brand-100);
}

.course-name {
  font-size: 0.9375rem;
  font-weight: 500;
  line-height: 1.5;
}

.course-teacher {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  line-height: 1.5;
}

.course-teacher svg {
  align-self: flex-start;
  margin-top: 0.125rem;
}

.chip-active {
  color: var(--button-ink);
  background: var(--button-bg);
  border-color: var(--button-bg);
}

.chip-active .course-teacher {
  color: inherit;
}

.files-panel {
  min-width: 0;
  min-height: 28rem;
  padding: 1.25rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.files-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--line-soft);
}

.files-heading {
  min-width: 0;
  flex: 1 1 12rem;
  overflow-wrap: anywhere;
}

.files-label {
  margin: 0 0 0.375rem;
}

.files-head h3 {
  margin: 0;
  font-size: 1.125rem;
  line-height: 1.5;
}

.files-teacher {
  margin: 0.375rem 0 0;
  color: var(--muted);
  font-size: 0.8125rem;
}

.files-panel > .empty {
  display: grid;
  place-content: center;
  min-height: 15rem;
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
  align-items: center;
  flex-wrap: wrap;
  gap: 0.375rem;
  min-height: var(--touch);
  border-bottom: 1px solid var(--line-soft);
  overflow-wrap: anywhere;
}

.resource-row:last-child {
  border-bottom: none;
}

/* 目录行：比文件行重一档，读者先扫目录再挑文件 */
.resource-node {
  margin-top: 0.5rem;
  padding-block: 0.375rem;
  background: var(--surface-sunken);
  border-radius: var(--radius-sm);
}

.folder-icon {
  margin-left: 0.5rem;
  color: var(--muted);
}

.node-name {
  font-weight: 500;
  color: var(--ink);
  font-size: 0.875rem;
}

.node-meta,
.file-meta {
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
  min-width: 0;
  max-width: 100%;
}

.course-teacher svg,
.folder-icon,
.link-button svg {
  flex-shrink: 0;
}

.link-button:hover:not(:disabled) {
  text-decoration: underline;
}

.link-button:disabled {
  opacity: 0.55;
  cursor: default;
}

.file-meta {
  margin-left: auto;
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

.note {
  margin: 1rem 0 0;
  color: var(--ink-soft);
  font-size: 0.75rem;
}

@media (max-width: 48rem) {
  .courseware-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
  }

  .course-chips {
    max-height: 16rem;
  }

  .files-panel {
    min-height: 22rem;
    padding: 1rem;
  }
}
</style>
