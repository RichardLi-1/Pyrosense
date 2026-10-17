// A small, crisp mock of the real dashboard: floor plan with heat bands, hard-hat badges on
// trails, predicted room (striped) with a likely-source ring, a VOC reading with sparkline,
// and a replay timeline. All drawn procedurally.
import { COLORS, clamp, lerp, smooth } from './util'

type Pt = [number, number]
const frac = (v: number) => v - Math.floor(v)
const tri = (v: number) => 1 - Math.abs(frac(v) * 2 - 1)

function polyPoint(pts: Pt[], u: number): Pt {
  const lens: number[] = []
  let total = 0
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); lens.push(l); total += l }
  let d = clamp(u) * total
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]) { const t = lens[i] ? d / lens[i] : 0; return [lerp(pts[i][0], pts[i + 1][0], t), lerp(pts[i][1], pts[i + 1][1], t)] }
    d -= lens[i]
  }
  return pts[pts.length - 1]
}
function polyPrefix(pts: Pt[], u: number): Pt[] {
  const out: Pt[] = [pts[0]]
  const lens: number[] = []
  let total = 0
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); lens.push(l); total += l }
  let d = clamp(u) * total
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]) { const t = lens[i] ? d / lens[i] : 0; out.push([lerp(pts[i][0], pts[i + 1][0], t), lerp(pts[i][1], pts[i + 1][1], t)]); return out }
    out.push(pts[i + 1]); d -= lens[i]
  }
  return out
}

// plan in a 100 x 64 unit space
const WALLS: Pt[][] = [
  [[4, 6], [96, 6], [96, 58], [4, 58], [4, 6]],
  [[4, 26], [40, 26]], [[52, 26], [96, 26]],
  [[4, 40], [30, 40]], [[42, 40], [96, 40]],
  [[34, 6], [34, 26]], [[66, 6], [66, 26]],
]
const UNEXPLORED: Pt[][] = [[[50, 40], [50, 58]]]
const CREW = [
  { color: COLORS.alert, path: [[46, 16], [56, 11], [61, 19], [52, 22], [42, 18], [46, 16]] as Pt[], period: 14, label: 'FF-1' },
  { color: COLORS.moderate, path: [[12, 33], [88, 33]] as Pt[], period: 18, label: 'FF-2', pingpong: true },
  { color: COLORS.good, path: [[12, 48], [40, 47], [40, 53], [14, 53], [12, 48]] as Pt[], period: 20, label: 'FF-3' },
]

export class Mock {
  private map: HTMLCanvasElement
  private spark: HTMLCanvasElement
  private voc: HTMLElement
  private fill: HTMLElement
  private handle: HTMLElement
  private now: HTMLElement
  private lastVoc = ''
  private lastNow = ''
  private root: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
    this.map = root.querySelector('#dashMap')!
    this.spark = root.querySelector('#dashSpark')!
    this.voc = root.querySelector('#dashVoc')!
    this.fill = root.querySelector('#dashFill')!
    this.handle = root.querySelector('#dashHandle')!
    this.now = root.querySelector('#dashNow')!
  }

  /** Position the laptop screen (CSS px) and size the canvases. */
  layout(x: number, y: number, w: number, h: number, dpr: number) {
    const st = this.root.style
    st.left = `${x}px`; st.top = `${y}px`; st.width = `${w}px`; st.height = `${h}px`
    const dash = this.root.querySelector<HTMLElement>('#dash')!
    dash.style.setProperty('--u', `${w / 100}px`)
    for (const c of [this.map, this.spark]) {
      const r = c.getBoundingClientRect()
      const cw = Math.max(1, Math.round(r.width * dpr)), ch = Math.max(1, Math.round(r.height * dpr))
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch }
    }
  }

  update(t: number, reduced: boolean) {
    const tt = reduced ? 3 : t
    this.drawMap(tt)
    this.drawSpark(tt)
    const u = 0.3 + 0.65 * frac(tt / 40)
    this.fill.style.width = `${(u * 100).toFixed(2)}%`
    this.handle.style.left = `${(u * 100).toFixed(2)}%`
    const mins = 2 + Math.floor(u * 12)
    const nowText = `14:${String(mins).padStart(2, '0')}`
    if (nowText !== this.lastNow) { this.now.textContent = nowText; this.lastNow = nowText }
    const v = String(Math.round(412 + 5 * Math.sin(Math.floor(tt * 1.6) * 1.7)))
    if (v !== this.lastVoc) { this.voc.textContent = v; this.lastVoc = v }
  }

  private drawMap(t: number) {
    const c = this.map, ctx = c.getContext('2d')
    if (!ctx || c.width < 4) return
    const W = c.width, H = c.height
    ctx.clearRect(0, 0, W, H)
    const s = Math.min(W / 104, H / 68)
    const ox = (W - 100 * s) / 2, oy = (H - 64 * s) / 2
    const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'

    // explored rooms
    ctx.fillStyle = 'rgba(238,241,246,0.035)'
    for (const [x, y, w, h] of [[4, 6, 30, 20], [34, 6, 32, 20], [4, 26, 92, 14], [4, 40, 46, 18]]) ctx.fillRect(X(x), Y(y), w * s, h * s)

    // heat bands: crisp steps, clipped to rooms
    const band = (cx: number, cy: number, steps: [number, string, number][], clip: number[]) => {
      ctx.save(); ctx.beginPath(); ctx.rect(X(clip[0]), Y(clip[1]), clip[2] * s, clip[3] * s); ctx.clip()
      for (const [r, col, a] of steps) { ctx.globalAlpha = a; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(cx), Y(cy), r * s, 0, Math.PI * 2); ctx.fill() }
      ctx.restore(); ctx.globalAlpha = 1
    }
    band(51, 16, [[15, COLORS.moderate, 0.2], [10, COLORS.poor, 0.28], [5.5, COLORS.alert, 0.34]], [34, 6, 32, 20])
    band(58, 33, [[8, COLORS.moderate, 0.2], [4, COLORS.poor, 0.22]], [4, 26, 92, 14])
    band(22, 49, [[9, COLORS.good, 0.16]], [4, 40, 46, 18])

    // predicted room: stripes + likely source
    ctx.save(); ctx.beginPath(); ctx.rect(X(66), Y(6), 30 * s, 20 * s); ctx.clip()
    ctx.strokeStyle = COLORS.poor; ctx.globalAlpha = 0.32; ctx.lineWidth = Math.max(1, s * 0.6)
    for (let k = -30; k < 60; k += 3.2) { ctx.beginPath(); ctx.moveTo(X(66 + k), Y(6)); ctx.lineTo(X(66 + k + 20), Y(26)); ctx.stroke() }
    ctx.restore(); ctx.globalAlpha = 1
    ctx.setLineDash([3 * s * 0.5, 2 * s * 0.5])
    ctx.strokeStyle = COLORS.alert; ctx.lineWidth = Math.max(1, s * 0.5)
    ctx.beginPath(); ctx.arc(X(82), Y(15), (6 + 0.6 * Math.sin(t * 2)) * s, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(238,241,246,0.55)'
    ctx.font = `${Math.max(7, 3.2 * s)}px Inter, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText('likely source', X(82), Y(24.5))

    // walls: crisp white; unexplored dim + dashed
    ctx.strokeStyle = 'rgba(238,241,246,0.95)'; ctx.lineWidth = Math.max(1, s * 0.7)
    for (const w of WALLS) { ctx.beginPath(); ctx.moveTo(X(w[0][0]), Y(w[0][1])); for (const p of w.slice(1)) ctx.lineTo(X(p[0]), Y(p[1])); ctx.stroke() }
    ctx.strokeStyle = 'rgba(238,241,246,0.3)'; ctx.setLineDash([2 * s * 0.6, 2 * s * 0.6])
    for (const w of UNEXPLORED) { ctx.beginPath(); ctx.moveTo(X(w[0][0]), Y(w[0][1])); for (const p of w.slice(1)) ctx.lineTo(X(p[0]), Y(p[1])); ctx.stroke() }
    ctx.setLineDash([])

    // crew: trails, badges, alert ring
    CREW.forEach((f, i) => {
      const raw = t / f.period + i * 0.3
      const u = f.pingpong ? tri(raw) : frac(raw)
      const trail = polyPrefix(f.path, u)
      ctx.strokeStyle = f.color; ctx.globalAlpha = 0.45; ctx.lineWidth = Math.max(1, s * 0.5)
      ctx.beginPath(); ctx.moveTo(X(trail[0][0]), Y(trail[0][1])); for (const p of trail.slice(1)) ctx.lineTo(X(p[0]), Y(p[1])); ctx.stroke()
      ctx.globalAlpha = 1
      const [px, py] = polyPoint(f.path, u)
      if (i === 0) {
        const k = frac(t / 1.4)
        ctx.strokeStyle = COLORS.alert; ctx.globalAlpha = (1 - k) * 0.9; ctx.lineWidth = Math.max(1, s * 0.5)
        ctx.beginPath(); ctx.arc(X(px), Y(py), (4 + k * 9) * s, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1
      }
      // hard-hat badge: dark disc, coloured hat
      ctx.fillStyle = '#0d1119'; ctx.beginPath(); ctx.arc(X(px), Y(py), 3.4 * s, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = f.color; ctx.lineWidth = Math.max(1, s * 0.5); ctx.stroke()
      ctx.fillStyle = f.color
      ctx.beginPath(); ctx.arc(X(px), Y(py + 0.4), 1.7 * s, Math.PI, 0); ctx.fill()
      ctx.fillRect(X(px - 2.3), Y(py + 0.3), 4.6 * s, 0.7 * s)
      ctx.fillStyle = 'rgba(238,241,246,0.8)'
      ctx.font = `500 ${Math.max(7, 3 * s)}px "JetBrains Mono", ui-monospace, monospace`
      ctx.textAlign = 'left'
      ctx.fillText(f.label, X(px + 4.6), Y(py + 1.1))
    })
  }

  private drawSpark(t: number) {
    const c = this.spark, ctx = c.getContext('2d')
    if (!ctx || c.width < 4) return
    const W = c.width, H = c.height
    ctx.clearRect(0, 0, W, H)
    const n = 70
    const val = (i: number) => {
      const base = 40 + 10 * Math.sin((i + t * 1.2) * 0.5) + 6 * Math.sin((i + t) * 1.7)
      const rise = smooth((i - 42) / 24)
      return lerp(base, 412 + 5 * Math.sin((i + t * 2) * 0.9), rise)
    }
    const Y = (v: number) => H - 2 - (v / 440) * (H - 4)
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (W - 4) + 2
      if (i === 0) ctx.moveTo(x, Y(val(i)))
      else ctx.lineTo(x, Y(val(i)))
    }
    ctx.strokeStyle = COLORS.alert; ctx.lineWidth = Math.max(1, W / 160); ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.lineTo(W - 2, H); ctx.lineTo(2, H); ctx.closePath()
    ctx.fillStyle = 'rgba(239,35,60,0.12)'; ctx.fill()
    ctx.fillStyle = COLORS.alert
    ctx.beginPath(); ctx.arc(W - 2, Y(val(n - 1)), Math.max(1.5, W / 90), 0, Math.PI * 2); ctx.fill()
  }
}
