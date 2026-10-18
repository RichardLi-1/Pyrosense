// A crisp miniature of the real PyroSafe dashboard (Focus design): full-bleed dark map with
// the floor plan centred, thermal ramp heat as crisp bands with contour lines, striped
// predicted areas with "likely source" / "sample next" rings, thin per-firefighter trails,
// hard-hat badges A/B/C; a left column with the big TVOC reading, level, sparkline, attitude,
// exposure rows and crew chips; legend pill, view segment control and a live timeline.
import { clamp, lerp } from './util'

type Pt = [number, number]
type RGB = [number, number, number]
const frac = (v: number) => v - Math.floor(v)
const tri = (v: number) => 1 - Math.abs(frac(v) * 2 - 1)

// ---- scale + thermal ramp (mirrors src/lib/colors.ts, SGP30 ppb) ----------------------
export const BANDS: [number, number, number] = [220, 660, 2200]
export const MAX_PPB = 3000
const STOPS: [number, RGB][] = [
  [0.0, [10, 16, 48]], [0.16, [24, 50, 128]], [0.33, [47, 111, 224]], [0.46, [146, 188, 236]],
  [0.55, [240, 170, 74]], [0.67, [226, 84, 32]], [0.78, [255, 138, 31]], [0.9, [255, 210, 60]], [1.0, [255, 247, 216]],
]
const SEG = [0, 0.33, 0.55, 0.78]
export function rampT(v: number): number {
  const edges = [0, ...BANDS, MAX_PPB], stops = [...SEG, 1]
  if (v <= 0) return 0
  for (let i = 0; i < 4; i++) if (v < edges[i + 1]) return stops[i] + ((v - edges[i]) / (edges[i + 1] - edges[i])) * (stops[i + 1] - stops[i])
  return 1
}
export function rampColor(t: number): RGB {
  const x = clamp(t)
  for (let i = 1; i < STOPS.length; i++) {
    const [b, cb] = STOPS[i], [a, ca] = STOPS[i - 1]
    if (x <= b) { const f = (x - a) / (b - a); return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * f)) as RGB }
  }
  return STOPS[STOPS.length - 1][1]
}
export const rampGradient = () => {
  const parts: string[] = []
  for (let i = 0; i <= 24; i++) parts.push(`rgb(${rampColor(i / 24).join(',')}) ${((i / 24) * 100).toFixed(1)}%`)
  return `linear-gradient(to right, ${parts.join(', ')})`
}
const rgb = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

// ---- plan (100 x 64 units): rooms above and below a hallway ---------------------------
const WALLS: Pt[][] = [
  [[2, 2], [98, 2], [98, 62], [2, 62], [2, 2]],
  [[26, 2], [26, 26]], [[50, 2], [50, 26]], [[74, 2], [74, 26]],
  [[2, 26], [10, 26]], [[16, 26], [36, 26]], [[42, 26], [60, 26]], [[66, 26], [84, 26]], [[90, 26], [98, 26]],
  [[2, 38], [12, 38]], [[18, 38], [30, 38]], [[36, 38], [48, 38]], [[54, 38], [70, 38]], [[76, 38], [98, 38]],
  [[20, 38], [20, 62]], [[40, 38], [40, 62]], [[58, 38], [58, 62]],
]
const UNEXPLORED: Pt[][] = [[[80, 38], [80, 62]]]
const PREDICTED_ROOM = [80, 38, 98, 62] // x0 y0 x1 y1
const SAMPLE_NEXT: Pt = [62, 14]
const SOURCE: Pt = [89, 51]
const CREW = [
  { color: '#ffffff', letter: 'A', r: 2.6, path: [[22, 32], [62, 32], [64, 36], [66, 44], [69, 52]] as Pt[], period: 26 },
  { color: '#7dd3fc', letter: 'B', r: 1.8, path: [[8, 33], [50, 33]] as Pt[], period: 30, pingpong: true },
  { color: '#c4b5fd', letter: 'C', r: 1.8, path: [[10, 31], [48, 31]] as Pt[], period: 34, pingpong: true },
]
const CREW_VALUES = [2410, 640, 180]

function polyPoint(pts: Pt[], u: number): Pt {
  const segLen: number[] = []
  let total = 0
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segLen.push(l); total += l }
  let d = clamp(u) * total
  for (let i = 0; i < segLen.length; i++) {
    if (d <= segLen[i]) { const t = segLen[i] ? d / segLen[i] : 0; return [lerp(pts[i][0], pts[i + 1][0], t), lerp(pts[i][1], pts[i + 1][1], t)] }
    d -= segLen[i]
  }
  return pts[pts.length - 1]
}
function polyPrefix(pts: Pt[], u: number): Pt[] {
  const out: Pt[] = [pts[0]]
  const segLen: number[] = []
  let total = 0
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segLen.push(l); total += l }
  let d = clamp(u) * total
  for (let i = 0; i < segLen.length; i++) {
    if (d <= segLen[i]) { const t = segLen[i] ? d / segLen[i] : 0; out.push([lerp(pts[i][0], pts[i + 1][0], t), lerp(pts[i][1], pts[i + 1][1], t)]); return out }
    out.push(pts[i + 1]); d -= segLen[i]
  }
  return out
}

/** Gas field in ramp space (0..1) at plan coordinates. */
function field(x: number, y: number) {
  const g = (cx: number, cy: number, s: number, a: number) => a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s))
  let f = 0.07
  f += 0.26 * Math.exp(-((y - 32) ** 2) / 50) * (x > 6 && x < 94 ? 1 : 0.4)
  f += g(14, 14, 6, 0.24)
  f += g(SAMPLE_NEXT[0], SAMPLE_NEXT[1], 5, 0.34)
  f += g(69, 50, 7, 0.4)
  f += g(SOURCE[0], SOURCE[1], 4.5, 0.95) + g(SOURCE[0], SOURCE[1], 9, 0.25)
  return f
}

/** Hard-hat badge as in src/map/theme.ts. */
function drawHardHat(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, badge: string, icon: string) {
  ctx.fillStyle = badge
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = icon
  const base = cy + 0.22 * r
  ctx.beginPath(); ctx.arc(cx, base, 0.5 * r, Math.PI, 0); ctx.closePath(); ctx.fill()
  const bw = 0.76 * r, bh = 0.16 * r
  ctx.beginPath(); ctx.roundRect(cx - bw, base - 0.02 * r, bw * 2, bh, bh / 2); ctx.fill()
  ctx.fillStyle = badge
  ctx.fillRect(cx - 0.07 * r, base - 0.5 * r, 0.14 * r, 0.42 * r)
}

export class Mock {
  private root: HTMLElement
  private map: HTMLCanvasElement
  private spark: HTMLCanvasElement
  private voc: HTMLElement
  private level: HTMLElement
  private now: HTMLElement
  private heat: HTMLCanvasElement | null = null
  private lastVoc = ''
  private lastNow = ''

  constructor(root: HTMLElement) {
    this.root = root
    this.map = root.querySelector('#dashMap')!
    this.spark = root.querySelector('#dashSpark')!
    this.voc = root.querySelector('#dashVoc')!
    this.level = root.querySelector('#dashLevel')!
    this.now = root.querySelector('#dashNow')!
    root.querySelector<HTMLElement>('.dash-ramp')!.style.background = rampGradient()
    const lv = rgb(rampColor(rampT(2410)))
    this.level.style.setProperty('--lv', lv)
    root.querySelectorAll<HTMLElement>('.dash-crew span').forEach((chip, i) => {
      chip.style.setProperty('--c', CREW[i].color)
      chip.querySelector('em')!.textContent = String(CREW_VALUES[i])
    })
  }

  /** Position the laptop screen (CSS px) and size the canvases. */
  layout(x: number, y: number, w: number, h: number, dpr: number) {
    const st = this.root.style
    st.left = `${x}px`; st.top = `${y}px`; st.width = `${w}px`; st.height = `${h}px`
    this.root.querySelector<HTMLElement>('#dash')!.style.setProperty('--u', `${w / 100}px`)
    for (const c of [this.map, this.spark]) {
      const r = c.getBoundingClientRect()
      const cw = Math.max(1, Math.round(r.width * dpr)), ch = Math.max(1, Math.round(r.height * dpr))
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch }
    }
    this.heat = null
  }

  update(t: number, reduced: boolean) {
    const tt = reduced ? 3 : t
    this.drawMap(tt)
    this.drawSpark(tt)
    const secs = 32 + Math.floor(tt)
    const nowText = `14:${String(9 + Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
    if (nowText !== this.lastNow) { this.now.textContent = nowText; this.lastNow = nowText }
    const v = String(Math.round(2410 + 9 * Math.sin(Math.floor(tt * 1.4) * 1.7)))
    if (v !== this.lastVoc) { this.voc.textContent = v; this.lastVoc = v }
  }

  /** Plan rect inside the map canvas (device px): to the right of the left column. */
  private planRect(W: number, H: number) {
    const bx = W * 0.3, by = H * 0.12, bw = W * 0.675, bh = H * 0.7
    const s = Math.min(bw / 100, bh / 64)
    return { s, ox: bx + (bw - 100 * s) / 2, oy: by + (bh - 64 * s) / 2 }
  }

  /** Banded thermal field with contour lines, rendered once per layout. */
  private heatImage(pw: number, ph: number) {
    if (this.heat && this.heat.width === pw && this.heat.height === ph) return this.heat
    const c = document.createElement('canvas')
    c.width = pw; c.height = ph
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(pw, ph)
    const N = 12
    const band = new Uint8Array(pw * ph)
    for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) band[j * pw + i] = Math.min(N - 1, Math.floor(clamp(field((i / pw) * 100, (j / ph) * 64)) * N))
    const px = (pw / 100)
    const inPredicted = (x: number, y: number) =>
      (x >= PREDICTED_ROOM[0] && x <= PREDICTED_ROOM[2] && y >= PREDICTED_ROOM[1] && y <= PREDICTED_ROOM[3]) ||
      Math.hypot(x - SAMPLE_NEXT[0], y - SAMPLE_NEXT[1]) < 7
    for (let j = 0; j < ph; j++) {
      for (let i = 0; i < pw; i++) {
        const k = j * pw + i
        const b = band[k]
        const col = rampColor((b + 0.5) / N)
        const contour = (i > 0 && band[k - 1] !== b) || (j > 0 && band[k - pw] !== b)
        const x = (i / pw) * 100, y = (j / ph) * 64
        let a = 0.92
        if (inPredicted(x, y) && Math.floor((i + j) / (3 * px)) % 2 === 0) a = 0.3
        const o = k * 4
        if (contour) { img.data[o] = 230; img.data[o + 1] = 236; img.data[o + 2] = 246; img.data[o + 3] = 150 }
        else { img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = Math.round(a * 255) }
      }
    }
    ctx.putImageData(img, 0, 0)
    this.heat = c
    return c
  }

  private drawMap(t: number) {
    const c = this.map, ctx = c.getContext('2d')
    if (!ctx || c.width < 4) return
    const W = c.width, H = c.height
    ctx.clearRect(0, 0, W, H)
    const { s, ox, oy } = this.planRect(W, H)
    const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'

    // map bounds + thermal field
    ctx.fillStyle = '#0e121a'
    ctx.fillRect(X(0), Y(0), 100 * s, 64 * s)
    ctx.drawImage(this.heatImage(Math.round(100 * s), Math.round(64 * s)), X(0), Y(0), 100 * s, 64 * s)
    ctx.strokeStyle = 'rgba(238,241,246,0.12)'; ctx.lineWidth = 1
    ctx.strokeRect(X(0) + 0.5, Y(0) + 0.5, 100 * s - 1, 64 * s - 1)

    // walls
    ctx.strokeStyle = 'rgba(232,236,244,0.96)'; ctx.lineWidth = Math.max(1.2, s * 0.75)
    for (const w of WALLS) { ctx.beginPath(); ctx.moveTo(X(w[0][0]), Y(w[0][1])); for (const p of w.slice(1)) ctx.lineTo(X(p[0]), Y(p[1])); ctx.stroke() }
    ctx.strokeStyle = 'rgba(232,236,244,0.35)'; ctx.setLineDash([2.2 * s, 2.2 * s])
    for (const w of UNEXPLORED) { ctx.beginPath(); ctx.moveTo(X(w[0][0]), Y(w[0][1])); for (const p of w.slice(1)) ctx.lineTo(X(p[0]), Y(p[1])); ctx.stroke() }
    ctx.setLineDash([])

    // sample-next (dotted teal) and likely-source (dashed red) rings with labels
    const fs = Math.max(6, 1.9 * s)
    ctx.font = `500 ${fs}px Inter, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.strokeStyle = '#5eead4'; ctx.lineWidth = Math.max(1, s * 0.4); ctx.setLineDash([s * 0.6, s * 1.2])
    ctx.beginPath(); ctx.arc(X(SAMPLE_NEXT[0]), Y(SAMPLE_NEXT[1]), 4.2 * s, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath(); ctx.moveTo(X(SAMPLE_NEXT[0]) - 1.2 * s, Y(SAMPLE_NEXT[1])); ctx.lineTo(X(SAMPLE_NEXT[0]) + 1.2 * s, Y(SAMPLE_NEXT[1]))
    ctx.moveTo(X(SAMPLE_NEXT[0]), Y(SAMPLE_NEXT[1]) - 1.2 * s); ctx.lineTo(X(SAMPLE_NEXT[0]), Y(SAMPLE_NEXT[1]) + 1.2 * s); ctx.stroke()
    ctx.fillStyle = '#5eead4'
    ctx.fillText('sample next', X(SAMPLE_NEXT[0]), Y(SAMPLE_NEXT[1]) - 5.6 * s)
    ctx.strokeStyle = '#ff4d5e'; ctx.setLineDash([s * 1.4, s * 1.0])
    ctx.beginPath(); ctx.arc(X(SOURCE[0]), Y(SOURCE[1]), (4.6 + 0.3 * Math.sin(t * 2)) * s, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#ff4d5e'
    ctx.fillText('likely source', X(SOURCE[0]), Y(SOURCE[1]) - 6.6 * s)

    // trails + badges
    CREW.forEach((f, i) => {
      const raw = t / f.period + i * 0.37
      const u = f.pingpong ? tri(raw) : frac(raw)
      const trail = polyPrefix(f.path, u)
      ctx.strokeStyle = f.color; ctx.globalAlpha = 0.5; ctx.lineWidth = Math.max(1, s * 0.3)
      ctx.beginPath(); ctx.moveTo(X(trail[0][0]), Y(trail[0][1])); for (const p of trail.slice(1)) ctx.lineTo(X(p[0]), Y(p[1])); ctx.stroke()
      ctx.globalAlpha = 1
    })
    CREW.forEach((f, i) => {
      const raw = t / f.period + i * 0.37
      const u = f.pingpong ? tri(raw) : frac(raw)
      const [px, py] = polyPoint(f.path, u)
      ctx.fillStyle = 'rgba(255,255,255,0.14)'
      ctx.beginPath(); ctx.arc(X(px), Y(py), f.r * 1.7 * s, 0, Math.PI * 2); ctx.fill()
      drawHardHat(ctx, X(px), Y(py), f.r * s, f.color, '#0b0e14')
      ctx.fillStyle = 'rgba(238,241,246,0.9)'
      ctx.font = `600 ${Math.max(7, 2.4 * s)}px Inter, system-ui, sans-serif`
      ctx.textAlign = 'left'
      ctx.fillText(f.letter, X(px) + (f.r + 1.2) * s, Y(py) + 0.9 * s)
    })
  }

  private drawSpark(t: number) {
    const c = this.spark, ctx = c.getContext('2d')
    if (!ctx || c.width < 4) return
    const W = c.width, H = c.height
    ctx.clearRect(0, 0, W, H)
    const n = 60
    const val = (i: number) => 2410 + 60 * Math.sin((i + t * 1.2) * 0.5) + 40 * Math.sin((i + t) * 1.7) + 25 * Math.sin(i * 3.1)
    const Y = (v: number) => H - 1 - ((v - 2150) / 500) * (H - 2)
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (W - 2) + 1
      if (i === 0) ctx.moveTo(x, Y(val(i)))
      else ctx.lineTo(x, Y(val(i)))
    }
    ctx.strokeStyle = rgb(rampColor(rampT(2410))); ctx.lineWidth = Math.max(1, W / 220); ctx.lineJoin = 'round'
    ctx.stroke()
  }
}
