import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://127.0.0.1:39310',
      '/api': 'http://127.0.0.1:39310',
      '/healthz': 'http://127.0.0.1:39310',
      '/status': {
        target: 'http://127.0.0.1:39310',
        bypass: req => {
          // 开发服务器里的 /status 是管理台页面；只有显式 API 请求才转发到网关。
          const accept = req.headers.accept ?? ''
          return accept.includes('text/html') ? req.url : undefined
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
