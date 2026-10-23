<script setup>
import { computed, onMounted, watch } from 'vue'
import { auth } from '../composables/auth.js'
import { timetable } from '../composables/timetable.js'
import { currentTimetableWeek, groupTimetableCourses } from '../utils/timetable-cache.js'

const props = defineProps({
  /** 教务处登录态是否就绪。 */
  ready: { type: Boolean, default: false },
})

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

const syncBanner = computed(() => {
  if (timetable.syncState.value === 'syncing') {
    const { done, total } = timetable.syncProgress.value
    return `正在同步课表（${done}/${total} 周）…`
  }
  if (timetable.syncState.value === 'partial') {
    return `尚有 ${timetable.pendingWeeks.value} 周未同步，已同步周次可正常查看`
  }
  return ''
})

function isToday(dayIndex) {
  const day = timetable.activeWeek.value?.days?.[dayIndex]
  if (!day?.date) return false
  const today = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return day.date === `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
}

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
      <label v-if="weeks.length" class="week-picker">
        <span class="visually-hidden">选择周次</span>
        <select :value="currentWeek" @change="timetable.selectWeek(Number($event.target.value))">
          <option v-for="week in weeks" :key="week.week" :value="week.week">
            第 {{ week.week }} 周{{ week.week === thisWeekNumber ? '（本周）' : '' }}
          </option>
        </select>
      </label>
    </header>

    <p v-if="syncBanner" class="notice">{{ syncBanner }}</p>
    <p v-else-if="timetable.error.value && !weeks.length" class="notice error" role="alert">
      {{ timetable.error.value }}
    </p>

    <p v-if="!ready" class="empty">
      登录后可以查看课表。未登录也能浏览此页面，只是没有数据。
    </p>
    <p v-else-if="!weeks.length" class="empty">
      正在获取课表…
    </p>

    <div v-else class="grid-scroll">
      <table class="grid">
        <thead>
          <tr>
            <th class="corner">节次</th>
            <th v-for="(day, index) in days" :key="day.label" :class="{ today: isToday(index) }">
              {{ day.label }}
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
            <td v-for="(groups, dayIndex) in dayGroups" :key="dayIndex" class="cell">
              <div v-for="group in groupsAt(groups, period.number)" :key="`${group.start}-${group.courses[0].name}`" class="course">
                <template v-if="group.start === period.number">
                  <span
                    v-for="course in group.courses"
                    :key="course.name + course.start"
                    class="course-item"
                    :title="`${course.name} ${course.schedule} ${course.location}`"
                  >
                    <strong class="course-name">{{ course.name }}</strong>
                    <span class="course-meta">{{ course.location }}</span>
                  </span>
                </template>
                <span v-else class="course-continued" aria-hidden="true">↳</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="note">
      课表来自教务处系统，与作业共用同一套统一身份认证，登录一次即可。
      数据按周缓存在本设备，切换周次不需要联网。
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

.week-picker select {
  min-height: 44px;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  font: inherit;
  background: #fff;
}

.notice {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  color: var(--muted);
  background: #f8fafc;
  border: 1px solid var(--line);
}

.notice.error {
  color: var(--error);
  background: #fef2f2;
  border-color: #fecaca;
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

.grid-scroll {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  background: #fff;
}

.grid {
  border-collapse: collapse;
  width: 100%;
  min-width: 40rem;
  font-size: 0.75rem;
}

.grid th,
.grid td {
  border: 1px solid var(--line);
  padding: 0.25rem;
  text-align: left;
  vertical-align: top;
}

.grid thead th {
  background: #fff;
  font-weight: 500;
  text-align: center;
  padding: 0.5rem 0.25rem;
}

.grid thead .today {
  color: var(--ink);
  box-shadow: inset 0 -2px 0 var(--ink);
}

.day-date {
  display: block;
  color: var(--muted);
  font-weight: 400;
  font-size: 0.6875rem;
}

.corner {
  width: 4.5rem;
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
  font-size: 0.6875rem;
  white-space: nowrap;
}

.cell {
  height: 3.25rem;
}

.course-item {
  display: grid;
  gap: 0.125rem;
  padding: 0.3rem;
  border-radius: 0.375rem;
  background: #f0f9ff;
  border: 1px solid #bae6fd;
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

.course-continued {
  color: #7dd3fc;
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
</style>
