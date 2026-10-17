// Predict VOC beyond what's been sensed by estimating where the gas comes from.
//
// Model: VOC(x) = base + Σ_k q_k · exp(−d(x, s_k) / L)
//   d = geodesic distance through passable space (gas goes around walls and through
//       doorways, not through them). Unexplored space counts as passable, so a source
//       can be placed in a room nobody has entered yet.
// Fit: base = background (25th percentile of readings); then greedily add up to
// MAX_SOURCES point sources, each chosen from a candidate lattice (refined locally) to
// best reduce the weighted squared error; strengths are non-negative least squares.
// Runs in a worker (model.worker.ts); pure functions here so it's testable.

export type PassGrid = { x0: number; y0: number; res: number; cols: number; rows: number; pass: Uint8Array }
export type Obs = { x: number; y: number; v: number; w: number }
export type Source = { x: number; y: number; q: number }
export type SourceModel = {
  x0: number; y0: number; res: number; cols: number; rows: number
  field: Float32Array // predicted VOC per cell (NaN where blocked)
  base: number
  L: number
  sources: Source[]
}

const MAX_SOURCES = 3
const LS = [1.5, 2.5, 4]
const SQ2 = Math.SQRT2

/** Geodesic distance (metres) from cell `from` to every cell, 8-connected, no corner cutting. */
export function geodesic(g: PassGrid, from: number, maxM = Infinity): Float32Array {
  const { cols, rows, pass, res } = g
  const n = cols * rows
  const dist = new Float32Array(n).fill(Infinity)
  if (!pass[from]) return dist
  // binary heap of (dist, idx)
  const hd = new Float32Array(n * 4), hi = new Int32Array(n * 4)
  let size = 0
  const push = (d: number, i: number) => {
    let k = size++
    while (k > 0) { const p = (k - 1) >> 1; if (hd[p] <= d) break; hd[k] = hd[p]; hi[k] = hi[p]; k = p }
    hd[k] = d; hi[k] = i
  }
  const pop = () => {
    const d = hd[0], i = hi[0]
    const ld = hd[--size], li = hi[size]
    let k = 0
    for (;;) {
      let c = 2 * k + 1
      if (c >= size) break
      if (c + 1 < size && hd[c + 1] < hd[c]) c++
      if (hd[c] >= ld) break
      hd[k] = hd[c]; hi[k] = hi[c]; k = c
    }
    hd[k] = ld; hi[k] = li
    return [d, i] as const
  }
  dist[from] = 0
  push(0, from)
  while (size) {
    const [d, i] = pop()
    if (d > dist[i] || d > maxM) continue
    const c = i % cols, r = (i - c) / cols
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const cc = c + dx, rr = r + dy
      if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue
      const j = rr * cols + cc
      if (!pass[j]) continue
      if (dx && dy && (!pass[r * cols + cc] || !pass[rr * cols + c])) continue // no squeezing past corners
      const nd = d + (dx && dy ? SQ2 : 1) * res
      if (nd < dist[j]) { dist[j] = nd; push(nd, j) }
    }
  }
  return dist
}

function percentile(v: number[], p: number) {
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

export function fitSourceModel(g: PassGrid, obs: Obs[]): SourceModel | null {
  if (obs.length < 8) return null
  const { cols, rows, res, x0, y0 } = g
  const cell = (x: number, y: number) => {
    const c = Math.floor((x - x0) / res), r = Math.floor((y - y0) / res)
    return c >= 0 && r >= 0 && c < cols && r < rows ? r * cols + c : -1
  }
  const base = percentile(obs.map((o) => o.v), 0.25)
  const oi = obs.map((o) => cell(o.x, o.y))
  const resid0 = obs.map((o) => o.v - base)
  const sse = (r: number[]) => r.reduce((s, x, i) => s + obs[i].w * x * x, 0)

  // candidate lattice over passable cells
  const stride = Math.max(1, Math.round(1.6 / res))
  const cands: number[] = []
  for (let r = Math.floor(stride / 2); r < rows; r += stride) for (let c = Math.floor(stride / 2); c < cols; c += stride) {
    if (g.pass[r * cols + c]) cands.push(r * cols + c)
  }
  const atObs = new Map<number, Float32Array>() // candidate -> distance at each observation
  const distAtObs = (ci: number) => {
    let d = atObs.get(ci)
    if (!d) {
      const full = geodesic(g, ci, 16)
      d = Float32Array.from(oi, (k) => (k < 0 ? Infinity : full[k]))
      atObs.set(ci, d)
    }
    return d
  }

  let best: { L: number; sources: { ci: number; q: number }[]; err: number } | null = null
  for (const L of LS) {
    let resid = resid0.slice()
    const chosen: { ci: number; q: number }[] = []
    const err0 = sse(resid)
    for (let k = 0; k < MAX_SOURCES; k++) {
      const score = (ci: number) => {
        const d = distAtObs(ci)
        let num = 0, den = 0
        for (let i = 0; i < obs.length; i++) {
          const phi = Math.exp(-d[i] / L)
          num += obs[i].w * phi * resid[i]; den += obs[i].w * phi * phi
        }
        const q = den > 1e-9 ? Math.max(0, num / den) : 0
        return { q, gain: q * num }
      }
      let top = { ci: -1, q: 0, gain: 0 }
      for (const ci of cands) { const s = score(ci); if (s.gain > top.gain) top = { ci, ...s } }
      if (top.ci < 0) break
      // refine around the best lattice point
      const c0 = top.ci % cols, r0 = (top.ci - c0) / cols
      for (let dr = -stride; dr <= stride; dr += 2) for (let dc = -stride; dc <= stride; dc += 2) {
        const c = c0 + dc, r = r0 + dr
        if (c < 0 || r < 0 || c >= cols || r >= rows || !g.pass[r * cols + c]) continue
        const s = score(r * cols + c)
        if (s.gain > top.gain) top = { ci: r * cols + c, ...s }
      }
      // keep a source only if it explains a meaningful share of what's left
      if (top.gain < 0.12 * sse(resid) || top.gain < 0.03 * err0) break
      chosen.push({ ci: top.ci, q: top.q })
      const d = distAtObs(top.ci)
      resid = resid.map((x, i) => x - top.q * Math.exp(-d[i] / L))
    }
    // joint non-negative refit of strengths (coordinate descent)
    for (let it = 0; it < 8 && chosen.length > 1; it++) {
      for (const s of chosen) {
        const d = distAtObs(s.ci)
        let num = 0, den = 0
        for (let i = 0; i < obs.length; i++) {
          const phi = Math.exp(-d[i] / L)
          const other = chosen.reduce((acc, o) => (o === s ? acc : acc + o.q * Math.exp(-distAtObs(o.ci)[i] / L)), 0)
          num += obs[i].w * phi * (resid0[i] - other); den += obs[i].w * phi * phi
        }
        s.q = den > 1e-9 ? Math.max(0, num / den) : 0
      }
    }
    const final = resid0.map((x, i) => x - chosen.reduce((a, s) => a + s.q * Math.exp(-distAtObs(s.ci)[i] / L), 0))
    const err = sse(final) * (1 + 0.04 * chosen.length) // mild penalty per source
    if (!best || err < best.err) best = { L, sources: chosen, err }
  }

  const field = new Float32Array(cols * rows)
  for (let i = 0; i < field.length; i++) field[i] = g.pass[i] ? base : NaN
  const sources: Source[] = []
  for (const s of best!.sources) {
    if (s.q < 5) continue
    const full = geodesic(g, s.ci)
    for (let i = 0; i < field.length; i++) if (g.pass[i] && full[i] < Infinity) field[i] += s.q * Math.exp(-full[i] / best!.L)
    const c = s.ci % cols, r = (s.ci - c) / cols
    sources.push({ x: x0 + (c + 0.5) * res, y: y0 + (r + 0.5) * res, q: s.q })
  }
  return { x0, y0, res, cols, rows, field, base, L: best!.L, sources }
}

/** Map image alpha (backend PNG layout, row 0 = max y) -> passable grid at `res`: walls block, unknown is passable. */
export function passGridFromAlpha(alpha: Uint8ClampedArray, meta: { origin: [number, number]; res: number; w: number; h: number },
                                  res = 0.2): PassGrid {
  const k = Math.max(1, Math.round(res / meta.res))
  const cols = Math.ceil(meta.w / k), rows = Math.ceil(meta.h / k)
  const pass = new Uint8Array(cols * rows).fill(1)
  for (let py = 0; py < meta.h; py++) for (let px = 0; px < meta.w; px++) {
    const a = alpha[(py * meta.w + px) * 4 + 3]
    if (a > 0 && a <= 240) { // occupied
      const r = Math.floor((meta.h - 1 - py) / k), c = Math.floor(px / k)
      pass[r * cols + c] = 0
    }
  }
  return { x0: meta.origin[0], y0: meta.origin[1], res: k * meta.res, cols, rows, pass }
}
