// All dashboard state in one place: the live event stream (one or more wearers),
// polled heat map, trail, alerts, summary, and replay (`until`). Designs only render it.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Alert, DataSource, HeatCell, LiveEvent, MapMeta, Pose, ScanSession, Sensor, Summary, TrailPoint, VocUnit } from './types'
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
  sensorWindow: SensorWindow // last 60 s of each secondary channel, [ms, value]
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
  restarting: boolean // a scan restart was requested and the new map hasn't arrived yet
  notice: string | null // short confirmation shown in the header (saved, restarted, failed)
  review: Review | null // a past scan being looked at instead of the live one
}

/** A past scan loaded for review: its own map, readings and scrub position; live state stays untouched underneath. */
export type Review = {
  scan: ScanSession
  started: number
  ended: number
  meta: MapMeta | null
  image: CanvasImageSource | null
  alerts: Alert[]
  heat: HeatCell[]
  trail: TrailPoint[]
  history: TrailPoint[]
  until: number
  loading: boolean
}
export const scanLabel = (scan: ScanSession) => scan.name || scan.session

/** What designs render: State plus the selected wearer's pose/reading, and every wearer's pose. */
export type Dashboard = State & {
  pose: Pose | null
  voc: number | null
  window: [number, number][]
  poses: { id: string; pose: Pose }[]
  reviewing: ScanSession | null // set while a past scan is shown
}

const WINDOW_MS = 60_000
const MAX_POINTS = 30_000
const cap = <T,>(a: T[]) => (a.length > MAX_POINTS ? a.slice(-MAX_POINTS) : a)
const empty = (): Wearer => ({ pose: null, voc: null, window: [] })

function withWearer(p: State, id: string, f: (w: Wearer) => Wearer): State {
  const crew = p.crew.includes(id) ? p.crew : [...p.crew, id]
  return { ...p, crew, selected: p.selected ?? id, wearers: { ...p.wearers, [id]: f(p.wearers[id] ?? empty()) } }
}

export type SensorField = 'eco2' | 'raw_h2' | 'raw_ethanol'
export type SensorWindow = Record<SensorField, [number, number][]>
const SENSOR_FIELDS: SensorField[] = ['eco2', 'raw_h2', 'raw_ethanol']
const emptySensorWindow = (): SensorWindow => ({ eco2: [], raw_h2: [], raw_ethanol: [] })
/** Append one sensor frame to the per-channel 60 s buffers. */
function pushSensor(w: SensorWindow, e: Sensor): SensorWindow {
  const t = Date.parse(e.ts) || Date.now()
  const out = { ...w }
  for (const f of SENSOR_FIELDS) {
    const v = e[f]
    if (v == null) continue
    out[f] = [...w[f].filter(([wt]) => wt > t - WINDOW_MS), [t, v]]
  }
  return out
}

export function useDashboard(source: DataSource) {
  const [s, set] = useState<State>({
    kind: source.kind, connected: false, bridge: false, session: '', started: null, threshold: 2200, unit: 'ppb', sensor: null, sensorWindow: emptySensorWindow(),
    crew: [], wearers: {}, selected: null, meta: null, image: null, alerts: [], heat: [], trail: [], history: [],
    until: null, summary: null, summaryLoading: false, restarting: false, notice: null, review: null,
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
          set((p) => {
            // a different session id means the scan was restarted: drop everything from the old one
            const fresh = p.session && p.session !== e.session
            const base: State = fresh
              ? { ...p, meta: null, image: null, alerts: [], heat: [], trail: [], history: [], wearers: {}, crew: [], selected: null,
                  sensorWindow: emptySensorWindow(), summary: null, until: null }
              : p
            return withWearer({ ...base, session: e.session, started: Date.parse(e.started), threshold: e.threshold,
                                unit: e.unit ?? 'ppb', sensor: e.sensor ?? base.sensor,
                                bridge: e.bridge_connected, crew: e.wearers ?? base.crew },
                              id, (w) => ({ ...w, window: e.voc_window.map(([t, v]) => [t * 1000, v]) }))
          })
          break
        }
        case 'map':
          set((p) => ({ ...p, meta: e, restarting: false }))
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
          set((p) => ({ ...p, sensor: e, sensorWindow: pushSensor(p.sensorWindow, e) }))
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
    set((p) => {
      if (p.review) return { ...p, review: { ...p.review, until: until ?? p.review.ended } } // a review never goes "live"
      untilRef.current = until
      return { ...p, until }
    })
    if (until == null) source.trail(null).then((trail) => set((p) => (p.review ? p : { ...p, trail }))).catch(() => {})
  }, [source])

  const loadSummary = useCallback((force = false) => {
    set((p) => ({ ...p, summaryLoading: true }))
    source.summary(force)
      .then((summary) => set((p) => ({ ...p, summary, summaryLoading: false })))
      .catch(() => set((p) => ({ ...p, summaryLoading: false })))
  }, [source])

  const select = useCallback((id: string) => set((p) => ({ ...p, selected: id })), [])

  // short header notice, cleared after a few seconds
  const noticeTimer = useRef(0)
  const notify = useCallback((notice: string | null) => {
    clearTimeout(noticeTimer.current)
    set((p) => ({ ...p, notice }))
    if (notice) noticeTimer.current = window.setTimeout(() => set((p) => ({ ...p, notice: null })), 4000)
  }, [])

  /** Save the current scan (map snapshot) under a name. */
  const saveScan = useCallback(async (name?: string, notes?: string) => {
    if (!source.save) return
    try {
      const r = await source.save(name, notes)
      notify(r.saved ? `Saved · ${r.name || r.session}` : 'Nothing to save yet')
      return r
    } catch { notify('Could not save the scan'); return undefined }
  }, [source, notify])

  /** Save the current scan, restart mapping on the device, and open a new session. */
  const restartScan = useCallback(async (name?: string) => {
    if (!source.restart) return
    set((p) => ({ ...p, restarting: true, review: null }))
    try {
      const r = await source.restart(name)
      notify(r.pi.ok ? `New scan ${r.session}` : `New scan ${r.session} · device not reached`)
      return r
    } catch { set((p) => ({ ...p, restarting: false })); notify('Could not restart the scan'); return undefined }
  }, [source, notify])

  const listScans = useCallback(() => (source.sessions ? source.sessions() : Promise.resolve([] as ScanSession[])), [source])

  /** Look at a past scan: its map, readings and alerts, scrubbed to its end. */
  const openReview = useCallback((scan: ScanSession) => {
    const started = Date.parse(scan.started)
    const ended = scan.ended ? Date.parse(scan.ended) : Date.now()
    const meta: MapMeta | null = scan.map && scan.map_png_url
      ? { url: scan.map_png_url, version: 0, origin: scan.map.origin, res: scan.map.res, w: scan.map.w, h: scan.map.h, free_area_m2: 0, ts: scan.ended ?? scan.started }
      : null
    set((p) => ({ ...p, review: { scan, started, ended, meta, image: null, alerts: [], heat: [], trail: [], history: [], until: ended, loading: true } }))
    const id = scan.session
    const still = (p: State) => p.review?.scan.session === id
    if (meta) source.mapImage(meta).then((image) => set((p) => (still(p) ? { ...p, review: { ...p.review!, image } } : p))).catch(() => {})
    Promise.all([source.alerts(id), source.trail(null, id), source.heatmap(ended, id)])
      .then(([alerts, history, heat]) => set((p) => (still(p) ? { ...p, review: { ...p.review!, alerts, history, trail: history, heat, loading: false } } : p)))
      .catch(() => set((p) => (still(p) ? { ...p, review: { ...p.review!, loading: false } } : p)))
  }, [source])

  const closeReview = useCallback(() => set((p) => ({ ...p, review: null })), [])

  // scrubbing inside a review: refetch that scan's heat and trail up to `until`
  const reviewUntil = s.review?.until, reviewId = s.review?.scan.session
  useEffect(() => {
    if (!reviewId || reviewUntil == null) return
    let cancelled = false
    const id = window.setTimeout(() => {
      Promise.all([source.heatmap(reviewUntil, reviewId), source.trail(reviewUntil, reviewId)])
        .then(([heat, trail]) => { if (!cancelled) set((p) => (p.review?.scan.session === reviewId ? { ...p, review: { ...p.review, heat, trail } } : p)) })
        .catch(() => {})
    }, 150)
    return () => { cancelled = true; clearTimeout(id) }
  }, [source, reviewId, reviewUntil])

  // What designs see: the live state, or the reviewed scan laid over it (map, readings, scrub position).
  const R = s.review
  const base: State = R
    ? { ...s, session: R.scan.session, started: R.started, meta: R.meta, image: R.image, alerts: R.alerts, heat: R.heat,
        trail: R.trail, history: R.history, until: R.until, wearers: {}, crew: [...new Set(R.history.map((t) => t.wearer ?? DEFAULT_WEARER))] }
    : s

  // Poses: live, or in replay each wearer's last trail point at `until` (heading from the step before).
  const poses: { id: string; pose: Pose }[] = []
  for (const id of base.crew) {
    if (base.until == null) {
      const pose = base.wearers[id]?.pose
      if (pose) poses.push({ id, pose })
      continue
    }
    const mine = base.trail.filter((t) => (t.wearer ?? DEFAULT_WEARER) === id)
    const last = mine.at(-1), prev = mine.at(-2)
    if (last) poses.push({ id, pose: { ...last, heading: prev ? Math.atan2(last.y - prev.y, last.x - prev.x) : 0, wearer: id } })
  }
  const sel = (base.crew.includes(s.selected ?? '') ? s.selected : null) ?? base.crew[0] ?? DEFAULT_WEARER
  const selPose = poses.find((p) => p.id === sel)?.pose ?? null
  const view: Dashboard = {
    ...base,
    selected: sel,
    poses,
    pose: selPose,
    voc: base.until != null ? selPose?.voc ?? null : base.wearers[sel]?.voc ?? null,
    window: R ? [] : s.wearers[sel]?.window ?? [],
    alerts: base.until != null ? base.alerts.filter((a) => Date.parse(a.ts) <= base.until!) : base.alerts,
    reviewing: R?.scan ?? null,
  }
  const scans = { supported: !!source.sessions, list: listScans, open: openReview, close: closeReview, save: saveScan, restart: restartScan }
  return { s: view, setUntil, loadSummary, select, scans }
}
