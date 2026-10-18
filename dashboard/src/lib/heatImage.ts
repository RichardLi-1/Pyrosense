// Render a VOC field as level bands (good / moderate / poor / hazardous): a light fill
// per band plus smooth vector contour lines where the level changes. No blur.
import { SCALE, level, type Level } from './colors'
import type { HeatCell } from './types'
import { CELL_SIZE } from './types'

/** Kernel sums on a regular grid; row 0 = lowest y. `res` metres per grid cell. */
export type Grid = { x0: number; y0: number; res: number; cols: number; rows: number; num: Float32Array; den: Float32Array }
export type HeatImage = { canvas: HTMLCanvasElement; x0: number; y1: number; w: number; h: number }
type Bounds = { x0: number; y0: number; x1: number; y1: number }

export const BAND_RGB: Record<Level, [number, number, number]> = {
  good: [29, 211, 176], moderate: [255, 209, 102], poor: [255, 140, 66], alert: [239, 35, 60],
}
const FILL: Record<Level, number> = { good: 0.05, moderate: 0.1, poor: 0.26, alert: 0.42 }

/** Gaussian-splat the 20 cm cells onto a `res` grid, around the cells or over `bounds` (metres). */
export function kernelGrid(cells: HeatCell[], sigmaM: number, res = 0.05, bounds?: Bounds): Grid | null {
  if (!cells.length) return null
  let b: Bounds
  if (bounds) b = bounds
  else {
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    for (const c of cells) {
      b.x0 = Math.min(b.x0, c.cx * CELL_SIZE); b.x1 = Math.max(b.x1, (c.cx + 1) * CELL_SIZE)
      b.y0 = Math.min(b.y0, c.cy * CELL_SIZE); b.y1 = Math.max(b.y1, (c.cy + 1) * CELL_SIZE)
    }
    const pad = 3 * sigmaM
    b = { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }
  }
  const x0 = Math.floor(b.x0 / res) * res, y0 = Math.floor(b.y0 / res) * res
  const cols = Math.ceil((b.x1 - x0) / res), rows = Math.ceil((b.y1 - y0) / res)
  const num = new Float32Array(cols * rows), den = new Float32Array(cols * rows)
  const s = sigmaM / res, R = Math.ceil(3 * s)
  const k = new Float32Array(2 * R + 1)
  for (let d = -R; d <= R; d++) k[d + R] = Math.exp(-(d * d) / (2 * s * s)) // separable gaussian
  for (const cell of cells) {
    const col = Math.round(((cell.cx + 0.5) * CELL_SIZE - x0) / res - 0.5)
    const row = Math.round(((cell.cy + 0.5) * CELL_SIZE - y0) / res - 0.5)
    const w = Math.min(cell.weight, 3) // cap so one dwelt-on spot doesn't dominate
    for (let dy = -R; dy <= R; dy++) {
      const rr = row + dy
      if (rr < 0 || rr >= rows) continue
      const ky = k[dy + R] * w
      for (let dx = -R; dx <= R; dx++) {
        const cc = col + dx
        if (cc < 0 || cc >= cols) continue
        const kw = ky * k[dx + R]
        num[rr * cols + cc] += kw * cell.mean; den[rr * cols + cc] += kw
      }
    }
  }
  return { x0, y0, res, cols, rows, num, den }
}

/** Estimate at grid cell i: support-gated mean, or shrunk toward `prior` when given. */
type Prior = number | ((i: number) => number)
function estimator(g: Grid, minSupport: number, prior?: Prior, priorWeight = 0.5) {
  if (prior == null) return (i: number) => (g.den[i] < minSupport ? 0 : g.num[i] / g.den[i])
  const at = typeof prior === 'number' ? () => prior : prior
  return (i: number) => (g.num[i] + priorWeight * at(i)) / (g.den[i] + priorWeight)
}

/**
 * Grid -> north-up canvas of band fills, one pixel per grid cell. Drawn where support
 * passes `minSupport`; with `prior`, everywhere, with thin-support cells (predicted)
 * at `predictedAlpha`. Contour lines come from isolines().
 */
export function bandImage(g: Grid, opts: { minSupport?: number; prior?: Prior; priorWeight?: number;
                                            predictedAlpha?: number; alphaScale?: number } = {}): HeatImage {
  const { minSupport = 0.3, prior, priorWeight = 0.5, predictedAlpha = 1, alphaScale = 1 } = opts
  const { cols: W, rows: H } = g
  const est = estimator(g, minSupport, prior, priorWeight)
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(W, H)
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c
    if (prior == null && g.den[i] < minSupport) continue
    const name = level(est(i))
    const thin = prior != null && g.den[i] / (g.den[i] + priorWeight) < 0.5
    const a = Math.min(1, FILL[name] * alphaScale * (thin ? predictedAlpha : 1))
    const o = ((H - 1 - r) * W + c) * 4
    const [cr, cg, cb] = BAND_RGB[name]
    img.data[o] = cr; img.data[o + 1] = cg; img.data[o + 2] = cb; img.data[o + 3] = Math.round(255 * a)
  }
  ctx.putImageData(img, 0, 0)
  return { canvas, x0: g.x0, y1: g.y0 + H * g.res, w: W * g.res, h: H * g.res }
}

export type Isoline = { level: Level; rgb: [number, number, number]; segs: Float32Array } // x1,y1,x2,y2,... metres

// marching squares: corners bl=1 br=2 tr=4 tl=8; edges 0 bottom, 1 right, 2 top, 3 left
const CASES: number[][] = [[], [3, 0], [0, 1], [3, 1], [1, 2], [3, 2, 0, 1], [0, 2], [3, 2], [2, 3], [0, 2],
                           [0, 3, 1, 2], [1, 2], [1, 3], [0, 1], [0, 3], []]

/** Smooth contour lines where the field crosses each level boundary (SCALE.bands). */
export function isolines(g: Grid, opts: { minSupport?: number; prior?: Prior; priorWeight?: number } = {}): Isoline[] {
  const { minSupport = 0.3, prior, priorWeight = 0.5 } = opts
  const { cols: W, rows: H, x0, y0, res } = g
  const est = estimator(g, minSupport, prior, priorWeight)
  const v = new Float32Array(W * H)
  for (let i = 0; i < v.length; i++) v[i] = est(i)
  const measured = (i: number) => prior == null || g.den[i] / (g.den[i] + priorWeight) >= 0.5
  const out: Isoline[] = []
  const [b0, b1, b2] = SCALE.bands
  for (const [t, name] of [[b0, 'moderate'], [b1, 'poor'], [b2, 'alert']] as const) {
    const segs: number[] = []
    for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
      const bl = r * W + c, br = bl + 1, tl = bl + W, tr = tl + 1
      const k = (v[bl] >= t ? 1 : 0) | (v[br] >= t ? 2 : 0) | (v[tr] >= t ? 4 : 0) | (v[tl] >= t ? 8 : 0)
      if (k === 0 || k === 15) continue
      if (!(measured(bl) || measured(br) || measured(tl) || measured(tr))) continue
      const f = (a: number, b: number) => (t - v[a]) / (v[b] - v[a] || 1e-6)
      const X = (cc: number) => x0 + (cc + 0.5) * res, Y = (rr: number) => y0 + (rr + 0.5) * res
      const edge = (e: number): [number, number] =>
        e === 0 ? [X(c + f(bl, br)), Y(r)] : e === 1 ? [X(c + 1), Y(r + f(br, tr))]
          : e === 2 ? [X(c + f(tl, tr)), Y(r + 1)] : [X(c), Y(r + f(bl, tl))]
      const cs = CASES[k]
      for (let j = 0; j < cs.length; j += 2) segs.push(...edge(cs[j]), ...edge(cs[j + 1]))
    }
    if (segs.length) out.push({ level: name, rgb: BAND_RGB[name], segs: Float32Array.from(segs) })
  }
  return out
}

/** Stroke isolines with a world->screen mapping. */
export function strokeIsolines(ctx: CanvasRenderingContext2D, lines: Isoline[], sx: (x: number) => number,
                               sy: (y: number) => number, width: number) {
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  for (const l of lines) {
    ctx.strokeStyle = `rgba(${l.rgb.join(',')},0.95)`
    ctx.beginPath()
    const s = l.segs
    for (let i = 0; i < s.length; i += 4) { ctx.moveTo(sx(s[i]), sy(s[i + 1])); ctx.lineTo(sx(s[i + 2]), sy(s[i + 3])) }
    ctx.stroke()
  }
}
