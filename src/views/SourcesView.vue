<script setup>
import { onMounted, ref, watch } from 'vue'
import { sourcesStore } from '../composables/sources.js'
import { downloadsStore } from '../composables/downloads.js'
import { githubDownloadPath } from '../api/sources.js'
import { formatBytes } from '../utils/format.js'
import { friendlyError } from '../utils/errors.js'
import { safeExternalUrl } from '../utils/safe-link.js'
import ByrdocsSource from '../components/ByrdocsSource.vue'
import { auth } from '../composables/auth.js'
import { classesStore } from '../composables/classes.js'

const url = ref('')
const busy = ref(false)
const error = ref('')
const sharedClassId = ref('')
const sharedType = ref('github')
const sharedUrl = ref('')
const sharedName = ref('')
const sharedBusy = ref(false)
const sharedFormError = ref('')

async function loadShared() {
  await sourcesStore.loadShared()
  if (!classesStore.classes.value.some((cls) => cls.classId === sharedClassId.value)) sharedClassId.value = classesStore.classes.value[0]?.classId || ''
}

async function addShared() {
  sharedBusy.value = true
  sharedFormError.value = ''
  try {
    await sourcesStore.addShared(sharedClassId.value, { type: sharedType.value, url: sharedUrl.value, name: sharedName.value })
    sharedUrl.value = ''
    sharedName.value = ''
  } catch (caught) { sharedFormError.value = friendlyError(caught) }
  finally { sharedBusy.value = false }
}

async function removeSource(source) {
  try {
    if (source.classId) await sourcesStore.removeShared(source)
    else sourcesStore.remove(source)
  } catch (caught) { sharedFormError.value = friendlyError(caught) }
}

onMounted(() => { if (auth.ucloudReady.value) loadShared() })
watch(() => auth.ucloudReady.value, (ready) => { if (ready) loadShared() })

async function addRepository() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await sourcesStore.add(url.value)
    url.value = ''
  } catch (caught) {
    error.value = friendlyError(caught)
  } finally {
    busy.value = false
  }
}

function downloadId(repository, entry) {
  return `github:${repository.owner}/${repository.repo}:${repository.ref}:${entry.path}`
}

function originalUrl(repository, path) {
  // 外链只放行 http(s)（服务端已校验，这里兜底）：非白名单降级为不可点。
  return safeExternalUrl(`${repository.url}/tree/${encodeURIComponent(repository.ref)}/${path.split('/').map(encodeURIComponent).join('/')}`) || undefined
}

function goBack(repository) {
  const path = sourcesStore.stateFor(repository).path.split('/').slice(0, -1).join('/')
  sourcesStore.openDirectory(repository, path)
}
</script>

<template>
  <section class="pane sources-pane">
    <header class="pane-head">
      <h2>添加源</h2>
      <span class="counter">{{ sourcesStore.allRepositories.value.length }} 个仓库</span>
    </header>

    <form class="source-form" @submit.prevent="addRepository">
      <label for="github-repository">GitHub 仓库地址</label>
      <div class="input-row">
        <input
          id="github-repository"
          v-model="url"
          type="url"
          placeholder="https://github.com/作者/仓库"
          required
          maxlength="512"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :disabled="busy"
          aria-describedby="source-help"
        >
        <button class="button-primary" type="submit" :disabled="busy">{{ busy ? '正在添加…' : '添加仓库' }}</button>
      </div>
      <p id="source-help" class="note">添加老师的公开仓库，展开后进入文件夹，点击文件名下载。仓库地址保存在当前浏览器，无需学校登录。</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <p v-if="sourcesStore.storageError.value" class="error-text" role="status">{{ sourcesStore.storageError.value }}</p>
    </form>

    <section v-if="auth.ucloudReady.value" class="shared-sources source-form">
      <div class="directory-toolbar"><h3>班级资料源</h3><button class="text-button" type="button" :disabled="sourcesStore.sharedState.value === 'loading'" @click="loadShared">刷新班级资料源</button></div>
      <p class="note">班级成员共享，Agent 添加的资料源也显示在这里。本机仓库列表仍只保存在浏览器。</p>
      <p v-if="sourcesStore.sharedError.value" class="error-text" role="alert">{{ sourcesStore.sharedError.value }}</p>
      <form v-if="classesStore.classes.value.length" class="source-form" @submit.prevent="addShared">
        <label>选择班级<select v-model="sharedClassId" aria-label="选择班级" :disabled="sharedBusy" required><option v-for="cls in classesStore.classes.value" :key="cls.classId" :value="cls.classId">{{ cls.name }}</option></select></label>
        <label>资料源类型<select v-model="sharedType" aria-label="资料源类型" :disabled="sharedBusy"><option value="github">公开 GitHub 仓库</option><option value="link">网页链接</option></select></label>
        <label>资料源名称（可选）<input v-model="sharedName" maxlength="100" :disabled="sharedBusy"></label>
        <label>资料源地址<input v-model="sharedUrl" type="url" maxlength="2048" placeholder="https://…" :disabled="sharedBusy" required></label>
        <button class="button-primary" :disabled="sharedBusy || !sharedClassId">{{ sharedBusy ? '正在保存…' : '添加到班级' }}</button>
      </form>
      <p v-else-if="sourcesStore.sharedState.value !== 'loading'" class="note">到「班级」页加入或创建班级后，即可共享资料源。</p>
      <p v-if="sharedFormError" class="error-text" role="alert">{{ sharedFormError }}</p>
      <article v-for="source in sourcesStore.sharedLinks.value" :key="`${source.classId}:${source.id}`" class="shared-link repository-head">
        <div class="repository-label"><a class="text-button" :href="safeExternalUrl(source.url) || undefined" target="_blank" rel="noopener noreferrer">{{ source.name }} ↗</a><p class="note">{{ source.className }} · 网页链接</p></div>
        <button v-if="sourcesStore.canRemove(source)" class="text-button" type="button" :aria-label="`移除 ${source.name}`" @click="removeSource(source)">移除</button>
      </article>
    </section>

    <p v-if="!sourcesStore.allRepositories.value.length" class="empty">还没有添加仓库。粘贴一个 GitHub 仓库首页地址即可开始。</p>

    <article v-for="repository in sourcesStore.allRepositories.value" :key="`${repository.classId || 'local'}:${repository.url}`" class="repository">
      <header class="repository-head">
        <button
          class="repository-toggle"
          type="button"
          :aria-expanded="sourcesStore.stateFor(repository).open"
          @click="sourcesStore.toggle(repository)"
        >
          <span class="chevron" aria-hidden="true">{{ sourcesStore.stateFor(repository).open ? '▾' : '▸' }}</span>
          <span class="repository-label">
            <strong>{{ repository.owner }}/{{ repository.repo }}</strong>
            <span class="repository-url">{{ repository.url }}</span>
            <span v-if="repository.classId" class="repository-url">{{ repository.className }} · 班级共享</span>
          </span>
        </button>
        <button v-if="sourcesStore.canRemove(repository)" class="text-button remove-button" type="button" :aria-label="`移除 ${repository.owner}/${repository.repo}`" @click="removeSource(repository)">移除</button>
      </header>

      <div v-if="sourcesStore.stateFor(repository).open" class="repository-body">
        <div class="directory-toolbar">
          <button class="text-button" type="button" :disabled="!sourcesStore.stateFor(repository).path" @click="goBack(repository)">← 返回上级</button>
          <span class="branch">{{ repository.ref }}</span>
          <button class="text-button" type="button" :disabled="sourcesStore.stateFor(repository).state === 'loading'" @click="sourcesStore.openDirectory(repository, sourcesStore.stateFor(repository).path, true)">刷新</button>
          <a class="text-button" :href="originalUrl(repository, sourcesStore.stateFor(repository).path)" target="_blank" rel="noopener noreferrer">在 GitHub 打开 ↗</a>
        </div>
        <p class="directory-path" aria-label="当前目录">/ {{ sourcesStore.stateFor(repository).path || '仓库根目录' }}</p>

        <p v-if="sourcesStore.stateFor(repository).state === 'loading'" class="empty" role="status">正在获取文件…</p>
        <div v-else-if="sourcesStore.stateFor(repository).state === 'error'" class="notice-error" role="alert">
          <span>{{ sourcesStore.stateFor(repository).error }}</span>
          <button class="text-button" type="button" @click="sourcesStore.openDirectory(repository, sourcesStore.stateFor(repository).path, true)">重试</button>
        </div>
        <template v-else-if="sourcesStore.stateFor(repository).state === 'done'">
          <p v-if="!sourcesStore.stateFor(repository).entries.length" class="empty">这个文件夹是空的。</p>
          <ul v-else class="file-list">
            <li v-for="entry in sourcesStore.stateFor(repository).entries" :key="entry.path" class="file-row">
              <button v-if="entry.type === 'dir'" class="entry-button folder-button" type="button" @click="sourcesStore.openDirectory(repository, entry.path)">
                <span class="entry-kind" aria-hidden="true">目录</span>
                <span>{{ entry.name }}</span>
                <span class="entry-arrow" aria-hidden="true">→</span>
              </button>
              <template v-else-if="entry.type === 'file'">
                <button
                  class="entry-button"
                  type="button"
                  :disabled="downloadsStore.isBusy(downloadId(repository, entry))"
                  @click="downloadsStore.start(downloadId(repository, entry), entry.name, githubDownloadPath(repository, entry.path))"
                >
                  <span class="entry-kind" aria-hidden="true">下载</span>
                  <span>{{ entry.name }}</span>
                  <span class="file-size">{{ formatBytes(entry.size) }}</span>
                </button>
                <p v-if="downloadsStore.hintFor(downloadId(repository, entry))" class="download-hint" role="status">{{ downloadsStore.hintFor(downloadId(repository, entry)) }}</p>
                <progress v-if="downloadsStore.progressRatioFor(downloadId(repository, entry)) !== null" :value="downloadsStore.progressRatioFor(downloadId(repository, entry))" max="1" :aria-label="`${entry.name} 下载进度`" />
              </template>
              <a v-else class="entry-button" :href="originalUrl(repository, entry.path)" target="_blank" rel="noopener noreferrer">
                <span class="entry-kind">链接</span><span>{{ entry.name }}</span><span class="entry-arrow">↗</span>
              </a>
            </li>
          </ul>
          <p v-if="sourcesStore.stateFor(repository).limited" class="note">此目录达到 GitHub 的 1000 项展示上限，完整内容请在原仓库查看。</p>
        </template>
      </div>
    </article>

    <ByrdocsSource />
  </section>
</template>

<style scoped>
.pane {
  display: grid;
  gap: 1.25rem;
}

.pane-head, .repository-head, .input-row, .directory-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.pane-head {
  justify-content: space-between;
}

h2 {
  margin: 0;
  font-size: 1.25rem;
}

.counter {
  color: var(--muted);
  font-size: 0.8125rem;
}

.source-form {
  display: grid;
  gap: 0.5rem;
}

label {
  font-size: 0.875rem;
  font-weight: 500;
}

input,
select {
  min-width: 0;
  width: 100%;
  min-height: var(--touch);
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface);
}

.button-primary {
  flex-shrink: 0;
  min-height: var(--touch);
  padding: 0.5rem 1rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--button-ink);
  background: var(--button-bg);
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
}

.note {
  margin: 0;
  color: var(--muted);
  font-size: 0.8125rem;
  line-height: 1.7;
}

.error-text {
  margin: 0;
  color: var(--error);
  font-size: 0.8125rem;
}

.empty {
  margin: 0;
  padding: 1.5rem 1rem;
  color: var(--muted);
  font-size: 0.875rem;
  text-align: center;
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
}

.repository {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.repository-head {
  padding: 0.375rem 0.75rem;
}

.repository-toggle {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 0.625rem;
  min-height: var(--touch);
  padding: 0.375rem 0;
  background: none;
  border: 0;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.chevron {
  color: var(--muted);
}

.repository-label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.repository-label strong {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
}

.repository-url {
  display: block;
  color: var(--muted);
  font-size: 0.75rem;
}

.text-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--touch);
  padding: 0.25rem 0.5rem;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--brand-600);
  background: none;
  font: inherit;
  font-size: 0.8125rem;
  text-decoration: none;
  cursor: pointer;
}

.text-button:hover:not(:disabled) {
  text-decoration: underline;
}

.remove-button {
  flex-shrink: 0;
  color: var(--muted);
}

.repository-body {
  border-top: 1px solid var(--line-soft);
  padding: 0.5rem 0.875rem 0.875rem;
}

.directory-toolbar {
  flex-wrap: wrap;
  gap: 0.25rem 0.5rem;
}

.branch {
  flex: 1;
  min-width: 0;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.directory-path {
  margin: 0.25rem 0 0.75rem;
  color: var(--ink-soft);
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}

.file-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.file-row {
  border-bottom: 1px solid var(--line-soft);
}

.file-row:last-child {
  border-bottom: 0;
}

.entry-button {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  min-height: var(--touch);
  padding: 0.5rem 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--brand-600);
  font: inherit;
  font-size: 0.875rem;
  text-align: left;
  text-decoration: none;
  overflow-wrap: anywhere;
  cursor: pointer;
}

.entry-button > span:nth-child(2) {
  min-width: 0;
}

.entry-button:hover:not(:disabled) {
  background: var(--surface-sunken);
}

.folder-button {
  color: var(--ink);
}

.entry-kind {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 0.6875rem;
}

.file-size, .entry-arrow {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--muted);
  font-size: 0.75rem;
}

.download-hint {
  margin: 0 0 0.5rem;
  color: var(--muted);
  font-size: 0.75rem;
}

progress {
  display: block;
  width: 100%;
  height: 4px;
  margin-bottom: 0.5rem;
  accent-color: var(--brand-500);
}

.notice-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  color: var(--error);
  background: var(--error-bg);
  border: 1px solid var(--error-line);
  border-radius: var(--radius-sm);
  font-size: 0.8125rem;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

@media (max-width: 30rem) {
  .input-row {
    gap: 0.5rem;
  }

  .button-primary {
    padding-inline: 0.75rem;
  }

}
</style>
