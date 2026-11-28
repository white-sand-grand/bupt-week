<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '../api/client.js'
import { auth } from '../composables/auth.js'
import { downloadsStore } from '../composables/downloads.js'
import { friendlyError } from '../utils/errors.js'
import { formatBytes } from '../utils/format.js'
import { safeExternalUrl } from '../utils/safe-link.js'

const ready = ref(false)
const checking = ref(false)
const password = ref('')
const connecting = ref(false)
const connectError = ref('')
const keyword = ref('')
const type = ref('test')
const results = ref([])
const searching = ref(false)
const searched = ref(false)
const searchError = ref('')
const sessionId = computed(() => auth.sessionIdFor('ucloud'))
const statusText = computed(() => !sessionId.value ? '登录后可连接下载' : checking.value ? '正在检查连接…' : ready.value ? '已连接，可直接下载' : '尚未连接')
let revision = 0
let controller

function messageFor(error) {
  return error.stage === 'byrdocs-auth' ? error.message : friendlyError(error)
}

async function checkConnection() {
  const current = sessionId.value
  ready.value = false
  if (!current) return
  checking.value = true
  try {
    const data = await api('/api/sources/byrdocs/status', { method: 'POST', body: { sessionId: current } })
    if (sessionId.value === current) ready.value = data.ready
  } catch (error) {
    if (sessionId.value === current) connectError.value = messageFor(error)
  } finally {
    if (sessionId.value === current) checking.value = false
  }
}

async function connect() {
  if (connecting.value || !sessionId.value) return
  const current = sessionId.value
  connecting.value = true
  connectError.value = ''
  try {
    const data = await api('/api/sources/byrdocs/connect', { method: 'POST', body: { sessionId: current, password: password.value } })
    if (sessionId.value === current) ready.value = data.ready
  } catch (error) {
    if (sessionId.value === current) connectError.value = messageFor(error)
  } finally {
    password.value = ''
    connecting.value = false
  }
}

async function search() {
  const current = ++revision
  controller?.abort()
  controller = new AbortController()
  searching.value = true
  searched.value = false
  searchError.value = ''
  results.value = []
  try {
    const data = await api('/api/sources/byrdocs/search', {
      method: 'POST', body: { keyword: keyword.value, type: type.value }, signal: controller.signal,
    })
    if (current !== revision) return
    results.value = data.results
    searched.value = true
  } catch (error) {
    if (current === revision) searchError.value = messageFor(error)
  } finally {
    if (current === revision) searching.value = false
  }
}

function itemId(item) {
  return `byrdocs:${sessionId.value}:${item.key}`
}

async function download(item) {
  if (!ready.value) return
  const id = itemId(item)
  await downloadsStore.start(id, item.filename, '/api/sources/byrdocs/download', {
    sessionId: sessionId.value, key: item.key, filename: item.filename,
  })
  if (downloadsStore.items.value[id]?.phase === 'error') await checkConnection()
}

watch(sessionId, () => {
  password.value = ''
  connectError.value = ''
  checkConnection()
})
onMounted(checkConnection)
onUnmounted(() => { revision += 1; controller?.abort(); password.value = '' })
</script>

<template>
  <section class="byrdocs-source" aria-labelledby="byrdocs-title">
    <header class="byrdocs-head">
      <div><h3 id="byrdocs-title">BYR Docs</h3><p class="note" role="status">{{ statusText }}</p></div>
      <a href="https://byrdocs.org/" target="_blank" rel="noopener noreferrer">进入 byrdocs.org ↗</a>
    </header>
    <p class="note">搜索北邮学习资料与往年试题。学号密码登录时会自动尝试连接，连接后可在这里直接下载 PDF / ZIP。</p>
    <form v-if="sessionId && !ready && !checking" class="byrdocs-form" @submit.prevent="connect">
      <p class="note">当前账号 {{ auth.username.value }}。若尚未连接、连接失效或使用了企微登录，请补填一次统一身份认证密码。密码仅用于本次认证。</p>
      <label for="byrdocs-password">统一身份认证密码</label>
      <div class="input-row">
        <input id="byrdocs-password" v-model="password" type="password" autocomplete="current-password" required :disabled="connecting">
        <button type="submit" :disabled="connecting">{{ connecting ? '正在连接…' : '连接 BYR Docs' }}</button>
      </div>
    </form>
    <p v-if="connectError" class="error-text" role="alert">{{ connectError }}</p>
    <form class="byrdocs-form" @submit.prevent="search">
      <label for="byrdocs-keyword">资料关键词</label>
      <input id="byrdocs-keyword" v-model.trim="keyword" placeholder="例如：概率论" maxlength="100" required>
      <div class="input-row">
        <select v-model="type" aria-label="BYR Docs 资料类型"><option value="test">往年试题</option><option value="doc">学习资料</option><option value="book">书籍</option><option value="all">全部类型</option></select>
        <button type="submit" :disabled="searching">{{ searching ? '正在搜索…' : '搜索资料' }}</button>
      </div>
    </form>
    <p v-if="searchError" class="error-text" role="alert">{{ searchError }}，可以修改关键词重试。</p>
    <p v-if="searched && !results.length" class="note">没有找到可下载的 PDF / ZIP，可以换个关键词，或前往官网查看维基真题。</p>
    <ul v-if="results.length" class="byrdocs-results">
      <li v-for="item in results" :key="item.key">
        <span class="result-title">{{ item.title }}</span>
        <div class="result-actions">
          <span class="note">{{ formatBytes(item.size) }}</span>
          <a :href="safeExternalUrl(item.url) || undefined" target="_blank" rel="noopener noreferrer">官网查看 ↗</a>
          <button type="button" :disabled="!ready || downloadsStore.isBusy(itemId(item))" @click="download(item)">{{ ready ? '下载' : '连接后下载' }}</button>
        </div>
        <p v-if="downloadsStore.hintFor(itemId(item))" class="note" role="status">{{ downloadsStore.hintFor(itemId(item)) }}</p>
        <progress v-if="downloadsStore.progressRatioFor(itemId(item)) !== null" :value="downloadsStore.progressRatioFor(itemId(item))" max="1" :aria-label="`${item.title} 下载进度`" />
      </li>
    </ul>
    <p v-if="results.length" class="note">每次最多展示 30 份文件，更多资料可在官网查找。</p>
  </section>
</template>

<style scoped>
.byrdocs-source {
  display: grid;
  gap: 0.75rem;
  border-top: 1px solid var(--line);
  padding-top: 1rem;
}

.byrdocs-head, .input-row, .result-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.byrdocs-head {
  justify-content: space-between;
}

h3, p {
  margin: 0;
}

h3 {
  font-size: 1rem;
}

.note, label, a, button, select {
  font-size: 0.8125rem;
}

.note {
  color: var(--muted);
  line-height: 1.7;
}

.byrdocs-form {
  display: grid;
  gap: 0.5rem;
}

input, select {
  min-width: 0;
  min-height: var(--touch);
  padding: 0.5rem 0.75rem;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

input {
  width: 100%;
}

.input-row input, select {
  flex: 1;
}

button {
  min-height: var(--touch);
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--brand-600);
  background: var(--surface);
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

a {
  display: inline-flex;
  align-items: center;
  min-height: var(--touch);
  color: var(--brand-600);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

.error-text {
  color: var(--error);
  font-size: 0.8125rem;
}

.byrdocs-results {
  padding: 0;
  margin: 0;
  list-style: none;
}

.byrdocs-results li {
  display: grid;
  gap: 0.25rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--line-soft);
}

.result-title {
  overflow-wrap: anywhere;
  font-size: 0.875rem;
}

.result-actions {
  justify-content: flex-end;
}

.result-actions .note {
  margin-right: auto;
}

progress {
  width: 100%;
  height: 4px;
  accent-color: var(--brand-500);
}

</style>
