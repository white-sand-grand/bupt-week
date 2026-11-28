import { createHash } from 'node:crypto'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 构建时把 Content-Security-Policy 注入 index.html。
 *
 * 为什么在插件里注入而不是写死在源码里：
 *   1. 主题预置脚本是内联的，script-src 必须带它的内容 hash——hash 跟着
 *      脚本走，改脚本忘同步 hash 这种事由构建自动消化；
 *   2. 后端来源只在部署构建（deploy.yml 设 VITE_BACKEND_URL）里有，
 *      本地/门禁构建不带，写死会把开发环境搞挂。
 *
 * meta 必须插在内联脚本**之前**：CSP 从解析到它的位置开始生效，
 * 挂在脚本后面等于给前面的脚本豁免。
 */
export function cspPlugin(env = process.env) {
  return {
    name: 'bupt-week-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const inline = /<script>([\s\S]*?)<\/script>/.exec(html)
        let scriptSource = "script-src 'self'"
        if (inline) {
          const hash = createHash('sha256').update(inline[1]).digest('base64')
          scriptSource = `script-src 'self' 'sha256-${hash}'`
        }
        // dev server 的组件样式是运行时 JS 注入的 <style> 标签，必须放行
        // 'unsafe-inline'，否则整个应用的样式全死（实测）。生产构建把 SFC
        // 样式抽成外链文件，保持严格 'self'——进度条等动态样式走 CSSOM。
        const devStyles = ctx?.server ? " 'unsafe-inline'" : ''
        // 后端跨域部署时才有值；同源部署（本机 dev/自托管同域）全部走 'self'
        const backend = String(env.VITE_BACKEND_URL || '').replace(/\/+$/, '')
        const remote = backend ? ` ${backend}` : ''
        const csp = [
          "default-src 'self'",
          scriptSource,
          `style-src 'self'${devStyles}`,
          // favicon 与作业正文里的内嵌图是 data:；学校图片经后端 /file 代理
          `img-src 'self' data:${remote}`,
          `connect-src 'self'${remote}`,
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; ')
        const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
        if (html.includes('<script>')) return html.replace('<script>', `${meta}\n    <script>`)
        return html.replace(/(<head[^>]*>)/, `$1\n    ${meta}`)
      },
    },
  }
}

// 前端部署在 GitHub Pages，资源必须用相对路径，否则子路径部署会 404。
// base 设为 './' 后，自定义域名根路径和 <user>.github.io/<repo>/ 都能正常工作。
export default defineConfig({
  base: './',
  plugins: [vue(), cspPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // 开发时前端与后端同源，由 Vite 转发，不需要配 CORS。
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/file': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
})
