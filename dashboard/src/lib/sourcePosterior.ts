// Layer 2: where is the gas coming from, as a probability over the floor plan.
//
// For every candidate cell on the source lattice, fit the best single-source strength
// (same model as sourceModel.ts) and score the weighted squared error of the readings.
// Posterior ∝ exp(−SSE / 2σ²), σ² = residual variance of the best candidate, so the
// cloud is tight when one spot explains the readings and broad when many would.
// Candidates far from every reading (> MAX_REACH walking metres) get zero mass.
import { distancesAtObs, lattice, LATTICE_M, cellIndex, type DistCache, type Obs, type PassGrid, type SourceModel } from './sourceModel'

export type SourceProb = { x0: number; y0: number; res: number; cols: number; rows: number; prob: Float32Array; peak: number }

const MAX_REACH = 6
const RIDGE = 0.05

export function sourcePosterior(g: PassGrid, obs: Obs[], model: SourceModel, cache: DistCache): SourceProb | null {
  if (!model.sources.length || obs.length < 8) return null
  const oi = obs.map((o) => cellIndex(g, o.x, o.y))
  const distAt = distancesAtObs(g, oi, cache)
  const cands = lattice(g)
  const L = model.L
  const resid0 = obs.map((o) => o.v - model.base)
  const qMax = 4 * Math.max(1, ...resid0)
  const sw = obs.reduce((s, o) => s + o.w, 0)
  const sse: number[] = []
  let bestSse = Infinity
  for (const ci of cands) {
    const d = distAt(ci)
    let near = Infinity
    for (let i = 0; i < d.length; i++) if (d[i] < near) near = d[i]
    if (near > MAX_REACH) { sse.push(Infinity); continue }
    let num = 0, den = 0
    for (let i = 0; i < obs.length; i++) { const phi = Math.exp(-d[i] / L); num += obs[i].w * phi * resid0[i]; den += obs[i].w * phi * phi }
    const q = Math.min(qMax, Math.max(0, num / (den + RIDGE)))
    let e = 0
    for (let i = 0; i < obs.length; i++) { const r = resid0[i] - q * Math.exp(-d[i] / L); e += obs[i].w * r * r }
    sse.push(e)
    if (e < bestSse) bestSse = e
  }
  if (!Number.isFinite(bestSse)) return null
  const sigma2 = Math.max(1, bestSse / Math.max(1, sw))
  // temper so the posterior reflects model misfit, not just sample count
  const T = Math.max(1, sw / 12)
  const w = sse.map((e) => (Number.isFinite(e) ? Math.exp(-(e - bestSse) / (2 * sigma2 * T)) : 0))
  const Z = w.reduce((a, b) => a + b, 0)
  if (!Z) return null

  // spread each candidate's mass over its lattice block, then a light blur
  const prob = new Float32Array(g.cols * g.rows)
  const half = Math.max(1, Math.round(LATTICE_M / g.res / 2))
  cands.forEach((ci, k) => {
    if (!w[k]) return
    const c0 = ci % g.cols, r0 = (ci - c0) / g.cols
    const pw = w[k] / Z
    for (let r = r0 - half; r <= r0 + half; r++) for (let c = c0 - half; c <= c0 + half; c++) {
      if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue
      const j = r * g.cols + c
      if (g.pass[j]) prob[j] += pw
    }
  })
  let out = prob
  const R = Math.max(1, Math.round(half / 2))
  for (let pass = 0; pass < 3; pass++) {
    const nx = new Float32Array(out.length)
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      let s = 0, n = 0
      for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
        const rr = r + dr, cc = c + dc
        if (rr < 0 || cc < 0 || rr >= g.rows || cc >= g.cols) continue
        s += out[rr * g.cols + cc]; n++
      }
      nx[r * g.cols + c] = g.pass[r * g.cols + c] ? s / n : 0
    }
    out = nx
  }
  let peak = 0
  for (let i = 0; i < out.length; i++) if (out[i] > peak) peak = out[i]
  return { x0: g.x0, y0: g.y0, res: g.res, cols: g.cols, rows: g.rows, prob: out, peak }
}
