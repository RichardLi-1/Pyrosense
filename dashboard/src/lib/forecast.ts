// Layer 3: where the gas will be, as an ensemble diffusion forecast on the floor plan.
//
// The current estimate relaxes toward the source model's steady state while diffusing:
//   C_{t+dt} = C + dt·( D·∇²C − λ·(C − T) ),  T(x) = base + Σ q_k·exp(−d_geo(x, s_k)/L)
// Walls are no-flux, source cells are held at base + q, λ = D/L². So at short horizons
// the field is what was measured plus a little spreading; at long horizons it approaches
// the model's equilibrium reach. Each ensemble member perturbs source position (drawn from
// the source posterior) and strength; the spread across members is the uncertainty.
// No airflow model: this is reach and timing, not direction.
import type { Field } from './gp'
import { geodesic, type PassGrid, type Source } from './sourceModel'
import type { SourceProb } from './sourcePosterior'

export type Forecast = {
  x0: number; y0: number; res: number; cols: number; rows: number
  horizons: number[] // seconds ahead
  mean: Float32Array[] // per horizon (NaN where blocked)
  sd: Float32Array[]
  members: number
}

const D = 0.08 // m²/s effective indoor mixing
const COARSE = 2 // forecast grid = model grid × COARSE
export const HORIZONS = [60, 120, 300]

function coarsen(g: PassGrid, field: Field, base: number) {
  const cols = Math.ceil(g.cols / COARSE), rows = Math.ceil(g.rows / COARSE), res = g.res * COARSE
  const pass = new Uint8Array(cols * rows), c0 = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let np = 0, sum = 0, ns = 0
    for (let dr = 0; dr < COARSE; dr++) for (let dc = 0; dc < COARSE; dc++) {
      const rr = r * COARSE + dr, cc = c * COARSE + dc
      if (rr >= g.rows || cc >= g.cols) continue
      const j = rr * g.cols + cc
      if (!g.pass[j]) continue
      np++
      const v = field.mean[j]
      if (Number.isFinite(v)) { sum += v; ns++ }
    }
    const i = r * cols + c
    pass[i] = np >= 2 ? 1 : 0
    c0[i] = ns ? Math.max(base, sum / ns) : base
  }
  const cg: PassGrid = { x0: g.x0, y0: g.y0, res, cols, rows, pass }
  return { cg, c0 }
}

export function forecast(g: PassGrid, field: Field, sources: Source[], prob: SourceProb | null, base: number, L: number,
                         horizons = HORIZONS, members = 6): Forecast | null {
  if (!sources.length) return null
  const { cg, c0 } = coarsen(g, field, base)
  const { cols, rows, res, pass } = cg
  const N = cols * rows
  const lambda = D / (L * L)
  const dt = Math.min(1, (0.2 * res * res) / D)
  const steps = horizons.map((h) => Math.round(h / dt))
  const total = steps[steps.length - 1]

  // candidate source positions from the posterior (top cells), for ensemble members
  let rng = 4242
  const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647)
  const picks: number[] = []
  if (prob) {
    for (let i = 0; i < prob.prob.length; i++) {
      if (prob.prob[i] <= 0.15 * prob.peak) continue
      const c = Math.floor((i % prob.cols) / COARSE), r = Math.floor(Math.floor(i / prob.cols) / COARSE)
      const j = r * cols + c
      if (j >= 0 && j < N && pass[j]) picks.push(j)
    }
  }
  const toIdx = (x: number, y: number) => {
    const c = Math.floor((x - g.x0) / res), r = Math.floor((y - g.y0) / res)
    return c >= 0 && r >= 0 && c < cols && r < rows ? r * cols + c : -1
  }
  const nearestPass = (i: number) => {
    if (i >= 0 && pass[i]) return i
    if (i < 0) return -1
    const c = i % cols, r = (i - c) / cols
    for (let k = 1; k <= 3; k++) for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) {
      const rr = r + dr, cc = c + dc
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue
      if (pass[rr * cols + cc]) return rr * cols + cc
    }
    return -1
  }

  const acc = horizons.map(() => new Float64Array(N)), acc2 = horizons.map(() => new Float64Array(N))
  const C = new Float32Array(N), Cn = new Float32Array(N), T = new Float32Array(N)
  for (let m = 0; m < members; m++) {
    // this member's sources, and its equilibrium field T
    const srcs: { i: number; q: number }[] = []
    sources.forEach((s, k) => {
      let i = nearestPass(toIdx(s.x, s.y))
      if (m > 0 && k === 0 && picks.length) i = picks[Math.floor(rand() * picks.length)]
      const q = m === 0 ? s.q : s.q * Math.exp((rand() - 0.5) * 0.6)
      if (i >= 0) srcs.push({ i, q })
    })
    if (!srcs.length) continue
    T.fill(base)
    for (const s of srcs) {
      const d = geodesic(cg, s.i)
      for (let i = 0; i < N; i++) if (pass[i] && d[i] < Infinity) T[i] += s.q * Math.exp(-d[i] / L)
    }
    C.set(c0)
    for (const s of srcs) C[s.i] = Math.max(C[s.i], base + s.q)
    let hi = 0
    for (let t = 1; t <= total; t++) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        if (!pass[i]) { Cn[i] = base; continue }
        let lap = 0
        if (c > 0 && pass[i - 1]) lap += C[i - 1] - C[i]
        if (c < cols - 1 && pass[i + 1]) lap += C[i + 1] - C[i]
        if (r > 0 && pass[i - cols]) lap += C[i - cols] - C[i]
        if (r < rows - 1 && pass[i + cols]) lap += C[i + cols] - C[i]
        Cn[i] = C[i] + dt * ((D * lap) / (res * res) - lambda * (C[i] - T[i]))
      }
      for (const s of srcs) Cn[s.i] = Math.max(Cn[s.i], base + s.q)
      C.set(Cn)
      if (hi < steps.length && t === steps[hi]) {
        for (let i = 0; i < N; i++) { acc[hi][i] += C[i]; acc2[hi][i] += C[i] * C[i] }
        hi++
      }
    }
  }
  const mean = horizons.map((_, h) => {
    const out = new Float32Array(N)
    for (let i = 0; i < N; i++) out[i] = pass[i] ? acc[h][i] / members : NaN
    return out
  })
  const sd = horizons.map((_, h) => {
    const out = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const mu = acc[h][i] / members
      out[i] = pass[i] ? Math.sqrt(Math.max(0, acc2[h][i] / members - mu * mu)) : NaN
    }
    return out
  })
  return { x0: g.x0, y0: g.y0, res, cols, rows, horizons, mean, sd, members }
}
