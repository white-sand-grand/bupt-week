<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { auth } from '../composables/auth.js'
import { timetable } from '../composables/timetable.js'
import { currentTimetableWeek, groupTimetableCourses } from '../utils/timetable-cache.js'
import { formatUpdatedAt } from '../utils/format.js'

const props = defineProps({
  /** 教务处登录态是否就绪。 */
  ready: { type: Boolean, default: false },
})

const gridScroll = ref(null)
/** 首次渲染后只自动定位一次「今天」列，用户手动切周/滚动后不再干预。 */
let revealedToday = false

const periods = computed(() => timetable.activeWeek.value?.periods ?? [])
const days = computed(() => timetable.activeWeek.value?.days ?? [])
const weeks = computed(() => timetable.weeks.value)
const currentWeek = computed(() => timetable.currentWeek.value)

/** 本周（按日期推算）周号，用于下拉框标注。 */
const thisWeekNumber = computed(() => (weeks.value.length ? currentTimetableWeek(weeks.value) : null))

/** 每天的课程分组（重叠课程同组并列），供网格单元格渲染。 */
const dayGroups = computed(() => {
  const courses = timetable.activeWeek.value?.courses ?? []
  return days.value.map((_, index) => groupTimetableCourses(courses, index + 1))
})

/** 某节次行上要展示的课程组：组从本行开始，或从前面延续到本行。 */
function groupsAt(groups, periodNumber) {
  return groups.filter((group) => group.start === periodNumber
    || (group.start < periodNumber && group.end >= periodNumber))
}

/** 课程名 → 稳定色号（0-7）：同名课程永远同色，跨周、跨单元格一致。
 *  简单字符和哈希足够——只为视觉区分，无安全诉求。 */
const PALETTE_SIZE = 8
function courseColor(name) {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 997
  }
  return `c${hash % PALETTE_SIZE}`
}

const syncBanner = computed(() => {
  if (timetable.syncState.value === 'syncing') {
    const { done, total } = timetable.syncProgress.value
    return `正在同步课表（${done}/${total} 周）…`
  }
  return ''
})

/** 「更新于 X」：让用户知道手里的数据是多久前的（可看懂原则）。 */
const savedAtText = computed(() => formatUpdatedAt(timetable.savedAt.value))

function isToday(dayIndex) {
  const day = timetable.activeWeek.value?.days?.[dayIndex]
  if (!day?.date) return false
  const today = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return day.date === `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
}

const weekIndex = computed(() => weeks.value.findIndex((week) => week.week === currentWeek.value))
const canPrev = computed(() => weekIndex.value > 0)
const canNext = computed(() => weekIndex.value !== -1 && weekIndex.value < weeks.value.length - 1)

function shiftWeek(delta) {
  const target = weeks.value[weekIndex.value + delta]
  if (target) timetable.selectWeek(target.week)
}

/** 网格横向超宽时，把「今天」列滚进视口并大致居中——
 *  否则手机首屏只能看到周一到周三，今天在第几列完全不可知。
 *  数据就绪有两条路径：异步 sync 后 activeWeek 变化（watch 兜住），
 *  以及组件重挂载时缓存已就绪、activeWeek 不再变化（onMounted 兜住）。 */
async function revealTodayColumn() {
  if (revealedToday) return
  const scroller = gridScroll.value
  if (!scroller) return
  const todayTh = scroller.querySelector('thead th.today')
  if (!todayTh) return
  revealedToday = true
  await nextTick()
  const target = todayTh.offsetLeft - (scroller.clientWidth - todayTh.offsetWidth) / 2
  scroller.scrollTo({ left: Math.max(0, target) })
}

watch(() => timetable.activeWeek.value, () => {
  nextTick(revealTodayColumn)
})

onMounted(() => {
  nextTick(revealTodayColumn)
})

function startSync() {
  if (props.ready && timetable.syncState.value === 'idle') {
    timetable.sync()
  }
}

onMounted(startSync)
watch(() => props.ready, startSync)
</script>

<template>
  <section class="pane">
    <header class="pane-head">
      <h2>课表</h2>
      <div v-if="weeks.length" class="week-nav">
        <button class="week-step" type="button" :disabled="!canPrev" aria-label="上一周" @click="shiftWeek(-1)">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M10.5 3 5.5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <label class="week-picker">
          <span class="visually-hidden">选择周次</span>
          <select :value="currentWeek" @change="timetable.selectWeek(Number($event.target.value))">
            <option v-for="week in weeks" :key="week.week" :value="week.week">
              第 {{ week.week }} 周{{ week.week === thisWeekNumber ? '（本周）' : '' }}
            </option>
          </select>
        </label>
        <button class="week-step" type="button" :disabled="!canNext" aria-label="下一周" @click="shiftWeek(1)">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M5.5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </header>

    <!-- 同步中：转圈 + 进度，让等待有反馈 -->
    <p v-if="syncBanner" class="notice notice-sync" role="status">
      <svg class="spin" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="28" stroke-dashoffset="22" stroke-linecap="round" />
      </svg>
      {{ syncBanner }}
    </p>

    <!-- 部分同步：说清现状（哪些能用）、原因猜测、给出路（补齐按钮） -->
    <div v-else-if="timetable.syncState.value === 'partial'" class="notice notice-warn" role="status">
      <span class="notice-text">
        已同步 {{ weeks.length }}/{{ weeks.length + timetable.pendingWeeks.value }} 周，还有
        {{ timetable.pendingWeeks.value }} 周暂时拿不到（通常是校园网不稳定），已同步的周次照常可用。
        <span v-if="savedAtText">数据更新于 {{ savedAtText }}。</span>
      </span>
      <button class="notice-action" type="button" @click="timetable.retry()">补齐缺失周次</button>
    </div>

    <!-- 一周都没拿到：说人话 + 重试出路，不留死胡同 -->
    <div v-else-if="timetable.error.value && !weeks.length" class="notice notice-error" role="alert">
      <span class="notice-text">课表同步失败：{{ timetable.error.value }}</span>
      <button class="notice-action" type="button" @click="timetable.retry()">重试</button>
    </div>

    <p v-if="!ready" class="empty">
      登录后可以查看课表。未登录也能浏览此页面，只是没有数据。
    </p>
    <p v-else-if="!weeks.length" class="empty">
      正在获取课表…
    </p>

    <div v-else ref="gridScroll" class="grid-scroll">
      <table class="grid">
        <thead>
          <tr>
            <th class="corner">节次</th>
            <th v-for="(day, index) in days" :key="day.label" :class="{ today: isToday(index) }">
              {{ day.label }}
              <span v-if="isToday(index)" class="today-tag">今天</span>
              <span v-if="day.date" class="day-date">{{ day.date.slice(5) }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="period in periods" :key="period.number">
            <th class="period">
              <span class="period-number">{{ period.number }}</span>
              <span class="period-time">{{ period.time }}</span>
            </th>
            <td
              v-for="(groups, dayIndex) in dayGroups"
              :key="dayIndex"
              class="cell"
              :class="{ 'cell-today': isToday(dayIndex) }"
            >
              <div v-for="group in groupsAt(groups, period.number)" :key="`${group.start}-${group.courses[0].name}`" class="course">
                <template v-if="group.start === period.number">
                  <span
                    v-for="course in group.courses"
                    :key="course.name + course.start"
                    class="course-item"
                    :class="courseColor(course.name)"
                    :title="`${course.name} ${course.schedule} ${course.location}`"
                  >
                    <strong class="course-name">{{ course.name }}</strong>
                    <span class="course-meta">{{ course.location }}</span>
                  </span>
                </template>
                <!-- 延续节次：画同色延伸条表示这门课从上一节连过来，不重复课名 -->
                <span
                  v-else
                  class="course-continued"
                  :class="courseColor(group.courses[0].name)"
                  aria-hidden="true"
                ></span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="note">
      课表来自教务处系统，与作业共用同一套统一身份认证，登录一次即可。
      数据按周缓存在本设备，切换周次不需要联网。
      <span v-if="savedAtText">上次同步：{{ savedAtText }}。</span>
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

/* 周切换器：箭头与下拉拼成一组，视觉上是一个控件 */
.week-nav {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  overflow: hidden;
}

.week-step {
  display: grid;
  place-items: center;
  width: var(--touch);
  min-height: var(--touch);
  padding: 0;
  border: none;
  border-radius: 0;
  background: none;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background 0.15s ease;
}

.week-step + .week-picker {
  border-left: 1px solid var(--line);
  border-right: 1px solid var(--line);
}

.week-step:active:not(:disabled) {
  background: var(--surface-sunken);
}

.week-step:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.week-picker select {
  min-height: var(--touch);
  padding: 0 0.5rem;
  border: none;
  /* 只继承字体族，字号走全局 select 16px 规则（防聚焦缩放） */
  font-family: inherit;
  font-size: 16px;
  color: var(--ink);
  background: transparent;
  cursor: pointer;
}

.notice {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-sm);
  font-size: 0.8125rem;
  color: var(--muted);
  background: var(--surface-sunken);
  border: 1px solid var(--line);
}

/* 三种状态提示：进行中（中性）、部分成功（黄）、彻底失败（红）。
   都允许放一个 ≥44px 的行动按钮，错误永远给出路。 */
.notice-sync {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.spin {
  flex-shrink: 0;
  animation: rotate 0.8s linear infinite;
}

@keyframes rotate {
  to {
    transform: rotate(360deg);
  }
}

.notice-warn {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  color: var(--warn);
  background: var(--warn-bg);
  border-color: #fde68a;
}

.notice-warn .notice-text {
  color: var(--warn);
  line-height: 1.55;
}

.notice-error {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  color: var(--error);
  background: var(--error-bg);
  border-color: var(--error-line);
}

.notice-error .notice-text {
  color: var(--error);
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

.grid-scroll {
  position: relative;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

/* 右缘渐隐：提示还有列可横向滑动（手机上不易发现可滚）。
   只在窄屏启用——那里 min-width 40rem 的网格必然超宽。 */
.grid-scroll::after {
  content: '';
  position: absolute;
  top: 1px;
  right: 1px;
  bottom: 1px;
  width: 2rem;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--surface));
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  display: none;
}

@media (max-width: 43rem) {
  .grid-scroll::after {
    display: block;
  }
}

.grid {
  border-collapse: collapse;
  width: 100%;
  min-width: 40rem;
  font-size: 0.75rem;
}

.grid th,
.grid td {
  border: 1px solid var(--line-soft);
  padding: 0.25rem;
  text-align: left;
  vertical-align: top;
}

.grid thead th {
  background: var(--surface);
  font-weight: 500;
  text-align: center;
  padding: 0.5rem 0.25rem;
  position: sticky;
  top: 0;
  z-index: 1;
}

/* 今日列：表头品牌色胶囊 + 「今天」角标，列身淡染贯穿 */
.grid thead .today {
  color: #fff;
  font-weight: 600;
  background: var(--brand-600);
  border-radius: var(--radius-sm);
  box-shadow: inset 0 -2px 0 var(--brand-700);
}

.today-tag {
  display: block;
  margin-top: 0.1rem;
  font-size: 0.625rem;
  font-weight: 500;
  color: var(--brand-100);
  background: rgb(255 255 255 / 0.18);
  border-radius: var(--radius-pill);
  padding: 0 0.35rem;
}

.grid thead .today .day-date {
  color: rgb(255 255 255 / 0.8);
}

.cell-today {
  background: rgba(42, 108, 224, 0.09);
  background: color-mix(in srgb, var(--brand-500) 9%, transparent);
}

.day-date {
  display: block;
  color: var(--muted);
  font-weight: 400;
  font-size: 0.6875rem;
}

/* 节次列横向 sticky：滚动看后半周时仍知道当前是第几节。
   要铺实底色，否则课程块会从底下透出来。 */
.corner,
.period {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--surface);
  box-shadow: inset -1px 0 0 var(--line-soft);
}

.corner {
  width: 3.75rem;
}

.period {
  text-align: center;
  font-weight: 400;
}

.period-number {
  display: block;
  font-weight: 500;
}

.period-time {
  display: block;
  color: var(--muted);
  font-size: 0.625rem;
  white-space: nowrap;
}

.cell {
  height: 3.25rem;
}

/* 课程卡：同名课程固定一色（courseColor 哈希分配），左缘用同系强色 */
.course-item {
  display: grid;
  gap: 0.125rem;
  padding: 0.3rem 0.35rem 0.3rem 0.45rem;
  border-radius: 0.375rem;
  border: 1px solid;
  border-left: 3px solid var(--c-strong);
  line-height: 1.4;
}

.course + .course {
  margin-top: 0.25rem;
}

.course-name {
  font-size: 0.75rem;
}

.course-meta {
  color: var(--muted);
}

/* 延续节次：同色系淡色竖条，表示课程从上一节延续而来 */
.course-continued {
  display: block;
  height: calc(100% - 0.3rem);
  min-height: 0.75rem;
  border-radius: 0.375rem;
  background: var(--c-strong);
  opacity: 0.35;
}

.note {
  margin: 0;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.6;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* 8 色课程色板：柔和底色 + 同系边框/文字 + 左缘强色。
   去掉了灰白系——它看起来像未渲染/禁用态。 */
.c0 { --c-strong: #3b82f6; background: #eff6ff; border-color: #bfdbfe; color: #1e40af; }
.c1 { --c-strong: #14b8a6; background: #f0fdfa; border-color: #99f6e4; color: #115e59; }
.c2 { --c-strong: #22c55e; background: #f0fdf4; border-color: #bbf7d0; color: #166534; }
.c3 { --c-strong: #eab308; background: #fffbeb; border-color: #fde68a; color: #92400e; }
.c4 { --c-strong: #f97316; background: #fff7ed; border-color: #fed7aa; color: #9a3412; }
.c5 { --c-strong: #f43f5e; background: #fff1f2; border-color: #fecdd3; color: #9f1239; }
.c6 { --c-strong: #8b5cf6; background: #f5f3ff; border-color: #ddd6fe; color: #5b21b6; }
.c7 { --c-strong: #06b6d4; background: #ecfeff; border-color: #a5f3fc; color: #155e75; }

@media (prefers-color-scheme: dark) {
  /* 深色下文字整体提亮一档，保证在色底上的可读性 */
  .c0 { --c-strong: #60a5fa; background: #17233a; border-color: #2b4468; color: #bfdbfe; }
  .c1 { --c-strong: #2dd4bf; background: #102e2b; border-color: #1f5049; color: #99f6e4; }
  .c2 { --c-strong: #4ade80; background: #132718; border-color: #275233; color: #bbf7d0; }
  .c3 { --c-strong: #facc15; background: #2b2410; border-color: #55461a; color: #fde68a; }
  .c4 { --c-strong: #fb923c; background: #2b1c0e; border-color: #5c3a1a; color: #fed7aa; }
  .c5 { --c-strong: #fb7185; background: #2b1216; border-color: #5c2430; color: #fecdd3; }
  .c6 { --c-strong: #a78bfa; background: #221a38; border-color: #43356b; color: #ddd6fe; }
  .c7 { --c-strong: #22d3ee; background: #102a33; border-color: #1e4a57; color: #a5f3fc; }
}
</style>
