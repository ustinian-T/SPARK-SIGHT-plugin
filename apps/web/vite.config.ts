import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 三端共享 Web UI。桌面端由 Tauri 壳加载本构建产物，插件端在 webview 中复用。
// 本地开发经同源代理连接真实 Agent；VITE_AGENT_BASE 可覆盖代理目标。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_AGENT_BASE || 'http://127.0.0.1:5181',
        changeOrigin: true,
        ws: true,
      },
      // 健康检查与 /api 同源代理到本地 Agent，便于前端门禁直连探测
      '/health': {
        target: process.env.VITE_AGENT_BASE || 'http://127.0.0.1:5181',
        changeOrigin: true,
      }
    }
  },
  preview: {
    port: 5180,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: process.env.VITE_AGENT_BASE || 'http://127.0.0.1:5181',
        changeOrigin: true,
        ws: true
      },
      '/health': {
        target: process.env.VITE_AGENT_BASE || 'http://127.0.0.1:5181',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})
