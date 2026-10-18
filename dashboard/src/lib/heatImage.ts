// Render a VOC field the way a weather map renders temperature: a continuous thermal
// ramp (cold navy for clean air, white-hot for gas), its opacity following how much
// evidence each spot has, with fine contour hairlines and heavier lines at the
// good / moderate / poor / hazardous thresholds.
import { RAMP_BANDS, SCALE, level, rampColor, rampT, type Level } from './colors'
import type { HeatCell } from './types'
import { CELL_SIZE } from './types'

/** Kernel sums on a regular grid; row 0 = lowest y. `res` metres per grid cell. */
export type Grid = { x0: number; y0: number; res: number; cols: number; rows: number; num: Float32Array; den: Float32Array }
export type HeatImage = { canvas: HTMLCanvasElement; x0: number; y1: number; w: number; h: number }
type Bounds = { x0: number; y0: number; x1: number; y1: number }

/** One representative colour per band (gas-cloud particles, badges). Sampled mid-band on the ramp. */
export const BAND_RGB: Record<Level, [number, number, number]> = {
  good: rampColor(0.3), moderate: rampColor(0.5), poor: rampColor(0.7), alert: rampColor(0.9),
}

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

/**
 * A gridded layer (GP field or forecast horizon) as a Grid for bandImage/isolines, bilinearly
 * upsampled to `res`. den = conf (support), prior = the value itself, so the estimate is the
 * value everywhere and cells with conf < priorWeight render as "predicted".
 */
export function layerGrid(l: { x0: number; y0: number; res: number; cols: number; rows: number }, value: Float32Array,
                          conf: Float32Array | null, res = 0.1): Grid & { prior: (i: number) => number; conf: Float32Array } {
  const f = Math.max(1, Math.round(l.res / res))
  const cols = l.cols * f, rows = l.rows * f
  const out = { x0: l.x0, y0: l.y0, res: l.res / f, cols, rows,
                num: new Float32Array(cols * rows), den: new Float32Array(cols * rows), conf: new Float32Array(cols * rows),
                prior: (i: number) => out.num[i] }
  const at = (a: Float32Array, c: number, r: number) =>
    a[Math.min(l.rows - 1, Math.max(0, r)) * l.cols + Math.min(l.cols - 1, Math.max(0, c))]
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    // bilinear between source cell centres, ignoring NaN (blocked) corners
    const u = (c + 0.5) / f - 0.5, v = (r + 0.5) / f - 0.5
    const c0 = Math.floor(u), r0 = Math.floor(v), fu = u - c0, fv = v - r0
    const lerp = (a: Float32Array) => {
      const v00 = at(a, c0, r0), v10 = at(a, c0 + 1, r0), v01 = at(a, c0, r0 + 1), v11 = at(a, c0 + 1, r0 + 1)
      const n = (x: number) => (Number.isNaN(x) ? 0 : x)
      const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv
      const wsum = (Number.isNaN(v00) ? 0 : w00) + (Number.isNaN(v10) ? 0 : w10) + (Number.isNaN(v01) ? 0 : w01) + (Number.isNaN(v11) ? 0 : w11)
      return wsum ? (n(v00) * w00 + n(v10) * w10 + n(v01) * w01 + n(v11) * w11) / wsum : NaN
    }
    const i = r * cols + c
    const m = lerp(value)
    if (Number.isNaN(m)) continue
    const cf = conf ? Math.max(0, Math.min(1, lerp(conf))) : 1
    out.num[i] = m; out.den[i] = cf; out.conf[i] = cf
  }
  return out
}

/** Estimate at grid cell i: support-gated mean, or shrunk toward `prior` when given. */
type Prior = number | ((i: number) => number)
function estimator(g: Grid, minSupport: number, prior?: Prior, priorWeight = 0.5) {
  if (prior == null) return (i: number) => (g.den[i] < minSupport ? 0 : g.num[i] / g.den[i])
  const at = typeof prior === 'number' ? () => prior : prior
  return (i: number) => (g.num[i] + priorWeight * at(i)) / (g.den[i] + priorWeight)
}

const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t) }

/**
 * Grid -> north-up canvas of the thermal field, one pixel per grid cell. Opaque where the
 * evidence is solid, feathering out as support thins toward `minSupport`. With `prior`,
 * drawn everywhere, with thin-support cells (predicted) at `predictedAlpha` (or skipped with
 * `skipThin`). `alphaBy` gives a per-cell opacity (0-1) instead. Contour lines come from isolines().
 */
export function bandImage(g: Grid, opts: { minSupport?: number; prior?: Prior; priorWeight?: number; predictedAlpha?: number;
                                            alphaScale?: number; alphaBy?: Float32Array; skipThin?: boolean } = {}): HeatImage {
  const { minSupport = 0.3, prior, priorWeight = 0.5, predictedAlpha = 1, alphaScale = 1, alphaBy, skipThin = false } = opts
  const { cols: W, rows: H } = g
  const est = estimator(g, minSupport, prior, priorWeight)
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(W, H)
  const lut: [number, number, number][] = []
  for (let i = 0; i < 256; i++) lut.push(rampColor(i / 255))
  let rng = 7
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c
    if (prior == null && g.den[i] < minSupport) continue
    const thin = prior != null && g.den[i] / (g.den[i] + priorWeight) < 0.5
    if (thin && skipThin) continue
    // evidence: full strength by ~3x the gate, feathered below it; or the caller's per-cell confidence
    const evidence = alphaBy ? smooth(alphaBy[i] * 1.25) : prior == null ? smooth((g.den[i] - minSupport) / (2.5 * minSupport) + 0.25) : 1
    const a = Math.min(1, 0.86 * evidence * alphaScale * (thin ? predictedAlpha : 1))
    if (a <= 0) continue
    const t = rampT(est(i))
    const o = ((H - 1 - r) * W + c) * 4
    const [cr, cg, cb] = lut[Math.round(t * 255)]
    rng = (rng * 1103515245 + 12345) & 0x7fffffff
    const grain = ((rng >> 16) % 9) - 4 // faint film grain so the field reads as data, not paint
    img.data[o] = cr + grain; img.data[o + 1] = cg + grain; img.data[o + 2] = cb + grain; img.data[o + 3] = Math.round(255 * a)
  }
  ctx.putImageData(img, 0, 0)
  return { canvas, x0: g.x0, y1: g.y0 + H * g.res, w: W * g.res, h: H * g.res }
}

export type Isoline = {
  level: Level // band the contour belongs to
  rgb: [number, number, number] // ramp colour at the contour value
  major: boolean // a band threshold (good/moderate/poor/hazardous), vs a fine hairline
  segs: Float32Array // x1,y1,x2,y2,... metres
}

// marching squares: corners bl=1 br=2 tr=4 tl=8; edges 0 bottom, 1 right, 2 top, 3 left
const CASES: number[][] = [[], [3, 0], [0, 1], [3, 1], [1, 2], [3, 2, 0, 1], [0, 2], [3, 2], [2, 3], [0, 2],
                           [0, 3, 1, 2], [1, 2], [1, 3], [0, 1], [0, 3], []]

/** Contour values: the three thresholds plus fine levels spaced evenly along the ramp. */
function contourLevels(): { v: number; major: boolean }[] {
  const [a, b, c] = SCALE.bands
  const edges = [0, a, b, c, SCALE.max]
  const stops = [...RAMP_BANDS, 1]
  const out: { v: number; major: boolean }[] = []
  const fine = 16
  for (let k = 1; k < fine; k++) {
    const t = k / fine
    const i = stops.findIndex((s, j) => t >= s && t < (stops[j + 1] ?? 1.01))
    const v = edges[i] + ((t - stops[i]) / (stops[i + 1] - stops[i])) * (edges[i + 1] - edges[i])
    if (Math.min(...[a, b, c].map((th) => Math.abs(v - th) / th)) < 0.06) continue // too close to a threshold
    out.push({ v, major: false })
  }
  for (const v of [a, b, c]) out.push({ v, major: true })
  return out.filter((l) => l.v > 0)
}

/**
 * Smooth contour lines where the field crosses each level (thresholds plus fine levels). With a
 * prior, segments need a measured corner (or all four with `allCorners`, which stops lines
 * from tracing the edge of the walked corridor).
 */
export function isolines(g: Grid, opts: { minSupport?: number; prior?: Prior; priorWeight?: number; allCorners?: boolean } = {}): Isoline[] {
  const { minSupport = 0.3, prior, priorWeight = 0.5, allCorners = false } = opts
  const { cols: W, rows: H, x0, y0, res } = g
  const est = estimator(g, minSupport, prior, priorWeight)
  const v = new Float32Array(W * H)
  for (let i = 0; i < v.length; i++) v[i] = est(i)
  const measured = (i: number) => prior == null || g.den[i] / (g.den[i] + priorWeight) >= 0.5
  const out: Isoline[] = []
  for (const { v: t, major } of contourLevels()) {
    const segs: number[] = []
    for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
      const bl = r * W + c, br = bl + 1, tl = bl + W, tr = tl + 1
      const k = (v[bl] >= t ? 1 : 0) | (v[br] >= t ? 2 : 0) | (v[tr] >= t ? 4 : 0) | (v[tl] >= t ? 8 : 0)
      if (k === 0 || k === 15) continue
      const ok = allCorners ? measured(bl) && measured(br) && measured(tl) && measured(tr)
        : measured(bl) || measured(br) || measured(tl) || measured(tr)
      if (!ok) continue
      const f = (a: number, b: number) => (t - v[a]) / (v[b] - v[a] || 1e-6)
      const X = (cc: number) => x0 + (cc + 0.5) * res, Y = (rr: number) => y0 + (rr + 0.5) * res
      const edge = (e: number): [number, number] =>
        e === 0 ? [X(c + f(bl, br)), Y(r)] : e === 1 ? [X(c + 1), Y(r + f(br, tr))]
          : e === 2 ? [X(c + f(tl, tr)), Y(r + 1)] : [X(c), Y(r + f(bl, tl))]
      const cs = CASES[k]
      for (let j = 0; j < cs.length; j += 2) segs.push(...edge(cs[j]), ...edge(cs[j + 1]))
    }
    if (segs.length) out.push({ level: level(t), rgb: rampColor(rampT(t)), major, segs: Float32Array.from(segs) })
  }
  return out
}

export type Ink = { minor: string; major: string }
export const LIGHT_INK: Ink = { minor: 'rgba(226,236,255,0.42)', major: 'rgba(255,255,255,0.82)' }
export const DARK_INK: Ink = { minor: 'rgba(18,22,36,0.32)', major: 'rgba(18,22,36,0.72)' }

/** Stroke isolines with a world->screen mapping: hairlines for fine levels, `width` for thresholds. */
export function strokeIsolines(ctx: CanvasRenderingContext2D, lines: Isoline[], sx: (x: number) => number,
                               sy: (y: number) => number, width: number, ink: Ink = LIGHT_INK) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const pass of [false, true]) {
    ctx.lineWidth = pass ? width : Math.max(0.5, width * 0.45)
    ctx.strokeStyle = pass ? ink.major : ink.minor
    ctx.beginPath()
    for (const l of lines) {
      if (l.major !== pass) continue
      const s = l.segs
      for (let i = 0; i < s.length; i += 4) { ctx.moveTo(sx(s[i]), sy(s[i + 1])); ctx.lineTo(sx(s[i + 2]), sy(s[i + 3])) }
    }
    ctx.stroke()
  }
}
