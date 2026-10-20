import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 前端部署在 GitHub Pages，资源必须用相对路径，否则子路径部署会 404。
// base 设为 './' 后，自定义域名根路径和 <user>.github.io/<repo>/ 都能正常工作。
export default defineConfig({
  base: './',
  plugins: [vue()],
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
