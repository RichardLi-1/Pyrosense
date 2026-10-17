// All dashboard state in one place: the live event stream, polled heat map,
// trail, alerts, summary, and replay (`until`). Designs only render it.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Alert, DataSource, HeatCell, LiveEvent, MapMeta, Pose, Summary, TrailPoint } from './types'

export type Dashboard = {
  kind: DataSource['kind']
  connected: boolean
  bridge: boolean
  session: string
  started: number | null
  threshold: number
  pose: Pose | null
  voc: number | null
  window: [number, number][] // [ms, voc], last 60 s
  meta: MapMeta | null
  image: CanvasImageSource | null
  alerts: Alert[]
  heat: HeatCell[]
  trail: TrailPoint[] // up to `until` (all of it when live)
  history: TrailPoint[] // whole session, for timelines
  until: number | null // null = live
  summary: Summary | null
  summaryLoading: boolean
}

const WINDOW_MS = 60_000
const MAX_POINTS = 20_000
const cap = <T,>(a: T[]) => (a.length > MAX_POINTS ? a.slice(-MAX_POINTS) : a)

export function useDashboard(source: DataSource) {
  const [s, set] = useState<Dashboard>({
    kind: source.kind, connected: false, bridge: false, session: '', started: null, threshold: 250,
    pose: null, voc: null, window: [], meta: null, image: null, alerts: [], heat: [], trail: [], history: [],
    until: null, summary: null, summaryLoading: false,
  })
  const untilRef = useRef<number | null>(null)
  untilRef.current = s.until

  // live stream
  useEffect(() => {
    let mapBusy = false
    const onEvent = (e: LiveEvent) => {
      switch (e.t) {
        case 'hello':
          set((p) => ({ ...p, session: e.session, started: Date.parse(e.started), threshold: e.threshold,
                        bridge: e.bridge_connected, window: e.voc_window.map(([t, v]) => [t * 1000, v]) }))
          break
        case 'map':
          set((p) => ({ ...p, meta: e }))
          if (mapBusy) break
          mapBusy = true
          source.mapImage(e).then((image) => set((p) => ({ ...p, image })))
            .catch(() => {}).finally(() => { mapBusy = false })
          break
        case 'pose':
          set((p) => ({ ...p, pose: e }))
          break
        case 'voc': {
          const t = Date.parse(e.ts)
          const pt: TrailPoint = { ts: e.ts, x: e.x, y: e.y, heading: null, voc: e.voc }
          set((p) => ({
            ...p, voc: e.voc,
            window: [...p.window.filter(([wt]) => wt > t - WINDOW_MS), [t, e.voc] as [number, number]],
            trail: p.until == null ? cap([...p.trail, pt]) : p.trail,
            history: cap([...p.history, pt]),
          }))
          break
        }
        case 'alert':
          set((p) => ({ ...p, alerts: [e, ...p.alerts] }))
          break
        case 'bridge':
          set((p) => ({ ...p, bridge: e.connected }))
          break
      }
    }
    return source.connect(onEvent, (connected) => set((p) => ({ ...p, connected })))
  }, [source])

  // history for this session
  useEffect(() => {
    if (!s.session) return
    source.alerts().then((alerts) => set((p) => ({ ...p, alerts }))).catch(() => {})
    source.trail(null).then((trail) => set((p) => ({ ...p, trail, history: trail }))).catch(() => {})
  }, [source, s.session])

  // heat map: every 2 s when live; on scrub (debounced) in replay
  useEffect(() => {
    if (!s.session) return
    let cancelled = false
    const load = () => source.heatmap(untilRef.current).then((heat) => { if (!cancelled) set((p) => ({ ...p, heat })) })
      .catch(() => {})
    if (s.until == null) {
      load()
      const id = window.setInterval(load, 2000)
      return () => { cancelled = true; clearInterval(id) }
    }
    const id = window.setTimeout(() => {
      load()
      source.trail(untilRef.current).then((trail) => { if (!cancelled) set((p) => ({ ...p, trail })) }).catch(() => {})
    }, 150)
    return () => { cancelled = true; clearTimeout(id) }
  }, [source, s.session, s.until])

  const setUntil = useCallback((until: number | null) => {
    set((p) => ({ ...p, until }))
    if (until == null) source.trail(null).then((trail) => set((p) => ({ ...p, trail }))).catch(() => {})
  }, [source])

  const loadSummary = useCallback((force = false) => {
    set((p) => ({ ...p, summaryLoading: true }))
    source.summary(force)
      .then((summary) => set((p) => ({ ...p, summary, summaryLoading: false })))
      .catch(() => set((p) => ({ ...p, summaryLoading: false })))
  }, [source])

  // In replay the wearer and reading come from the trail at `until`.
  const replayPoint = s.until != null ? s.trail.at(-1) ?? null : null
  const prev = s.trail.at(-2)
  const replayHeading = replayPoint && prev ? Math.atan2(replayPoint.y - prev.y, replayPoint.x - prev.x) : 0
  const view = {
    ...s,
    pose: replayPoint ? { ...replayPoint, heading: replayHeading } : s.pose,
    voc: replayPoint ? replayPoint.voc : s.voc,
    alerts: s.until != null ? s.alerts.filter((a) => Date.parse(a.ts) <= s.until!) : s.alerts,
  }
  return { s: view, setUntil, loadSummary }
}
