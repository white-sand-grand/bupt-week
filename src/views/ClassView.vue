<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { auth } from '../composables/auth.js'
import { classesStore } from '../composables/classes.js'
import { friendlyError } from '../utils/errors.js'

/**
 * 班级视图：创建/加入班级（班级号+密码），班内手动录入作业、共享查看。
 * 数据与状态都在 classesStore；这里只管表单与呈现。
 */

const formError = ref('')
const formBusy = ref(false)

// ── 创建 / 加入 ─────────────────────────────────────────────────────────────
const createOpen = ref(false)
const createName = ref('')
const createPassword = ref('')
const joinOpen = ref(false)
const joinCode = ref('')
const joinPassword = ref('')

async function submitCreate() {
  if (formBusy.value) return
  formBusy.value = true
  formError.value = ''
  try {
    await classesStore.create({ name: createName.value.trim(), password: createPassword.value })
    createName.value = ''
    createPassword.value = ''
    createOpen.value = false
  } catch (caught) {
    formError.value = caught.message || '创建失败，请稍后重试'
  } finally {
    formBusy.value = false
  }
}

async function submitJoin() {
  if (formBusy.value) return
  formBusy.value = true
  formError.value = ''
  try {
    await classesStore.join({ code: joinCode.value.trim().toUpperCase(), password: joinPassword.value })
    joinCode.value = ''
    joinPassword.value = ''
    joinOpen.value = false
  } catch (caught) {
    formError.value = caught.message || '加入失败，请稍后重试'
  } finally {
    formBusy.value = false
  }
}

// ── 录入作业 ────────────────────────────────────────────────────────────────
const addOpen = ref(false)
const addTitle = ref('')
const addSubject = ref('')
const addContent = ref('')
const addDeadline = ref('')
const addBusy = ref(false)
const addError = ref('')

// 已有班级时的「加入 / 创建」折叠面板（空态时表单常驻展开，不走这里）
const moreOpen = ref(false)

async function submitAssignment() {
  if (addBusy.value || !classesStore.selectedId.value) return
  addBusy.value = true
  addError.value = ''
  try {
    await classesStore.addAssignment(classesStore.selectedId.value, {
      title: addTitle.value,
      subject: addSubject.value,
      content: addContent.value,
      deadline: addDeadline.value || undefined,
    })
    addTitle.value = ''
    addSubject.value = ''
    addContent.value = ''
    addDeadline.value = ''
    addOpen.value = false
  } catch (caught) {
    addError.value = caught.message || '录入失败，请稍后重试'
  } finally {
    addBusy.value = false
  }
}

// ── 删除 / 解散 / 复制班级号 ────────────────────────────────────────────────
const deleting = ref('')
const deleteError = ref('')
const copied = ref(false)

// 解散是高危操作：点一次进入确认态（按钮变「确认解散？」），4 秒内再点才执行
const dissolveArm = ref(false)
let dissolveTimer = null

async function dissolveSelected() {
  const classId = classesStore.selectedId.value
  if (!classId) return
  if (!dissolveArm.value) {
    dissolveArm.value = true
    clearTimeout(dissolveTimer)
    dissolveTimer = setTimeout(() => { dissolveArm.value = false }, 4000)
    return
  }
  dissolveArm.value = false
  clearTimeout(dissolveTimer)
  deleteError.value = ''
  try {
    await classesStore.dissolve(classId)
  } catch (caught) {
    deleteError.value = caught.message || '解散失败，请稍后重试'
  }
}

async function removeAssignment(assignment) {
  if (!classesStore.selectedId.value || deleting.value) return
  deleting.value = assignment.id
  deleteError.value = ''
  try {
    await classesStore.removeAssignment(classesStore.selectedId.value, assignment.id)
  } catch (caught) {
    deleteError.value = friendlyError(caught)
  } finally {
    deleting.value = ''
  }
}

async function copyCode() {
  const code = classesStore.selectedClass.value?.code || ''
  if (!code) return
  try {
    await navigator.clipboard.writeText(code)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    // 剪贴板不可用（http/旧内核）：选不中就算了，班级号本来就显示在卡片上
  }
}

/** 月/日 时:分 的紧凑展示；截止空 = 不设截止。 */
function deadlineLabel(assignment) {
  const raw = assignment.deadline
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw || '')) return '不设截止'
  return `${raw.slice(5, 10).replace('-', '/')} ${raw.slice(11, 16)} 截止`
}

const selectedAssignments = computed(() =>
  classesStore.assignmentsByClass.value[classesStore.selectedId.value] ?? [])

function startLoad() {
  if (auth.ucloudReady.value && classesStore.state.value === 'idle') {
    classesStore.load()
  }
}

onMounted(startLoad)
watch(() => auth.ucloudReady.value, startLoad)
</script>

<template>
  <section class="pane">
    <header class="pane-head">
      <h2>班级</h2>
      <span v-if="classesStore.classes.value.length" class="counter">
        {{ classesStore.classes.value.length }} 个班级
      </span>
    </header>

    <div v-if="auth.ucloudReady.value && classesStore.state.value === 'error'" class="notice notice-error" role="alert">
      <span class="notice-text">班级信息获取失败：{{ classesStore.error.value }}</span>
      <button class="notice-action" type="button" @click="classesStore.load()">重试</button>
    </div>

    <p v-else-if="!auth.ucloudReady.value" class="empty">
      登录后可以创建班级、和同学共享作业。未登录也能浏览此页面，只是没有数据。
    </p>
    <p v-else-if="classesStore.state.value === 'loading' && !classesStore.classes.value.length" class="empty">
      正在获取班级…
    </p>

    <!-- 没有班级：创建 / 加入双入口 -->
    <template v-else-if="!classesStore.classes.value.length">
      <p class="empty">
        还没有加入任何班级。创建一个发给同学，或用班级号加入已有的班——
        之后任何人都能录入作业，全班共享。
      </p>

      <div class="entry">
        <button class="entry-toggle" type="button" @click="createOpen = !createOpen">
          {{ createOpen ? '收起' : '创建班级' }}
        </button>
        <form v-if="createOpen" class="entry-form" @submit.prevent="submitCreate">
          <label class="field">
            <span>班级名称</span>
            <input v-model="createName" type="text" placeholder="如：软件 2301 班" maxlength="40" required />
          </label>
          <label class="field">
            <span>班级密码（4-32 位）</span>
            <input v-model="createPassword" type="password" placeholder="同学加入时要填" autocomplete="new-password" required />
          </label>
          <button class="button-primary" type="submit" :disabled="formBusy || !createName || !createPassword">
            {{ formBusy ? '创建中…' : '创建班级' }}
          </button>
        </form>
      </div>

      <div class="entry">
        <button class="entry-toggle" type="button" @click="joinOpen = !joinOpen">
          {{ joinOpen ? '收起' : '加入班级' }}
        </button>
        <form v-if="joinOpen" class="entry-form" @submit.prevent="submitJoin">
          <label class="field">
            <span>班级号（10 位）</span>
            <input v-model="joinCode" type="text" placeholder="如 7XA4K2M9Q3" maxlength="10" autocomplete="off" required />
          </label>
          <label class="field">
            <span>班级密码</span>
            <input v-model="joinPassword" type="password" autocomplete="current-password" required />
          </label>
          <button class="button-primary" type="submit" :disabled="formBusy || !joinCode || !joinPassword">
            {{ formBusy ? '加入中…' : '加入班级' }}
          </button>
        </form>
      </div>

      <p v-if="formError" class="form-error">{{ formError }}</p>
    </template>

    <!-- 已有班级：班级卡 + 录入 + 作业列表 -->
    <template v-else>
      <div v-if="classesStore.classes.value.length > 1" class="class-picker">
        <label class="field">
          <span class="visually-hidden">选择班级</span>
          <select :value="classesStore.selectedId.value" @change="classesStore.select($event.target.value)">
            <option v-for="cls in classesStore.classes.value" :key="cls.classId" :value="cls.classId">
              {{ cls.name }}
            </option>
          </select>
        </label>
      </div>

      <div v-if="classesStore.selectedClass.value" class="class-card">
        <div class="class-title-row">
          <h3>{{ classesStore.selectedClass.value.name }}</h3>
          <span v-if="classesStore.selectedClass.value.createdBy === auth.username.value" class="owner-chip">我创建</span>
        </div>
        <div class="class-meta">
          <button class="code-chip" type="button" :title="'点击复制班级号'" @click="copyCode">
            班级号 {{ classesStore.selectedClass.value.code }}
            <span v-if="copied" class="copied">已复制</span>
          </button>
          <span class="member-count">{{ classesStore.selectedClass.value.memberCount }} 人</span>
          <button
            v-if="classesStore.selectedClass.value.createdBy === auth.username.value"
            class="dissolve-button"
            :class="{ 'dissolve-arm': dissolveArm }"
            type="button"
            @click="dissolveSelected"
          >{{ dissolveArm ? '确认解散？点两次生效' : '解散班级' }}</button>
        </div>
      </div>
      <p v-if="deleteError" class="form-error">{{ deleteError }}</p>

      <!-- 加入一个班之后还可以继续加入/创建：折叠面板常驻 -->
      <div class="entry">
        <button class="entry-toggle" type="button" @click="moreOpen = !moreOpen">
          {{ moreOpen ? '收起' : '加入或创建班级' }}
        </button>
        <template v-if="moreOpen">
          <form class="entry-form" @submit.prevent="submitJoin">
            <p class="form-head">凭班级号加入</p>
            <div class="form-grid">
              <label class="field">
                <span>班级号（10 位）</span>
                <input v-model="joinCode" type="text" placeholder="如 7XA4K2M9Q3" maxlength="10" autocomplete="off" required />
              </label>
              <label class="field">
                <span>班级密码</span>
                <input v-model="joinPassword" type="password" autocomplete="current-password" required />
              </label>
            </div>
            <button class="button-primary" type="submit" :disabled="formBusy || !joinCode || !joinPassword">
              {{ formBusy ? '加入中…' : '加入班级' }}
            </button>
          </form>
          <form class="entry-form" @submit.prevent="submitCreate">
            <p class="form-head">创建新班级</p>
            <div class="form-grid">
              <label class="field">
                <span>班级名称</span>
                <input v-model="createName" type="text" placeholder="如：软件 2301 班" maxlength="40" required />
              </label>
              <label class="field">
                <span>班级密码（4-32 位）</span>
                <input v-model="createPassword" type="password" placeholder="同学加入时要填" autocomplete="new-password" required />
              </label>
            </div>
            <button class="button-primary" type="submit" :disabled="formBusy || !createName || !createPassword">
              {{ formBusy ? '创建中…' : '创建班级' }}
            </button>
          </form>
        </template>
      </div>
      <p v-if="formError" class="form-error">{{ formError }}</p>

      <div class="entry">
        <button class="entry-toggle" type="button" @click="addOpen = !addOpen">
          {{ addOpen ? '收起录入' : '录入作业' }}
        </button>
        <form v-if="addOpen" class="entry-form" @submit.prevent="submitAssignment">
          <label class="field">
            <span>标题（必填）</span>
            <input v-model="addTitle" type="text" maxlength="100" placeholder="如：第三章课后习题" required />
          </label>
          <label class="field">
            <span>科目（必填）</span>
            <input v-model="addSubject" type="text" maxlength="40" placeholder="如：高等数学" required />
          </label>
          <label class="field">
            <span>内容（必填，提交方式可写在这里）</span>
            <textarea v-model="addContent" rows="3" maxlength="2000" placeholder="题目范围、要求、交到哪里……" required></textarea>
          </label>
          <label class="field">
            <span>截止时间（可选）</span>
            <input v-model="addDeadline" type="datetime-local" />
          </label>
          <button class="button-primary" type="submit" :disabled="addBusy || !addTitle || !addSubject || !addContent">
            {{ addBusy ? '录入中…' : '录入到班级' }}
          </button>
          <p v-if="addError" class="form-error">{{ addError }}</p>
        </form>
      </div>

      <p v-if="!selectedAssignments.length" class="empty">
        这个班还没有录入作业。点上面「录入作业」，全班都能看到。
      </p>

      <section v-else class="class-assignments">
        <article
          v-for="assignment in selectedAssignments"
          :key="assignment.id"
          class="assignment-card"
        >
          <div class="assignment-head">
            <strong class="assignment-title">{{ assignment.title }}</strong>
            <span class="subject-chip">{{ assignment.chapter }}</span>
          </div>
          <p class="assignment-content">{{ assignment.content }}</p>
          <div class="assignment-foot">
            <span class="assignment-deadline" :class="{ 'deadline-near': assignment.level === 'danger' || assignment.level === 'overdue' }">
              {{ deadlineLabel(assignment) }}
            </span>
            <span class="assignment-by">录入：{{ assignment.createdBy || '同学' }}</span>
            <button
              v-if="classesStore.canDelete(assignment)"
              class="delete-button"
              type="button"
              :disabled="deleting === assignment.id"
              @click="removeAssignment(assignment)"
            >{{ deleting === assignment.id ? '删除中…' : '删除' }}</button>
          </div>
        </article>
        <p v-if="deleteError" class="form-error">{{ deleteError }}</p>
      </section>

      <p class="note">
        班级作业由同学手动录入共享，不在云邮系统里，没有附件与在线提交入口；
        提交方式写在作业内容里。这些作业同样会出现在「作业」标签页，按班级分组。
      </p>
    </template>
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

/* 折叠入口与表单：复用全站表单语言（16px 输入防 iOS 缩放） */
.entry {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  overflow: hidden;
}

.entry-toggle {
  width: 100%;
  min-height: var(--touch);
  padding: 0.625rem 0.875rem;
  border: none;
  background: none;
  color: var(--brand-700);
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

@media (prefers-color-scheme: dark) {
  .entry-toggle {
    color: var(--brand-500);
  }
}

.entry-form {
  display: grid;
  gap: 0.625rem;
  padding: 0.25rem 0.875rem 0.875rem;
}

.field {
  display: grid;
  gap: 0.25rem;
  font-size: 0.8125rem;
  color: var(--ink-soft);
}

.field input,
.field select,
.field textarea {
  min-height: var(--touch);
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-size: 16px;
  color: var(--ink);
  background: var(--surface);
}

.field textarea {
  resize: vertical;
  min-height: 4.5rem;
}

.button-primary {
  justify-self: start;
  min-height: var(--touch);
  padding: 0.5rem 1.25rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: #fff;
  background: linear-gradient(180deg, var(--brand-600), var(--brand-700));
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}

.button-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.form-error {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--error);
}

.class-picker .field select {
  width: 100%;
}

.class-card {
  display: grid;
  gap: 0.5rem;
  padding: 0.875rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.class-title-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

h3 {
  margin: 0;
  font-size: 1rem;
}

.owner-chip {
  padding: 0.1rem 0.45rem;
  border-radius: var(--radius-pill);
  font-size: 0.6875rem;
  color: var(--brand-700);
  background: var(--brand-050);
  border: 1px solid var(--brand-100);
}

@media (prefers-color-scheme: dark) {
  .owner-chip {
    color: var(--brand-600);
  }
}

.class-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.8125rem;
  color: var(--muted);
}

.member-count {
  margin-right: auto;
}

/* 解散：平时弱化展示；确认态转红提示危险 */
.dissolve-button {
  min-height: var(--touch);
  padding: 0 0.6rem;
  border: none;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.dissolve-button.dissolve-arm {
  color: var(--error);
  font-weight: 500;
}

/* 折叠面板里双表单并排（窄屏自动落成单列） */
.form-head {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--ink);
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.625rem;
}

@media (max-width: 30rem) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}

.code-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: var(--touch);
  padding: 0.25rem 0.75rem;
  border: 1px dashed var(--brand-500);
  border-radius: var(--radius-pill);
  background: none;
  color: var(--brand-700);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  cursor: pointer;
}

@media (prefers-color-scheme: dark) {
  .code-chip {
    color: var(--brand-500);
  }
}

.copied {
  letter-spacing: normal;
  color: var(--ok);
}

.class-assignments {
  display: grid;
  gap: 0.5rem;
}

.assignment-card {
  display: grid;
  gap: 0.375rem;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.assignment-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.assignment-title {
  flex: 1;
  color: var(--ink);
  font-weight: 500;
}

.subject-chip {
  padding: 0.1rem 0.45rem;
  border-radius: var(--radius-pill);
  font-size: 0.6875rem;
  color: var(--muted);
  background: var(--surface-sunken);
  border: 1px solid var(--line-soft);
  white-space: nowrap;
}

.assignment-content {
  margin: 0;
  color: var(--ink-soft);
  font-size: 0.8125rem;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.assignment-foot {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: var(--muted);
  flex-wrap: wrap;
}

.assignment-deadline.deadline-near {
  color: var(--error);
  font-weight: 500;
}

.assignment-by {
  flex: 1;
}

.delete-button {
  min-height: var(--touch);
  padding: 0 0.75rem;
  border: none;
  background: none;
  color: var(--error);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.delete-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
