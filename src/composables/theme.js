import { readonly, ref } from 'vue'

const KEY = 'bupt-week-theme'
const system = window.matchMedia('(prefers-color-scheme: dark)')
const validTheme = (value) => value === 'light' || value === 'dark'
let preference = null
try {
  const saved = localStorage.getItem(KEY)
  if (validTheme(saved)) preference = saved
} catch {
  // 隐私模式下仍可在当前页面切换。
}

const mode = ref(preference || (system.matches ? 'dark' : 'light'))

function apply(value) {
  mode.value = value
  document.documentElement.dataset.theme = value
  document.querySelector('meta[name="theme-color"]').content = value === 'dark' ? '#121417' : '#f7f5f0'
}

function toggle() {
  preference = mode.value === 'dark' ? 'light' : 'dark'
  apply(preference)
  try { localStorage.setItem(KEY, preference) } catch { /* 当前页面内照常切换 */ }
}

system.addEventListener('change', () => {
  if (!preference) apply(system.matches ? 'dark' : 'light')
})

window.addEventListener('storage', (event) => {
  if (event.key !== KEY && event.key !== null) return
  preference = validTheme(event.newValue) ? event.newValue : null
  apply(preference || (system.matches ? 'dark' : 'light'))
})

apply(mode.value)

export const theme = { mode: readonly(mode), toggle }
