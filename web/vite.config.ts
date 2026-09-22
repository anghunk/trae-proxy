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
      '/status': 'http://127.0.0.1:39310',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
