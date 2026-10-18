// The gas model: one free-space graph, one field with uncertainty, one source posterior,
// one forecast derived from them. Runs in model.worker.ts; pure here.
//
//   layer 0  passGridFromAlpha   occupancy PNG -> passable grid (walls block, unknown passable)
//   layer 2  fitSourceModel      where it comes from (point estimate) -> prior mean for the GP
//   layer 1  fitField            GP over walkable distance: mean, sd, conf on every cell
//   layer 2  sourcePosterior     probability of source location
//   layer 3  forecast            ensemble diffusion from the sources, +1/+2/+5 min
//   layer 5  nextSampleCandidates where a reading would shrink the GP variance most
import { fitField, type Field } from './gp'
import { forecast as runForecast, type Forecast } from './forecast'
import { fitSourceModel, passGridFromAlpha, type DistCache, type Obs, type PassGrid, type SourceModel } from './sourceModel'
import { sourcePosterior, type SourceProb } from './sourcePosterior'
import { nextSampleCandidates, type Candidate } from './nextSample'

export type GasModel = {
  source: SourceModel | null
  field: Field | null
  sourceProb: SourceProb | null
  forecast: Forecast | null
  next: Candidate[] // next-best sample regions, best first
  ms: { source: number; field: number; posterior: number; forecast: number; next: number }
}

export type GasRequest = { alpha: Uint8ClampedArray; meta: { origin: [number, number]; res: number; w: number; h: number }; obs: Obs[] }

export function runGasModel(req: GasRequest): GasModel {
  const g: PassGrid = passGridFromAlpha(req.alpha, req.meta)
  const cache: DistCache = new Map()
  const t0 = performance.now()
  const source = fitSourceModel(g, req.obs, cache)
  const t1 = performance.now()
  const base = source?.base ?? background(req.obs)
  const priorAt = source ? (i: number) => (Number.isNaN(source.field[i]) ? source.base : source.field[i]) : null
  const field = fitField(g, req.obs, priorAt, base)
  const t2 = performance.now()
  const sourceProb = source ? sourcePosterior(g, req.obs, source, cache) : null
  const t3 = performance.now()
  const fc = source && field ? runForecast(g, field, source.sources, sourceProb, source.base, source.L) : null
  const t4 = performance.now()
  const next = field ? nextSampleCandidates(g, field, sourceProb, req.obs) : []
  const t5 = performance.now()
  return { source, field, sourceProb, forecast: fc, next,
           ms: { source: t1 - t0, field: t2 - t1, posterior: t3 - t2, forecast: t4 - t3, next: t5 - t4 } }
}

function background(obs: Obs[]) {
  if (!obs.length) return 0
  const s = obs.map((o) => o.v).sort((a, b) => a - b)
  return s[Math.floor(s.length / 4)]
}

/** Buffers to transfer out of the worker. */
export function transferables(m: GasModel): ArrayBuffer[] {
  const out: ArrayBuffer[] = []
  if (m.source) out.push(m.source.field.buffer as ArrayBuffer)
  if (m.field) out.push(m.field.mean.buffer as ArrayBuffer, m.field.sd.buffer as ArrayBuffer, m.field.conf.buffer as ArrayBuffer)
  if (m.sourceProb) out.push(m.sourceProb.prob.buffer as ArrayBuffer)
  if (m.forecast) for (const a of [...m.forecast.mean, ...m.forecast.sd]) out.push(a.buffer as ArrayBuffer)
  for (const c of m.next) out.push(c.geo.buffer as ArrayBuffer)
  return out
}

/** Value of a gridded layer at a world point (NaN outside / blocked). */
export function sampleAt(l: { x0: number; y0: number; res: number; cols: number; rows: number }, a: Float32Array, x: number, y: number) {
  const c = Math.floor((x - l.x0) / l.res), r = Math.floor((y - l.y0) / l.res)
  return c >= 0 && r >= 0 && c < l.cols && r < l.rows ? a[r * l.cols + c] : NaN
}
