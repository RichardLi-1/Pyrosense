// In-browser stand-in for the Pi + backend, so the dashboard runs with no hardware
// or server (design work, and the demo fallback). Mirrors tools/fake_pi.py and the
// backend's alert rule; emits the same events as /ws/live.
import type { Alert, DataSource, HeatCell, LiveEvent, MapMeta, Summary, TrailPoint } from './types'
import { CELL_SIZE } from './types'

const RES = 0.05
const ORIGIN: [number, number] = [-1, -1]
const W = 360 // cells: 18 m
const H = 240 // cells: 12 m
const HISTORY_S = 150 // pre-simulated so the first frame already has a map and a heat map
const THRESHOLD = 250
const HOLD_S = 5
const COOLDOWN_S = 60

// Floor plan in metres: outer walls + interior walls with door gaps [from, to].
type Wall = { a: [number, number]; b: [number, number]; doors?: [number, number][] }
const WALLS: Wall[] = [
  { a: [0, 0], b: [16, 0] }, { a: [16, 0], b: [16, 10] }, { a: [16, 10], b: [0, 10] }, { a: [0, 10], b: [0, 0] },
  { a: [6, 0], b: [6, 10], doors: [[4, 5.2]] },
  { a: [11, 0], b: [11, 6], doors: [[2, 3.2]] },
  { a: [6, 6], b: [16, 6], doors: [[7, 8.2], [13, 14.2]] },
]
const PATH: [number, number][] = [
  [2, 2], [2, 8.5], [4.6, 8.5], [4.6, 4.6], [7.6, 4.6], [8.6, 2.6], [13.4, 2.6], [13.6, 4.2],
  [13.6, 8], [9, 8.2], [7.6, 7.6], [7.6, 4.6], [4.6, 4.6], [4.6, 2],
]

function buildTruth(): Uint8Array {
  const g = new Uint8Array(W * H)
  for (const w of WALLS) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1])
    for (let s = 0; s <= len; s += RES / 2) {
      const f = s / len
      const x = w.a[0] + (w.b[0] - w.a[0]) * f
      const y = w.a[1] + (w.b[1] - w.a[1]) * f
      const along = w.a[0] === w.b[0] ? y : x
      if (w.doors?.some(([d0, d1]) => along > d0 && along < d1)) continue
      const c = Math.floor((x - ORIGIN[0]) / RES)
      const r = Math.floor((y - ORIGIN[1]) / RES)
      for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
        const rr = r + dr, cc = c + dc
        if (rr >= 0 && rr < H && cc >= 0 && cc < W) g[rr * W + cc] = 1
      }
    }
  }
  return g
}

type Reading = { t: number; x: number; y: number; voc: number }

export function createDemoSource(): DataSource {
  const truth = buildTruth()
  const grid = new Int8Array(W * H).fill(-1)
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(W, H)

  const t0 = Date.now() / 1000 - HISTORY_S // wall-clock seconds at sim time 0
  let t = 0
  let seg = 0, along = 0
  let x = PATH[0][0], y = PATH[0][1], heading = 0
  const readings: Reading[] = []
  const alerts: Alert[] = []
  let aboveSince: number | null = null
  let lastFired: number | null = null
  let mapVersion = 0
  let nextVoc = 0
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand())

  let emit: ((e: LiveEvent) => void) | null = null
  const iso = (simT: number) => new Date((t0 + simT) * 1000).toISOString()

  function spike(simT: number): number {
    // "marker test": uncapped near the sensor at 60 s, 170 s, then every 120 s
    let s = 0
    for (const at of [60, 170, 290, 410, 530, 650, 770, 890]) {
      if (simT >= at) s += 380 * Math.exp(-(simT - at) / 22)
    }
    return s
  }

  function vocAt(px: number, py: number, simT: number): number {
    const src = 300 * Math.exp(-((px - 14.2) ** 2 + (py - 1.6) ** 2) / (2 * 1.3 ** 2))
    const leak = 110 * Math.exp(-((px - 9) ** 2 + (py - 9) ** 2) / (2 * 1.6 ** 2))
    const base = 55 + 15 * Math.sin(simT / 40)
    return Math.max(5, base + src + leak + spike(simT) + gauss() * 5)
  }

  function reveal() {
    const cx = (x - ORIGIN[0]) / RES, cy = (y - ORIGIN[1]) / RES
    for (let i = 0; i < 240; i++) {
      const a = (i / 240) * Math.PI * 2
      const dx = Math.cos(a), dy = Math.sin(a)
      for (let s = 0; s < 6 / RES; s += 0.7) {
        const c = Math.floor(cx + dx * s), r = Math.floor(cy + dy * s)
        if (c < 0 || c >= W || r < 0 || r >= H) break
        const k = r * W + c
        if (truth[k]) { grid[k] = 100; break }
        grid[k] = 0
      }
    }
  }

  function step(dt: number) {
    t += dt
    const a = PATH[seg], b = PATH[(seg + 1) % PATH.length]
    let len = Math.hypot(b[0] - a[0], b[1] - a[1])
    along += 0.75 * dt
    if (along >= len) { along -= len; seg = (seg + 1) % PATH.length }
    const p = PATH[seg], q = PATH[(seg + 1) % PATH.length]
    len = Math.hypot(q[0] - p[0], q[1] - p[1])
    const f = along / len
    x = p[0] + (q[0] - p[0]) * f + gauss() * 0.01
    y = p[1] + (q[1] - p[1]) * f + gauss() * 0.01
    const target = Math.atan2(q[1] - p[1], q[0] - p[0])
    let d = target - heading
    d = Math.atan2(Math.sin(d), Math.cos(d))
    heading += d * Math.min(1, dt * 6)
    reveal()
    if (t >= nextVoc) {
      nextVoc = t + 0.5
      const r = { t, x, y, voc: vocAt(x, y, t) }
      readings.push(r)
      checkAlert(r)
      emit?.({ t: 'voc', ts: iso(t), voc: r.voc, n_new: 1, x, y })
    }
  }

  function checkAlert(r: Reading) {
    if (r.voc <= THRESHOLD) { aboveSince = null; return }
    aboveSince ??= r.t
    if (r.t - aboveSince < HOLD_S) return
    if (lastFired != null && r.t - lastFired < COOLDOWN_S) return
    lastFired = aboveSince = r.t
    const al: Alert = { id: alerts.length + 1, ts: iso(r.t), x: r.x, y: r.y, voc: r.voc, threshold: THRESHOLD }
    alerts.unshift(al)
    emit?.({ t: 'alert', map_png_url: null, ...al })
  }

  function mapMeta(): MapMeta {
    let free = 0
    for (let i = 0; i < grid.length; i++) if (grid[i] === 0) free++
    return { url: `/demo/map?v=${mapVersion}`, version: mapVersion, origin: ORIGIN, res: RES, w: W, h: H,
             free_area_m2: free * RES * RES, ts: iso(t) }
  }

  function renderMap() {
    // Same palette and north-up layout as the backend PNG (row 0 = max y).
    const d = img.data
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const v = grid[r * W + c], o = ((H - 1 - r) * W + c) * 4
      if (v < 0) { d[o + 3] = 0; continue }
      const occ = v >= 65
      d[o] = occ ? 230 : 21; d[o + 1] = occ ? 232 : 26; d[o + 2] = occ ? 236 : 36; d[o + 3] = occ ? 217 : 255
    }
    ctx.putImageData(img, 0, 0)
    mapVersion++
  }

  for (let i = 0; i < HISTORY_S * 10; i++) step(0.1)
  renderMap()

  const pose = (): LiveEvent => ({ t: 'pose', ts: iso(t), x, y, heading, voc: readings.at(-1)?.voc ?? null })
  const until = (ms: number | null) => (ms == null ? t : ms / 1000 - t0)

  return {
    kind: 'demo',

    connect(onEvent, onStatus) {
      emit = onEvent
      onStatus(true)
      const recent = readings.filter((r) => r.t > t - 60)
      onEvent({ t: 'hello', session: 'demo-walk', started: iso(0), threshold: THRESHOLD, bridge_connected: true,
                n_samples: readings.length, voc_window: recent.map((r) => [t0 + r.t, r.voc]) })
      onEvent({ t: 'map', ...mapMeta() })
      onEvent(pose())
      let ticks = 0
      const id = window.setInterval(() => {
        step(0.1)
        onEvent(pose())
        if (++ticks % 10 === 0) { renderMap(); onEvent({ t: 'map', ...mapMeta() }) }
      }, 100)
      return () => { clearInterval(id); emit = null }
    },

    async heatmap(untilMs) {
      const u = until(untilMs), hl = 120
      const cells = new Map<string, { cx: number; cy: number; sw: number; swv: number; swv2: number; n: number }>()
      for (const r of readings) {
        if (r.t > u) break
        const cx = Math.floor(r.x / CELL_SIZE), cy = Math.floor(r.y / CELL_SIZE)
        const k = `${cx},${cy}`
        const w = 0.5 ** ((u - r.t) / hl)
        const c = cells.get(k) ?? { cx, cy, sw: 0, swv: 0, swv2: 0, n: 0 }
        c.sw += w; c.swv += w * r.voc; c.swv2 += w * r.voc * r.voc; c.n++
        cells.set(k, c)
      }
      return [...cells.values()].map<HeatCell>((c) => {
        const mean = c.swv / c.sw
        return { cx: c.cx, cy: c.cy, mean, weight: c.sw, sd: Math.sqrt(Math.max(0, c.swv2 / c.sw - mean * mean)), n: c.n }
      })
    },

    async trail(untilMs) {
      const u = until(untilMs)
      return readings.filter((r) => r.t <= u)
        .map<TrailPoint>((r) => ({ ts: iso(r.t), x: r.x, y: r.y, heading: null, voc: r.voc }))
    },

    async alerts() {
      return alerts.slice()
    },

    async summary(): Promise<Summary> {
      const cells = await this.heatmap(null)
      const top = cells.sort((a, b) => b.mean - a.mean)[0]
      const mean = readings.reduce((s, r) => s + r.voc, 0) / Math.max(1, readings.length)
      const peak = Math.max(...readings.map((r) => r.voc))
      const at = top ? `(${((top.cx + 0.5) * CELL_SIZE).toFixed(1)}, ${((top.cy + 0.5) * CELL_SIZE).toFixed(1)}) m` : 'n/a'
      return {
        source: 'fallback',
        text: `VOC was highest around ${at}, peaking at ${peak.toFixed(0)}. ` +
              `The walk averaged ${mean.toFixed(0)} over ${readings.length} readings. ` +
              `Ventilate that area, then re-walk it to confirm the level drops.`,
      }
    },

    async mapImage() {
      return canvas
    },
  }
}
