<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { auth } from '../composables/auth.js'
import { classesStore } from '../composables/classes.js'
import { backendUrl } from '../api/client.js'
import { createAgentKey, listAgentKeys, revokeAgentKey } from '../api/agent.js'

const open = ref(false)
const busy = ref(false)
const error = ref('')
const grants = ref([])
const name = ref('我的作业助手')
const range = ref('selected')
const selectedIds = ref([])
const days = ref(30)
const addAssignments = ref(true)
const addSources = ref(true)
const createClasses = ref(false)
const joinClasses = ref(false)
const newKey = ref('')
const copied = ref(false)
const revokeAllArmed = ref(false)
let revision = 0

const baseUrl = computed(() => new URL(backendUrl('/'), location.origin).origin)
const openApiUrl = computed(() => backendUrl('/api/agent/v1/openapi.json'))
const example = computed(() => `curl '${baseUrl.value}/api/agent/v1/classes' -H "Authorization: Bearer $BUPT_WEEK_API_KEY"`)

async function run(operation) {
  if (busy.value) return
  const current = revision
  busy.value = true
  error.value = ''
  try {
    await operation(current)
  } catch (caught) {
    if (current === revision) error.value = caught.message || '操作失败，请稍后重试'
  } finally {
    if (current === revision) busy.value = false
  }
}

async function load(current = revision) {
  const data = await listAgentKeys(auth.sessionIdFor('ucloud'))
  if (current === revision) grants.value = data.grants || []
}

function toggle() {
  open.value = !open.value
  newKey.value = ''
  copied.value = false
  if (open.value) {
    selectedIds.value = classesStore.selectedId.value ? [classesStore.selectedId.value] : []
    run(load)
  }
}

async function generate() {
  newKey.value = ''
  copied.value = false
  await run(async (current) => {
    const scopes = ['classes:read', 'assignments:read', 'sources:read']
    if (addAssignments.value) scopes.push('assignments:create')
    if (addSources.value) scopes.push('sources:create')
    if (range.value === 'all' && createClasses.value) scopes.push('classes:create')
    if (range.value === 'all' && joinClasses.value) scopes.push('classes:join')
    const data = await createAgentKey(auth.sessionIdFor('ucloud'), {
      name: name.value, scopes, classIds: range.value === 'all' ? null : selectedIds.value, days: days.value,
    })
    if (current !== revision) return
    newKey.value = data.key
    await load(current)
  })
}

async function revoke(id) {
  if (id === 'all' && !revokeAllArmed.value) {
    revokeAllArmed.value = true
    return
  }
  revokeAllArmed.value = false
  await run(async (current) => {
    await revokeAgentKey(auth.sessionIdFor('ucloud'), id)
    if (current === revision) newKey.value = ''
    await load(current)
  })
}

async function copyKey() {
  try {
    await navigator.clipboard.writeText(newKey.value)
    copied.value = true
  } catch { error.value = '复制失败，请手动选中密钥复制' }
}

function reset() {
  revision += 1
  open.value = false
  busy.value = false
  newKey.value = ''
  grants.value = []
  error.value = ''
  revokeAllArmed.value = false
}

watch(() => auth.username.value, reset)
watch(() => auth.ucloudReady.value, (ready) => { if (!ready) reset() })
onUnmounted(reset)
</script>

<template>
  <section v-if="auth.ucloudReady.value" class="agent-access">
    <button class="access-toggle" type="button" :aria-expanded="open" @click="toggle">Agent 接入{{ open ? ' · 收起' : '' }}</button>
    <div v-if="open" class="access-body">
      <p class="note">让自己的 Agent 创建班级、录入作业、添加班级资料源。使用独立 Key，无需把学校密码交给 Agent。退出网站后授权仍有效，可在这里撤销。</p>
      <form class="grant-form" @submit.prevent="generate">
        <label class="field">授权名称<input v-model="name" maxlength="40" required :disabled="busy"></label>
        <label class="field">访问范围<select v-model="range" :disabled="busy"><option value="selected">指定班级</option><option value="all">本人当前及以后加入的全部班级</option></select></label>
        <fieldset v-if="range === 'selected'" :disabled="busy">
          <legend>可访问的班级</legend>
          <label v-for="cls in classesStore.classes.value" :key="cls.classId" class="check"><input v-model="selectedIds" type="checkbox" :value="cls.classId">{{ cls.name }}</label>
          <p v-if="!classesStore.classes.value.length" class="note">还没有班级。可选择全部班级范围，开启创建班级权限。</p>
        </fieldset>
        <fieldset :disabled="busy">
          <legend>允许的写入操作（读取默认开启）</legend>
          <label class="check"><input v-model="addAssignments" type="checkbox">录入作业</label>
          <label class="check"><input v-model="addSources" type="checkbox">添加班级资料源</label>
          <template v-if="range === 'all'">
            <label class="check"><input v-model="createClasses" type="checkbox">创建班级</label>
            <label class="check"><input v-model="joinClasses" type="checkbox">凭班级号及班级密码加入班级</label>
          </template>
        </fieldset>
        <label class="field">有效期<select v-model="days" :disabled="busy"><option :value="7">7 天</option><option :value="30">30 天</option><option :value="90">90 天</option></select></label>
        <button class="button-primary" :disabled="busy || !name.trim() || range === 'selected' && !selectedIds.length">{{ busy ? '处理中…' : '生成 Agent Key' }}</button>
      </form>
      <div v-if="newKey" class="key-result" role="status">
        <label class="field">新生成的 Agent Key（只显示这一次）<textarea :value="newKey" readonly rows="3" spellcheck="false" /></label>
        <p class="note">请保存到 Agent 的凭证配置。关闭此面板后将不再显示；丢失后可撤销并重新生成。</p>
        <button class="code-chip" type="button" @click="copyKey">{{ copied ? '已复制' : '复制 Key' }}</button>
      </div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="grant-list">
        <h3>有效授权</h3>
        <p v-if="!grants.length" class="note">暂无有效授权。</p>
        <article v-for="grant in grants" :key="grant.id" class="grant">
          <div><strong>{{ grant.name }}</strong><p class="note">{{ grant.classIds === null ? '全部班级' : `${grant.classIds.length} 个指定班级` }} · {{ new Date(grant.expiresAt).toLocaleDateString('zh-CN') }} 到期</p></div>
          <button class="delete-button" type="button" :disabled="busy" :aria-label="`撤销 ${grant.name}`" @click="revoke(grant.id)">撤销</button>
        </article>
        <button v-if="grants.length" class="delete-button" type="button" :disabled="busy" @click="revoke('all')">{{ revokeAllArmed ? '确认撤销全部授权' : '撤销所有 Agent 授权' }}</button>
      </div>
      <div class="instructions">
        <h3>接入配置</h3>
        <p class="note">后端地址：<code>{{ baseUrl }}</code></p>
        <p><a :href="openApiUrl" target="_blank" rel="noopener noreferrer">打开 OpenAPI 描述 ↗</a></p>
        <p class="note">WSL Ubuntu / Bash 示例：先把 Key 放入 BUPT_WEEK_API_KEY 环境变量，再查询班级。</p>
        <pre>{{ example }}</pre>
        <p class="note">写入接口支持 dryRun 预览；正式写入必须提供 Idempotency-Key，超时后使用原值重试。资料源仅保存到班级，本机仓库列表仍留在浏览器。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.agent-access { border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); min-width: 0; }
.access-toggle { width: 100%; text-align: left; border: 0; color: var(--brand-700); }
.access-body, .grant-form, label, .grant-list, .instructions { display: grid; gap: 0.625rem; min-width: 0; }
.access-body { padding: 0 0.875rem 0.875rem; gap: 1rem; }
.grant-form { max-width: 38rem; }
label, legend { font-size: 0.8125rem; color: var(--ink-soft); }
input:not([type=checkbox]), select, textarea { width: 100%; padding: 0.5rem 0.75rem; font: inherit; font-size: 16px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); min-height: var(--touch); }
fieldset { border: 1px solid var(--line); border-radius: var(--radius-sm); margin: 0; min-width: 0; display: grid; gap: 0.4rem; }
.check { display: flex; align-items: center; gap: 0.5rem; min-height: var(--touch); }
.check input { width: 1.1rem; height: 1.1rem; }
button { min-height: var(--touch); padding: 0.5rem 0.875rem; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); color: var(--brand-700); font: inherit; cursor: pointer; }
button:disabled { opacity: 0.55; cursor: not-allowed; }
.button-primary { justify-self: start; background: var(--button-bg); color: var(--button-ink); }
.key-result { padding: 0.875rem; border: 1px solid var(--brand-500); border-radius: var(--radius-sm); display: grid; gap: 0.625rem; }
.key-result textarea { overflow-wrap: anywhere; font-family: var(--font-mono); }
.grant { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.grant > div { min-width: 0; overflow-wrap: anywhere; }
.grant-list > button { justify-self: start; }
h3, p { margin: 0; }
h3 { font-size: 0.9375rem; }
.note { font-size: 0.8125rem; color: var(--muted); line-height: 1.65; }
.form-error { color: var(--error); font-size: 0.8125rem; }
code { overflow-wrap: anywhere; }
pre { margin: 0; padding: 0.75rem; background: var(--surface-sunken); border-radius: var(--radius-sm); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.75rem; }
a { color: var(--brand-700); font-size: 0.8125rem; }
</style>
