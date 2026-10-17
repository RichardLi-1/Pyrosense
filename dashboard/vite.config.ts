import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // two pages: the dashboard (index.html) and the landing page (/landing/)
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        landing: fileURLToPath(new URL('./landing/index.html', import.meta.url)),
      },
    },
  },
  server: {
    // Same paths as deploy/nginx.conf: /api/<route> -> backend /<route>, /ws/live as-is
    proxy: {
      '/api': { target: 'http://localhost:8000', rewrite: (p) => p.replace(/^\/api/, '') },
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
})
