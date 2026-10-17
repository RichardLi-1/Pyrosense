// The real backend, through the /api and /ws proxies (vite.config.ts, deploy/nginx.conf).
import type { Alert, DataSource, HeatCell, LiveEvent, MapMeta, Summary, TrailPoint } from './types'

const api = (path: string) => `/api${path}`

async function json<T>(path: string): Promise<T> {
  const r = await fetch(api(path))
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json() as Promise<T>
}

const iso = (ms: number | null) => (ms == null ? '' : new Date(ms).toISOString())

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

    heatmap: (until) =>
      json<{ cells: HeatCell[] }>(`/heatmap?until=${iso(until)}`).then((r) => r.cells),
    trail: (until) => json<TrailPoint[]>(`/trail?until=${iso(until)}`),
    alerts: () => json<Alert[]>('/alerts'),
    summary: (force) => json<Summary>(`/summary${force ? '?force=true' : ''}`),

    mapImage(meta: MapMeta) {
      return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = api(meta.url)
      })
    },
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
