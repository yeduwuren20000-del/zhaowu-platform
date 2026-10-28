import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发模式：Vite 端口 5180，/api 代理到本地 API 8787
// 生产模式：npm run build 产出 web/dist，由 server 直接托管（单端口访问）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
