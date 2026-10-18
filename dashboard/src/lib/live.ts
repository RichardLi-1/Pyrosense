// The real backend, through the /api and /ws proxies (vite.config.ts, deploy/nginx.conf).
import type { Alert, DataSource, HeatCell, LiveEvent, MapMeta, RestartResult, SaveResult, ScanSession, Summary, TrailPoint } from './types'

const api = (path: string) => `/api${path}`

async function json<T>(path: string): Promise<T> {
  const r = await fetch(api(path))
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json() as Promise<T>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json() as Promise<T>
}

const iso = (ms: number | null) => (ms == null ? '' : new Date(ms).toISOString())
const q = (parts: Record<string, string | undefined>) => {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(parts)) if (v) u.set(k, v)
  const str = u.toString()
  return str ? `?${str}` : ''
}

export function createLiveSource(): DataSource {
  return {
    kind: 'live',

    connect(onEvent, onStatus) {
      let ws: WebSocket | null = null
      let closed = false
      let backoff = 500
      let timer = 0
      const open = () => {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        ws = new WebSocket(`${proto}://${location.host}/ws/live`)
        ws.onopen = () => { backoff = 500; onStatus(true) }
        ws.onmessage = (m) => onEvent(JSON.parse(m.data) as LiveEvent)
        ws.onclose = () => {
          onStatus(false)
          if (!closed) timer = window.setTimeout(open, (backoff = Math.min(backoff * 2, 8000)))
        }
      }
      open()
      return () => { closed = true; clearTimeout(timer); ws?.close() }
    },

    heatmap: (until, session) =>
      json<{ cells: HeatCell[] }>(`/heatmap${q({ until: iso(until), session })}`).then((r) => r.cells),
    trail: (until, session) => json<TrailPoint[]>(`/trail${q({ until: iso(until), session })}`),
    alerts: (session) => json<Alert[]>(`/alerts${q({ session })}`),
    summary: (force) => json<Summary>(`/summary${force ? '?force=true' : ''}`),

    mapImage(meta: MapMeta | { url: string }) {
      return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        // the backend hands out /api-relative urls for the live map and the catalog alike
        img.src = meta.url.startsWith('/api') || /^https?:/.test(meta.url) ? meta.url : api(meta.url)
      })
    },

    sessions: () => json<ScanSession[]>('/sessions'),
    restart: (name) => post<RestartResult>('/session/restart', name ? { name } : {}),
    save: (name, notes) => post<SaveResult>('/session/save', { ...(name ? { name } : {}), ...(notes ? { notes } : {}) }),
  }
}

export async function backendReachable(): Promise<boolean> {
  try {
    const r = await fetch(api('/health'), { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}
