<script setup>
import { computed } from 'vue'
import { backendUrl } from '../api/client.js'

const props = defineProps({
  content: { type: String, default: '' },
  description: { type: String, default: '' },
  plain: { type: Boolean, default: false },
})

// 从惰性 template 重建白名单内容，只保留阅读需要的格式和属性。
// 不能直接把上游 HTML 放进页面：事件属性、脚本、表单、样式都不属于作业要求。
const TAGS = new Set('p div span br strong b em i u s del sub sup ul ol li h1 h2 h3 h4 h5 h6 blockquote pre code a img table thead tbody tfoot tr th td hr'.split(' '))
const DROP = new Set('script style iframe object embed svg math form input button textarea select link meta base template noscript'.split(' '))

function safeLink(value) {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

function imageUrl(value) {
  if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(value)) return value
  const url = safeLink(value)
  if (!url) return ''
  const parsed = new URL(url)
  // 学校图片也有防盗链，复用附件的 /file 代理；签名查询原样保留。
  return parsed.hostname === 'fileucloud.bupt.edu.cn' && !parsed.port && !parsed.username && !parsed.password
    ? backendUrl(`/file${parsed.pathname}${parsed.search}`) : ''
}

function richHtml(value) {
  const source = document.createElement('template')
  source.innerHTML = value
  function clean(parent) {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === 3) continue
      if (node.nodeType !== 1 || DROP.has(node.localName)) {
        node.remove()
        continue
      }
      clean(node)
      if (!TAGS.has(node.localName)) {
        node.replaceWith(...node.childNodes)
        continue
      }
      const href = node.localName === 'a' ? safeLink(node.getAttribute('href')) : ''
      const src = node.localName === 'img' ? imageUrl(node.getAttribute('src') || '') : ''
      const alt = node.getAttribute('alt') || ''
      for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name)
      if (href) {
        node.setAttribute('href', href)
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      }
      if (node.localName === 'img') {
        if (!src) {
          node.replaceWith(document.createTextNode(alt))
          continue
        }
        node.setAttribute('src', src)
        node.setAttribute('alt', alt)
        node.setAttribute('loading', 'lazy')
        node.setAttribute('referrerpolicy', 'no-referrer')
      }
    }
  }
  clean(source.content)
  return source.content.textContent.trim() || source.content.querySelector('img, hr') ? source.innerHTML : ''
}

const blocks = computed(() => [...new Set([props.content, props.description].map((value) => value.trim()).filter(Boolean))]
  .map((text) => props.plain || !/<\/?[a-z][\s\S]*>/i.test(text)
    ? { text, html: '' } : { text: '', html: richHtml(text) })
  .filter((block) => block.text || block.html))
</script>

<template>
  <section class="assignment-requirements">
    <h4>作业要求</h4>
    <template v-if="blocks.length">
      <template v-for="(block, index) in blocks" :key="index">
        <div v-if="block.html" class="requirements-body" v-html="block.html"></div>
        <p v-else class="requirements-body requirements-plain">{{ block.text }}</p>
      </template>
    </template>
    <p v-else class="requirements-empty">老师暂未填写文字要求，请查看附件或前往云邮查看。</p>
  </section>
</template>

<style scoped>
.assignment-requirements {
  min-width: 0;
  padding: 0.75rem;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  color: var(--ink-soft);
  font-size: 0.875rem;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

h4 {
  margin: 0 0 0.5rem;
  font-size: 0.8125rem;
  color: var(--ink);
}

.requirements-body {
  min-width: 0;
  overflow-x: auto;
}

.requirements-plain {
  margin: 0;
  white-space: pre-wrap;
}

.requirements-body + .requirements-body {
  margin-top: 0.5rem;
}

.requirements-empty {
  margin: 0;
  color: var(--muted);
  font-size: 0.75rem;
}

.requirements-body :deep(:first-child) {
  margin-top: 0;
}

.requirements-body :deep(:last-child) {
  margin-bottom: 0;
}

.requirements-body :deep(img) {
  max-width: 100%;
  height: auto;
}

.requirements-body :deep(pre) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.requirements-body :deep(a) {
  color: var(--brand-600);
}

.requirements-body :deep(table) {
  border-collapse: collapse;
}

.requirements-body :deep(th),
.requirements-body :deep(td) {
  border: 1px solid var(--line);
  padding: 0.25rem 0.5rem;
}
</style>
