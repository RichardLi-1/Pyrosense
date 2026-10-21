import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// Vite's SPA fallback serves the dashboard for /landing (no slash); send it to /landing/.
const landingSlash: Plugin = {
  name: 'landing-trailing-slash',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const [path, query] = (req.url ?? '').split('?')
      if (path !== '/landing') return next()
      res.statusCode = 301
      res.setHeader('Location', `/landing/${query ? `?${query}` : ''}`)
      res.end()
    })
  },
}

// Every page gets a "TEST BUILD" badge when served from localhost / a LAN address (vite dev, vite preview,
// wrangler dev), so local builds are never mistaken for pyrosense.us.
const testBuildBadge: Plugin = {
  name: 'test-build-badge',
  transformIndexHtml: () => [
    {
      tag: 'script',
      injectTo: 'body',
      children: `(() => {
  const h = location.hostname
  if (!/^(localhost|127\\.|0\\.0\\.0\\.0|\\[::1\\]|10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)|\\.local$/.test(h)) return
  const b = document.createElement('div')
  b.textContent = 'TEST BUILD'
  b.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:2147483647;padding:4px 10px;border-radius:6px;' +
    'background:#facc15;color:#000;font:700 12px/1.4 system-ui,sans-serif;letter-spacing:.08em;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none'
  document.body.appendChild(b)
})()`,
    },
  ],
}

const BACKEND =process.env.BACKEND ?? 'http://localhost:8000'
const VIA_NGINX = !!process.env.BACKEND

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), landingSlash, testBuildBadge],
  build: {
    rollupOptions: {
      // the dashboard (index.html), the landing page (/landing/) and its tech-stack page
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        landing: fileURLToPath(new URL('./landing/index.html', import.meta.url)),
        architecture: fileURLToPath(new URL('./landing/architecture.html', import.meta.url)),
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
