// All dashboard state in one place: the live event stream (one or more wearers),
// polled heat map, trail, alerts, summary, and replay (`until`). Designs only render it.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Alert, DataSource, HeatCell, LiveEvent, MapMeta, Pose, Sensor, Summary, TrailPoint, VocUnit } from './types'
import { DEFAULT_WEARER } from './types'
import { configureScale } from './colors'

type Wearer = { pose: Pose | null; voc: number | null; window: [number, number][] } // window: [ms, voc], last 60 s

type State = {
  kind: DataSource['kind']
  connected: boolean
  bridge: boolean
  session: string
  started: number | null
  threshold: number
  unit: VocUnit
  sensor: Sensor | null // latest raw frame from the gas sensor
  crew: string[] // wearer ids, in order of appearance
  wearers: Record<string, Wearer>
  selected: string | null
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

/** What designs render: State plus the selected wearer's pose/reading, and every wearer's pose. */
export type Dashboard = State & {
  pose: Pose | null
  voc: number | null
  window: [number, number][]
  poses: { id: string; pose: Pose }[]
}

const WINDOW_MS = 60_000
const MAX_POINTS = 30_000
const cap = <T,>(a: T[]) => (a.length > MAX_POINTS ? a.slice(-MAX_POINTS) : a)
const empty = (): Wearer => ({ pose: null, voc: null, window: [] })

function withWearer(p: State, id: string, f: (w: Wearer) => Wearer): State {
  const crew = p.crew.includes(id) ? p.crew : [...p.crew, id]
  return { ...p, crew, selected: p.selected ?? id, wearers: { ...p.wearers, [id]: f(p.wearers[id] ?? empty()) } }
}

export function useDashboard(source: DataSource) {
  const [s, set] = useState<State>({
    kind: source.kind, connected: false, bridge: false, session: '', started: null, threshold: 2200, unit: 'ppb', sensor: null,
    crew: [], wearers: {}, selected: null, meta: null, image: null, alerts: [], heat: [], trail: [], history: [],
    until: null, summary: null, summaryLoading: false,
  })
  const untilRef = useRef<number | null>(null)
  useEffect(() => { untilRef.current = s.until }, [s.until])

  // live stream
  useEffect(() => {
    let mapBusy = false
    const onEvent = (e: LiveEvent) => {
      switch (e.t) {
        case 'hello': {
          const id = e.wearers?.[0] ?? DEFAULT_WEARER
          configureScale(e.unit)
          set((p) => withWearer({ ...p, session: e.session, started: Date.parse(e.started), threshold: e.threshold,
                                  unit: e.unit ?? 'ppb', sensor: e.sensor ?? p.sensor,
                                  bridge: e.bridge_connected, crew: e.wearers ?? p.crew },
                                id, (w) => ({ ...w, window: e.voc_window.map(([t, v]) => [t * 1000, v]) })))
          break
        }
        case 'map':
          set((p) => ({ ...p, meta: e }))
          if (mapBusy) break
          mapBusy = true
          source.mapImage(e).then((image) => set((p) => ({ ...p, image })))
            .catch(() => {}).finally(() => { mapBusy = false })
          break
        case 'pose':
          set((p) => withWearer(p, e.wearer ?? DEFAULT_WEARER, (w) => ({ ...w, pose: e })))
          break
        case 'voc': {
          const t = Date.parse(e.ts)
          const id = e.wearer ?? DEFAULT_WEARER
          const pt: TrailPoint = { ts: e.ts, x: e.x, y: e.y, heading: null, voc: e.voc, wearer: id }
          set((p) => ({
            ...withWearer(p, id, (w) => ({
              ...w, voc: e.voc, window: [...w.window.filter(([wt]) => wt > t - WINDOW_MS), [t, e.voc] as [number, number]],
            })),
            trail: p.until == null ? cap([...p.trail, pt]) : p.trail,
            history: cap([...p.history, pt]),
          }))
          break
        }
        case 'sensor':
          set((p) => ({ ...p, sensor: e }))
          break
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
    untilRef.current = until
    set((p) => ({ ...p, until }))
    if (until == null) source.trail(null).then((trail) => set((p) => ({ ...p, trail }))).catch(() => {})
  }, [source])

  const loadSummary = useCallback((force = false) => {
    set((p) => ({ ...p, summaryLoading: true }))
    source.summary(force)
      .then((summary) => set((p) => ({ ...p, summary, summaryLoading: false })))
      .catch(() => set((p) => ({ ...p, summaryLoading: false })))
  }, [source])

  const select = useCallback((id: string) => set((p) => ({ ...p, selected: id })), [])

  // Poses: live, or in replay each wearer's last trail point at `until` (heading from the step before).
  const poses: { id: string; pose: Pose }[] = []
  for (const id of s.crew) {
    if (s.until == null) {
      const pose = s.wearers[id]?.pose
      if (pose) poses.push({ id, pose })
      continue
    }
    const mine = s.trail.filter((t) => (t.wearer ?? DEFAULT_WEARER) === id)
    const last = mine.at(-1), prev = mine.at(-2)
    if (last) poses.push({ id, pose: { ...last, heading: prev ? Math.atan2(last.y - prev.y, last.x - prev.x) : 0, wearer: id } })
  }
  const sel = s.selected ?? s.crew[0] ?? DEFAULT_WEARER
  const selPose = poses.find((p) => p.id === sel)?.pose ?? null
  const view: Dashboard = {
    ...s,
    selected: sel,
    poses,
    pose: selPose,
    voc: s.until != null ? selPose?.voc ?? null : s.wearers[sel]?.voc ?? null,
    window: s.wearers[sel]?.window ?? [],
    alerts: s.until != null ? s.alerts.filter((a) => Date.parse(a.ts) <= s.until!) : s.alerts,
  }
  return { s: view, setUntil, loadSummary, select }
}
