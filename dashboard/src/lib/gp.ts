// Layer 1: the measured field as a Gaussian process over walkable distance.
//
// Prior mean = the source model's field (gas spreading from estimated sources) when there
// is one, else background. Covariance k(a,b) = σf² · exp(−d_geo(a,b)/ℓ), d_geo = geodesic
// distance through passable space, so a wall between two points makes them (nearly)
// independent. Observations are the 20 cm cells (mean, evidence weight, sd). ℓ is picked
// by marginal likelihood from a small set. Output: posterior mean and sd on the grid, and
// conf = 1 − var/σf² (0 far from any reading, →1 on top of one).
import { geodesic, type Obs, type PassGrid } from './sourceModel'

export type Field = {
  x0: number; y0: number; res: number; cols: number; rows: number
  mean: Float32Array // ppb (NaN where blocked)
  sd: Float32Array
  conf: Float32Array // 0..1
  base: number; ell: number; sigmaF: number; n: number
}

const MAX_OBS = 120
const ELLS = [1.5, 3, 6]
const MIN_SD = 15 // ppb: sensor noise floor, so a single calm reading isn't treated as exact
const REACH = 4 // in units of ℓ: beyond this a reading has no influence (saves work)

/** Cholesky of a symmetric positive-definite matrix (row-major n×n), in place -> lower L. */
function cholesky(a: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    let s = a[j * n + j]
    for (let k = 0; k < j; k++) s -= a[j * n + k] ** 2
    if (s <= 1e-12) return false
    const d = Math.sqrt(s)
    a[j * n + j] = d
    for (let i = j + 1; i < n; i++) {
      let t = a[i * n + j]
      for (let k = 0; k < j; k++) t -= a[i * n + k] * a[j * n + k]
      a[i * n + j] = t / d
    }
  }
  return true
}
function solveLower(L: Float64Array, n: number, b: Float64Array, out: Float64Array) {
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[i * n + k] * out[k]
    out[i] = s / L[i * n + i]
  }
}
function solveUpperT(L: Float64Array, n: number, b: Float64Array, out: Float64Array) {
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * out[k]
    out[i] = s / L[i * n + i]
  }
}

/** Thin observations to at most MAX_OBS: one per 0.5 m block (highest weight), then by weight. */
function thin(g: PassGrid, obs: Obs[]): { o: Obs; ci: number }[] {
  const block = new Map<string, { o: Obs; ci: number }>()
  for (const o of obs) {
    const c = Math.floor((o.x - g.x0) / g.res), r = Math.floor((o.y - g.y0) / g.res)
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue
    const ci = r * g.cols + c
    if (!g.pass[ci]) continue
    const key = `${Math.floor(o.x / 0.5)},${Math.floor(o.y / 0.5)}`
    const cur = block.get(key)
    if (!cur || o.w > cur.o.w) block.set(key, { o, ci })
  }
  return [...block.values()].sort((a, b) => b.o.w - a.o.w).slice(0, MAX_OBS)
}

export function fitField(g: PassGrid, obs: Obs[], priorAt: ((i: number) => number) | null, base: number): Field | null {
  const pts = thin(g, obs)
  const n = pts.length
  const N = g.cols * g.rows
  const prior = priorAt ?? (() => base)
  if (n < 3) return null

  // geodesic distance from every observation to every cell (float32 to keep memory sane)
  const D: Float32Array[] = pts.map(({ ci }) => Float32Array.from(geodesic(g, ci, 30)))
  const y = new Float64Array(n), noise = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    y[k] = pts[k].o.v - prior(pts[k].ci)
    const sd = Math.max(MIN_SD, pts[k].o.sd ?? MIN_SD)
    noise[k] = (sd * sd) / Math.min(3, Math.max(0.2, pts[k].o.w))
  }
  let varY = 0
  for (let k = 0; k < n; k++) varY += y[k] * y[k]
  const sigmaF2 = Math.max(MIN_SD * MIN_SD, varY / n)

  // pick ℓ by log marginal likelihood
  let best: { ell: number; L: Float64Array; alpha: Float64Array; lml: number } | null = null
  const K = new Float64Array(n * n), tmp = new Float64Array(n), alpha = new Float64Array(n)
  for (const ell of ELLS) {
    for (let a = 0; a < n; a++) for (let b = a; b < n; b++) {
      const d = a === b ? 0 : 0.5 * (D[a][pts[b].ci] + D[b][pts[a].ci])
      const k = Number.isFinite(d) ? sigmaF2 * Math.exp(-d / ell) : 0
      K[a * n + b] = K[b * n + a] = k
    }
    for (let a = 0; a < n; a++) K[a * n + a] += noise[a] + 1e-6 * sigmaF2
    const L = Float64Array.from(K)
    if (!cholesky(L, n)) continue
    solveLower(L, n, y, tmp)
    const al = new Float64Array(n)
    solveUpperT(L, n, tmp, al)
    let lml = 0
    for (let k = 0; k < n; k++) lml -= 0.5 * y[k] * al[k] + Math.log(L[k * n + k])
    if (!best || lml > best.lml) best = { ell, L, alpha: al, lml }
  }
  if (!best) return null
  const { ell, L } = best
  alpha.set(best.alpha)

  // posterior on every passable cell
  const mean = new Float32Array(N).fill(NaN), sd = new Float32Array(N), conf = new Float32Array(N)
  const kv = new Float64Array(n), v = new Float64Array(n)
  const reach = REACH * ell
  for (let i = 0; i < N; i++) {
    if (!g.pass[i]) continue
    const m0 = prior(i)
    let any = false, mu = m0
    for (let k = 0; k < n; k++) {
      const d = D[k][i]
      if (d < reach) { kv[k] = sigmaF2 * Math.exp(-d / ell); any = true; mu += kv[k] * alpha[k] } else kv[k] = 0
    }
    if (!any) { mean[i] = m0; sd[i] = Math.sqrt(sigmaF2); conf[i] = 0; continue }
    solveLower(L, n, kv, v)
    let q = 0
    for (let k = 0; k < n; k++) q += v[k] * v[k]
    const variance = Math.max(0, sigmaF2 - q)
    mean[i] = Math.max(0, mu)
    sd[i] = Math.sqrt(variance)
    conf[i] = Math.min(1, Math.max(0, 1 - variance / sigmaF2))
  }
  return { x0: g.x0, y0: g.y0, res: g.res, cols: g.cols, rows: g.rows, mean, sd, conf, base, ell, sigmaF: Math.sqrt(sigmaF2), n }
}
