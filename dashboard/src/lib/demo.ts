// In-browser stand-in for the Pi(s) + backend: a crew of firefighters exploring an
// unknown building. The map is pieced together only from their simulated 2D LiDAR,
// and VOC is only known where they've walked. Emits the same events as /ws/live
// (plus a `wearer` id), so the dashboard can't tell the difference.
//
//   ?crew=3   number of firefighters (1-4)     ?speed=1   sim speed multiplier
import type { Alert, DataSource, HeatCell, LiveEvent, MapMeta, Summary, TrailPoint, Warning } from './types'
import { CELL_SIZE } from './types'

const RES = 0.05
const ORIGIN: [number, number] = [-4, -2]
const W = 760 // cells: 38 m
const H = 480 // cells: 24 m
const NAV = 4 // nav cell = 4 map cells = 0.2 m
const NW = W / NAV, NH = H / NAV
const LIDAR_M = 8
const SPEED = 0.9 // m/s
const THRESHOLD = 250
const HOLD_S = 5
const COOLDOWN_S = 60
const HISTORY_S = 10
const NAMES = ['A', 'B', 'C', 'D']

// ---- building (metres): outer shell, corridor, 9 rooms, doors as gaps -------------
type Wall = { a: [number, number]; b: [number, number]; doors?: [number, number][] }
const WALLS: Wall[] = [
  { a: [0, 0], b: [32, 0] }, { a: [32, 0], b: [32, 20] }, { a: [32, 20], b: [0, 20] },
  { a: [0, 20], b: [0, 0], doors: [[9, 11]] }, // front entrance
  { a: [0, 8], b: [32, 8], doors: [[2.5, 3.5], [8.5, 9.5], [15, 16], [22, 23], [28.5, 29.5]] },
  { a: [0, 12], b: [32, 12], doors: [[3.5, 4.5], [11.5, 12.5], [19.5, 20.5], [27.5, 28.5]] },
  { a: [6, 0], b: [6, 8] }, { a: [12, 0], b: [12, 8] }, { a: [19, 0], b: [19, 8], doors: [[3, 4]] }, { a: [26, 0], b: [26, 8] },
  { a: [8, 12], b: [8, 20] }, { a: [16, 12], b: [16, 20], doors: [[15, 16]] }, { a: [24, 12], b: [24, 20] },
  // furniture-ish clutter so the map isn't just boxes
  { a: [2, 15], b: [5, 15] }, { a: [10, 16.5], b: [13, 16.5] }, { a: [27, 3], b: [30, 3] }, { a: [14, 4], b: [14, 6.5] },
]
// hidden gas sources (truth): spread geodesically through doorways
const SOURCES = [{ x: 21.5, y: 18, q: 360, L: 2.6 }, { x: 30.5, y: 1.2, q: 230, L: 2.2 }]
const BASE = 42

type Agent = {
  id: string; x: number; y: number; heading: number; roll: number; pitch: number
  path: [number, number][]; target: number | null; replanAt: number; nextVoc: number
  aboveSince: number | null; lastFired: number | null; done: boolean; phase: number; lastVoc: number
}
type Reading = { t: number; x: number; y: number; voc: number; wearer: string }

function buildTruth(): Uint8Array {
  const g = new Uint8Array(W * H)
  const stamp = (x: number, y: number) => {
    const c = Math.floor((x - ORIGIN[0]) / RES), r = Math.floor((y - ORIGIN[1]) / RES)
    for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
      const rr = r + dr, cc = c + dc
      if (rr >= 0 && rr < H && cc >= 0 && cc < W) g[rr * W + cc] = 1
    }
  }
  for (const w of WALLS) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1])
    for (let s = 0; s <= len; s += RES / 2) {
      const f = s / len
      const x = w.a[0] + (w.b[0] - w.a[0]) * f, y = w.a[1] + (w.b[1] - w.a[1]) * f
      const along = w.a[0] === w.b[0] ? y : x
      if (w.doors?.some(([d0, d1]) => along > d0 && along < d1)) continue
      stamp(x, y)
    }
  }
  // a fence around the street so exploration stays near the building
  for (let c = 0; c < W; c++) { g[c] = 1; g[(H - 1) * W + c] = 1 }
  for (let r = 0; r < H; r++) { g[r * W] = 1; g[r * W + W - 1] = 1 }
  return g
}

/** Geodesic gas field on a 0.2 m grid of the true building. */
function buildGas(truth: Uint8Array): Float32Array {
  const pass = new Uint8Array(NW * NH)
  for (let r = 0; r < NH; r++) for (let c = 0; c < NW; c++) {
    let ok = 1
    for (let dr = 0; dr < NAV && ok; dr++) for (let dc = 0; dc < NAV; dc++) if (truth[(r * NAV + dr) * W + c * NAV + dc]) { ok = 0; break }
    pass[r * NW + c] = ok
  }
  const field = new Float32Array(NW * NH).fill(BASE)
  for (const s of SOURCES) {
    const d = new Float32Array(NW * NH).fill(Infinity)
    const start = Math.floor((s.y - ORIGIN[1]) / 0.2) * NW + Math.floor((s.x - ORIGIN[0]) / 0.2)
    d[start] = 0
    const q = [start]
    for (let h = 0; h < q.length; h++) { // BFS is close enough for truth (4-connected, scaled)
      const i = q[h], c = i % NW, r = (i - c) / NW
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc, rr = r + dr
        if (cc < 0 || rr < 0 || cc >= NW || rr >= NH) continue
        const j = rr * NW + cc
        if (!pass[j] || d[j] !== Infinity) continue
        d[j] = d[i] + 0.2 * 0.85 // 4-connected overestimates; scale toward Euclidean
        q.push(j)
      }
    }
    for (let i = 0; i < field.length; i++) if (d[i] < Infinity) field[i] += s.q * Math.exp(-d[i] / s.L)
  }
  return field
}

export function createDemoSource(): DataSource {
  const params = new URLSearchParams(location.search)
  const crew = Math.min(4, Math.max(1, Number(params.get('crew')) || 3))
  const speed = Math.min(8, Math.max(1, Math.round(Number(params.get('speed')) || 1)))

  const truth = buildTruth()
  const gas = buildGas(truth)
  const grid = new Int8Array(W * H).fill(-1) // what the crew has mapped
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(W, H)

  const t0 = Date.now() / 1000 - HISTORY_S
  let t = 0
  let seed = 11
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand())
  const iso = (simT: number) => new Date((t0 + simT) * 1000).toISOString()

  const agents: Agent[] = Array.from({ length: crew }, (_, k) => ({
    id: NAMES[k], x: -2.5, y: 9.4 + k * 0.4, heading: 0, roll: 0, pitch: 0, path: [], target: null,
    replanAt: k * 0.7, nextVoc: k * 0.17, aboveSince: null, lastFired: null, done: false, phase: rand() * 6, lastVoc: BASE,
  }))
  const readings: Reading[] = []
  const alerts: Alert[] = []
  // spoken warnings, like the backend's: the live reading above 100 for 3 s, then at most one per 90 s
  const warnings: Warning[] = []
  let warnAbove: number | null = null, warnLast: number | null = null
  const warnMaybe = (r: Reading) => {
    if (r.voc <= 100) { warnAbove = null; return }
    warnAbove ??= t
    if (t - warnAbove < 3 || (warnLast != null && t - warnLast < 90)) return
    warnLast = t
    const lvl = r.voc >= 400 ? 'hazardous' : r.voc >= 250 ? 'poor' : 'moderate'
    const text = lvl === 'hazardous'
      ? `Hazardous air here, VOC index ${r.voc.toFixed(0)}. Move out of this room and report it.`
      : lvl === 'poor' ? `Air quality is poor here, VOC index ${r.voc.toFixed(0)}. Keep moving and watch for a source nearby.`
      : `Elevated volatile organics here, VOC index ${r.voc.toFixed(0)}. Note the spot and keep scanning.`
    const w: Warning = { id: `demo-w-${warnings.length + 1}`, ts: iso(t), voc: r.voc, unit: 'index', level: lvl, x: r.x, y: r.y,
                         text, source: 'fallback', audio_url: null, voice: 'browser' }
    warnings.unshift(w)
    emit?.({ t: 'warning', ...w })
  }

  let mapVersion = 0
  let emit: ((e: LiveEvent) => void) | null = null

  const vocAt = (x: number, y: number) => {
    const c = Math.floor((x - ORIGIN[0]) / 0.2), r = Math.floor((y - ORIGIN[1]) / 0.2)
    const v = c >= 0 && r >= 0 && c < NW && r < NH ? gas[r * NW + c] : BASE
    return Math.max(5, v * (1 + 0.05 * Math.sin(t / 17)) + gauss() * 6)
  }

  // ---- LiDAR: 720 rays per agent (C1 does ~500/rev), marks free space and the first wall hit
  function scan(a: Agent) {
    const cx = (a.x - ORIGIN[0]) / RES, cy = (a.y - ORIGIN[1]) / RES
    for (let i = 0; i < 720; i++) {
      const ang = (i / 720) * Math.PI * 2
      const dx = Math.cos(ang), dy = Math.sin(ang)
      for (let s = 0; s < LIDAR_M / RES; s += 0.7) {
        const c = Math.floor(cx + dx * s), r = Math.floor(cy + dy * s)
        if (c < 0 || c >= W || r < 0 || r >= H) break
        const k = r * W + c
        if (truth[k]) { grid[k] = 100; break }
        grid[k] = 0
      }
    }
  }

  // ---- navigation on the known map: 0.2 m cells, kept clear of walls
  let nav: Uint8Array = new Uint8Array(NW * NH)
  let frontier: Uint8Array = new Uint8Array(NW * NH)
  let navAt = -1
  function buildNav() {
    if (navAt === t) return
    navAt = t
    const free = new Uint8Array(NW * NH), occ = new Uint8Array(NW * NH), unk = new Uint8Array(NW * NH)
    for (let r = 0; r < NH; r++) for (let c = 0; c < NW; c++) {
      let f = 0, o = 0, u = 0
      for (let dr = 0; dr < NAV; dr++) for (let dc = 0; dc < NAV; dc++) {
        const v = grid[(r * NAV + dr) * W + c * NAV + dc]
        if (v < 0) u++; else if (v >= 65) o++; else f++
      }
      const i = r * NW + c
      free[i] = f === NAV * NAV ? 1 : 0; occ[i] = o ? 1 : 0; unk[i] = u ? 1 : 0
    }
    nav = new Uint8Array(NW * NH)
    frontier = new Uint8Array(NW * NH)
    for (let r = 1; r < NH - 1; r++) for (let c = 1; c < NW - 1; c++) {
      const i = r * NW + c
      if (!free[i]) continue
      let clear = true, nearUnknown = false
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const j = i + dr * NW + dc
        if (occ[j]) clear = false
        if (unk[j]) nearUnknown = true
      }
      if (clear) { nav[i] = 1; if (nearUnknown) frontier[i] = 1 }
    }
  }

  const navCell = (x: number, y: number) =>
    Math.floor((y - ORIGIN[1]) / 0.2) * NW + Math.floor((x - ORIGIN[0]) / 0.2)
  const navXY = (i: number): [number, number] => [ORIGIN[0] + ((i % NW) + 0.5) * 0.2, ORIGIN[1] + (Math.floor(i / NW) + 0.5) * 0.2]

  /** Nearest frontier not claimed by a teammate, by walking distance; path to it. */
  function plan(a: Agent) {
    buildNav()
    const start = navCell(a.x, a.y)
    const prev = new Int32Array(NW * NH).fill(-1)
    const dist = new Float32Array(NW * NH).fill(Infinity)
    dist[start] = 0
    const q = [start]
    const claimed = agents.filter((o) => o !== a && o.target != null).map((o) => navXY(o.target!))
    let best = -1, bestScore = Infinity
    for (let h = 0; h < q.length; h++) {
      const i = q[h]
      if (dist[i] > bestScore) break // BFS order: nothing better remains
      if (frontier[i] && dist[i] > 0.6) {
        const [fx, fy] = navXY(i)
        const crowd = claimed.reduce((s, [cx, cy]) => s + (Math.hypot(fx - cx, fy - cy) < 5 ? 12 : 0), 0)
        if (dist[i] + crowd < bestScore) { bestScore = dist[i] + crowd; best = i }
      }
      const c = i % NW, r = (i - c) / NW
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc, rr = r + dr
        if (cc < 0 || rr < 0 || cc >= NW || rr >= NH) continue
        const j = rr * NW + cc
        if (dist[j] !== Infinity || (!nav[j] && j !== start)) continue
        dist[j] = dist[i] + 0.2; prev[j] = i; q.push(j)
      }
    }
    if (best < 0) { a.target = null; a.path = []; a.done = true; return }
    a.done = false
    a.target = best
    const path: [number, number][] = []
    for (let i = best, k = 0; i !== -1 && i !== start; i = prev[i], k++) if (k % 3 === 0) path.push(navXY(i))
    a.path = path.reverse()
  }

  function moveAgent(a: Agent, dt: number) {
    if (t >= a.replanAt || !a.path.length || (a.target != null && !frontier[a.target])) {
      plan(a)
      a.replanAt = t + 3
    }
    let turn = 0
    if (a.path.length) {
      const [tx, ty] = a.path[0]
      const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy)
      if (d < 0.15) a.path.shift()
      else {
        const step = Math.min(d, SPEED * dt)
        a.x += (dx / d) * step; a.y += (dy / d) * step
        const want = Math.atan2(dy, dx)
        turn = Math.atan2(Math.sin(want - a.heading), Math.cos(want - a.heading))
        a.heading += turn * Math.min(1, dt * 5)
      }
    } else {
      a.heading += 0.4 * dt // idle: slow look around
    }
    a.heading = Math.atan2(Math.sin(a.heading), Math.cos(a.heading))
    // attitude, as an IMU would report it: gait sway, lean into turns, crouch in bad air
    const walking = a.path.length > 0
    const crouch = Math.min(1, Math.max(0, (a.lastVoc - 150) / 250)) * 0.35
    a.roll = (walking ? Math.sin(t * 5.4 + a.phase) * 0.05 : 0) + turn * 0.12
    a.pitch = -(crouch + (walking ? 0.06 + Math.sin(t * 10.8 + a.phase) * 0.02 : 0.02))
  }

  function readVoc(a: Agent) {
    const r: Reading = { t, x: a.x, y: a.y, voc: vocAt(a.x, a.y), wearer: a.id }
    readings.push(r)
    a.lastVoc = r.voc
    emit?.({ t: 'voc', ts: iso(t), voc: r.voc, n_new: 1, x: r.x, y: r.y, wearer: a.id })
    if (a === agents[0]) warnMaybe(r)
    if (r.voc <= THRESHOLD) { a.aboveSince = null; return }
    a.aboveSince ??= t
    if (t - a.aboveSince < HOLD_S || (a.lastFired != null && t - a.lastFired < COOLDOWN_S)) return
    a.lastFired = a.aboveSince = t
    const al: Alert = { id: alerts.length + 1, ts: iso(t), x: r.x, y: r.y, voc: r.voc, threshold: THRESHOLD, wearer: a.id }
    alerts.unshift(al)
    emit?.({ t: 'alert', map_png_url: null, ...al })
  }

  function step(dt: number) {
    t += dt
    for (const a of agents) {
      moveAgent(a, dt)
      scan(a)
      if (t >= a.nextVoc) { a.nextVoc = t + 0.5; readVoc(a) }
    }
  }

  function mapMeta(): MapMeta {
    let free = 0
    for (let i = 0; i < grid.length; i++) if (grid[i] === 0) free++
    return { url: `/demo/map?v=${mapVersion}`, version: mapVersion, origin: ORIGIN, res: RES, w: W, h: H,
             free_area_m2: free * RES * RES, ts: iso(t) }
  }

  function renderMap() {
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

  const poseEvents = (): LiveEvent[] => agents.map((a) => ({
    t: 'pose', ts: iso(t), x: a.x, y: a.y, heading: a.heading, roll: a.roll, pitch: a.pitch, voc: a.lastVoc, wearer: a.id,
  }))
  const until = (ms: number | null) => (ms == null ? t : ms / 1000 - t0)
  // Secondary channels, shaped like the SGP30's: eCO2 tracks the VOC index, raw counts drift slowly with a little noise.
  const sensorFrame = (): LiveEvent => {
    const voc = agents[0].lastVoc ?? 0
    const wob = (f: number, ph: number) => Math.sin(t * f + ph)
    return {
      t: 'sensor', ts: iso(t), voc, unit: 'index',
      eco2: Math.round(400 + voc * 4.2 + 12 * wob(0.37, 1.3) + (Math.random() - 0.5) * 6),
      raw_h2: Math.round(13200 - voc * 9 + 40 * wob(0.11, 0.4) + (Math.random() - 0.5) * 10),
      raw_ethanol: Math.round(18700 - voc * 14 + 55 * wob(0.08, 2.1) + (Math.random() - 0.5) * 12),
      temperature: 22.4 + 0.3 * wob(0.02, 0), humidity: 41 + 1.5 * wob(0.015, 1), warmed_up: t > 20,
    }
  }

  return {
    kind: 'demo',

    connect(onEvent, onStatus) {
      emit = onEvent
      onStatus(true)
      const recent = readings.filter((r) => r.t > t - 60)
      onEvent({ t: 'hello', session: `demo-crew-${crew}`, started: iso(0), threshold: THRESHOLD, unit: 'index', bridge_connected: true,
                n_samples: readings.length, voc_window: recent.map((r) => [t0 + r.t, r.voc]), wearers: agents.map((a) => a.id) })
      onEvent({ t: 'map', ...mapMeta() })
      poseEvents().forEach(onEvent)
      let ticks = 0
      const id = window.setInterval(() => {
        for (let k = 0; k < speed; k++) step(0.1)
        poseEvents().forEach(onEvent)
        if (++ticks % 5 === 0) onEvent(sensorFrame()) // 2 Hz, like the real SGP30 driver
        if (ticks % 10 === 0) { renderMap(); onEvent({ t: 'map', ...mapMeta() }) }
      }, 100)
      return () => { clearInterval(id); emit = null }
    },

    async heatmap(untilMs) {
      const u = until(untilMs), hl = 300
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
        .map<TrailPoint>((r) => ({ ts: iso(r.t), x: r.x, y: r.y, heading: null, voc: r.voc, wearer: r.wearer }))
    },

    async alerts() {
      return alerts.slice()
    },

    async summary(): Promise<Summary> {
      const cells = await this.heatmap(null)
      const top = cells.sort((a, b) => b.mean - a.mean)[0]
      const peak = Math.max(...readings.map((r) => r.voc))
      const at = top ? `(${((top.cx + 0.5) * CELL_SIZE).toFixed(1)}, ${((top.cy + 0.5) * CELL_SIZE).toFixed(1)}) m` : 'n/a'
      return {
        source: 'fallback',
        text: `${crew} firefighters have mapped ${mapMeta().free_area_m2.toFixed(0)} m² so far. VOC was highest around ${at}, ` +
              `peaking at ${peak.toFixed(0)}. Treat striped areas as likely hazardous until someone measures them.`,
      }
    },

    async mapImage() {
      return canvas
    },

    async sessions() {
      const m = mapMeta()
      return [{
        session: `demo-crew-${crew}`, name: 'Simulated walk', notes: null, saved: true, started: iso(0), ended: iso(t),
        n: readings.length, map_png_url: canvas.toDataURL('image/png'), map: { origin: m.origin, res: m.res, w: m.w, h: m.h },
      }]
    },

    async warnings() {
      return { threshold: 100, unit: 'index' as const, voice: 'browser' as const, gemini: false, items: warnings.slice(0, 20) }
    },
  }
}
