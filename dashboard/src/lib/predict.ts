// Predict VOC beyond what was measured, for the 3D view.
//
// Floor (2D): Nadaraya-Watson kernel regression with a prior. Each point's estimate is
// the kernel-weighted mean of nearby readings, shrunk toward the prior where data is thin.
// The prior is the source model (sourceModel.ts: gas spreading from estimated sources
// through doorways) when there is one, else background air (25th-percentile reading).
// `conf` = share of the estimate that is data.
//
// Height (3D): the sensor only ever measures at chest height, so the vertical profile is
// an assumption: gas is centred on sensor height and spreads further up and down where
// the floor estimate is less certain. Shown as a particle cloud, never as measurements.
import { SCALE, level } from './colors'
import { BAND_RGB, kernelGrid, type Grid } from './heatImage'
import type { SourceModel } from './sourceModel'
import type { HeatCell } from './types'

export const SIGMA_M = 0.9 // how far one reading informs its surroundings
export const PRIOR_WEIGHT = 0.5 // pseudo-samples of background air mixed into every estimate
export const SENSOR_HEIGHT = 1.2 // m, where the wearer carries the sensor

export type Prediction = { grid: Grid; prior: (i: number) => number; est: (i: number) => number; conf: (i: number) => number }

/** Source-model value at a point (background where blocked or outside). */
export function modelAt(m: SourceModel, x: number, y: number) {
  const c = Math.floor((x - m.x0) / m.res), r = Math.floor((y - m.y0) / m.res)
  const v = c >= 0 && r >= 0 && c < m.cols && r < m.rows ? m.field[r * m.cols + c] : NaN
  return Number.isNaN(v) ? m.base : v
}

export function predict(cells: HeatCell[], bounds: { x0: number; y0: number; x1: number; y1: number },
                        model: SourceModel | null = null, sigmaM = SIGMA_M, res = 0.1): Prediction | null {
  const grid = kernelGrid(cells, sigmaM, res, bounds)
  if (!grid) return null
  const { num, den, cols } = grid
  let prior: (i: number) => number
  if (model) {
    const pf = new Float32Array(grid.cols * grid.rows)
    for (let i = 0; i < pf.length; i++) {
      pf[i] = modelAt(model, grid.x0 + ((i % cols) + 0.5) * grid.res, grid.y0 + (Math.floor(i / cols) + 0.5) * grid.res)
    }
    prior = (i) => pf[i]
  } else {
    const sorted = cells.map((c) => c.mean).sort((a, b) => a - b)
    const bg = sorted[Math.floor(sorted.length / 4)]
    prior = () => bg
  }
  return {
    grid, prior,
    est: (i) => (num[i] + PRIOR_WEIGHT * prior(i)) / (den[i] + PRIOR_WEIGHT),
    conf: (i) => den[i] / (den[i] + PRIOR_WEIGHT),
  }
}

/**
 * The predicted-only part as a Grid for bandImage/isolines: cells where data is thin
 * (conf < 0.5) get the estimate (den = 1); measured cells are left out (den = 0).
 */
export function predictedOnly(pred: Prediction, minVoc = SCALE.bands[0]): Grid {
  const { grid, est, conf } = pred
  const n = grid.cols * grid.rows
  const num = new Float32Array(n), den = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (conf(i) >= 0.5) continue
    const v = est(i)
    if (v < minVoc) continue
    num[i] = v; den[i] = 1
  }
  return { ...grid, num, den }
}

export type GasCloud = { positions: Float32Array; colors: Float32Array; alphas: Float32Array; phases: Float32Array }

/**
 * Sample particles for the 3D gas cloud: only in free space (`isFree`) where the
 * prediction is moderate or worse, more of them where it's worse, height drawn from
 * the assumed vertical profile. World axes: x, height, -y.
 */
export function gasCloud(pred: Prediction, isFree: (x: number, y: number) => boolean, budget = 7000): GasCloud {
  const { grid, est, conf } = pred
  const weights = new Float32Array(grid.cols * grid.rows)
  let total = 0
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
    const i = r * grid.cols + c
    const v = est(i)
    if (v < SCALE.bands[0]) continue
    if (!isFree(grid.x0 + (c + 0.5) * grid.res, grid.y0 + (r + 0.5) * grid.res)) continue
    weights[i] = Math.min(1, (v - 80) / 320) ** 1.3 * (0.3 + 0.7 * conf(i))
    total += weights[i]
  }
  const pos: number[] = [], col: number[] = [], alp: number[] = [], ph: number[] = []
  if (total > 0) {
    let rng = 12345
    const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647)
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand())
    const scale = Math.min(budget / total, 40) // at most 40 particles per 10 cm cell
    for (let i = 0; i < weights.length; i++) {
      if (!weights[i]) continue
      let n = weights[i] * scale
      n = Math.floor(n) + (rand() < n % 1 ? 1 : 0)
      if (!n) continue
      const c = i % grid.cols, r = Math.floor(i / grid.cols)
      const v = est(i), cf = conf(i)
      const [cr, cg, cb] = BAND_RGB[level(v)]
      const spread = 0.35 + (1 - cf) * 0.6
      for (let k = 0; k < n; k++) {
        const x = grid.x0 + (c + rand()) * grid.res, y = grid.y0 + (r + rand()) * grid.res
        const h = Math.min(2.6, Math.max(0.05, SENSOR_HEIGHT + gauss() * spread))
        pos.push(x, h, -y)
        col.push(cr / 255, cg / 255, cb / 255)
        alp.push((0.1 + 0.3 * Math.min(1, (v - SCALE.bands[0]) / (SCALE.bands[2] - SCALE.bands[0]))) * (0.4 + 0.6 * cf))
        ph.push(rand() * Math.PI * 2)
      }
    }
  }
  return { positions: Float32Array.from(pos), colors: Float32Array.from(col), alphas: Float32Array.from(alp),
           phases: Float32Array.from(ph) }
}
