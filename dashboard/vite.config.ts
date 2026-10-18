import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const BACKEND = process.env.BACKEND ?? 'http://localhost:8000'
const VIA_NGINX = !!process.env.BACKEND

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
    // Hot-reload dev against a backend. Default: uvicorn on localhost:8000 (/api prefix stripped).
    //   BACKEND=http://216.128.184.212 npm run dev   -> the Vultr deployment through its nginx (/api kept)
    proxy: {
      '/api': { target: BACKEND, rewrite: VIA_NGINX ? undefined : (p) => p.replace(/^\/api/, '') },
      '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true },
    },
  },
})
