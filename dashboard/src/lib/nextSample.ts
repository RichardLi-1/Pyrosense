// Layer 5: where to sample next, from the GP's own uncertainty.
//
// Every passable cell the field knows about (conf > 0: within reach of at least one
// reading, so the GP can say *something* about it) is scored
//
//   score = sd · (1 + excess / σf) · (1 + SOURCE_W · p_source)
//
// sd is the GP posterior standard deviation (the variance is what we want to shrink);
// excess = max(0, mean − base) prefers uncertain spots that are also predicted to be
// elevated, so a reading there confirms or rules out a hazard rather than a quiet corridor;
// p_source is the normalised source posterior, so uncertainty near a suspected source
// outranks the same uncertainty in a dead end. Cells already well measured have a tiny sd
// and drop out on their own; cells the GP can't reach (conf = 0) are excluded, because
// they are not a "next" sample but an unexplored region — the map already shows those as
// transparent. Candidates are the lattice points (1.6 m apart) with non-maximum suppression
// so the result is a handful of distinct regions, not one blob of neighbouring cells.
import type { Field } from './gp'
import { SCALE, level, type Level } from './colors'
import { geodesic, lattice, LATTICE_M, type Obs, type PassGrid } from './sourceModel'
import type { SourceProb } from './sourcePosterior'

export type Candidate = {
  x: number; y: number // metres, world frame
  r: number // metres, region radius (half the lattice spacing)
  score: number
  sd: number // ppb, GP posterior sd at the centre
  mean: number // ppb, GP posterior mean at the centre
  level: Level // band of `mean`
  pSource: number // 0..1, normalised source posterior at the centre
  ageS: number | null // seconds since the nearest reading within 1 m; null = nothing measured within 1 m
  /** Walking distance (m) from this candidate to every cell of the field grid, Infinity where unreachable. */
  geo: Float32Array
}

export type NextSample = Candidate & { dist: number } // dist: walking metres from the wearer

const SOURCE_W = 2
const MAX_CANDIDATES = 12 // enough that the few within reach of the wearer are among them
const MIN_SD_FRAC = 0.25 // ignore cells whose sd is below this fraction of σf: already known well enough
/** Farthest a "next" sample may be, walking (m); beyond that there is simply nothing to suggest. */
export const MAX_WALK_M = 8
/** Nearer candidates win ties: score / (1 + dist / PREFER_NEAR_M). */
export const PREFER_NEAR_M = 6
const GEO_MAX_M = 60 // walking distance beyond which a candidate is simply "far"
const SOLID_WIN = 2 // 5x5 cells at pass-grid res (1 m at 0.2 m)
const SOLID_FRAC = 0.6

/**
 * Solid known free space: a cell that is itself scanned free and whose 5x5 neighbourhood is
 * at least 60% free. Thin ray-traced spokes and the fringe of the unknown fail this; rooms
 * and corridors pass. Same test knownBounds() uses for the camera.
 */
export function solidFree(g: PassGrid): Uint8Array {
  const { cols, rows } = g
  const out = new Uint8Array(cols * rows)
  const free = g.free
  if (!free) { out.set(g.pass); return out } // older grids: fall back to passable
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c
    if (free[i] < 0.5) continue
    let sum = 0, n = 0
    for (let rr = Math.max(0, r - SOLID_WIN); rr <= Math.min(rows - 1, r + SOLID_WIN); rr++)
      for (let cc = Math.max(0, c - SOLID_WIN); cc <= Math.min(cols - 1, c + SOLID_WIN); cc++) { sum += free[rr * cols + cc]; n++ }
    if (sum >= SOLID_FRAC * n) out[i] = 1
  }
  return out
}

export function nextSampleCandidates(g: PassGrid, field: Field, prob: SourceProb | null, obs: Obs[] = [], max = MAX_CANDIDATES): Candidate[] {
  if (field.sigmaF <= 0) return []
  const { cols, rows } = g
  const solid = solidFree(g)
  const half = Math.max(1, Math.round(LATTICE_M / g.res / 2))
  const scored: { ci: number; score: number }[] = []
  for (const ci of lattice(g)) {
    // best cell in the lattice block, so a region isn't missed because its centre is a wall
    const c0 = ci % cols, r0 = (ci - c0) / cols
    let best = -1, bestScore = 0
    for (let r = r0 - half; r <= r0 + half; r++) for (let c = c0 - half; c <= c0 + half; c++) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue
      const j = r * cols + c
      if (!solid[j]) continue
      const s = cellScore(g, field, prob, j)
      if (s > bestScore) { bestScore = s; best = j }
    }
    if (best >= 0) scored.push({ ci: best, score: bestScore })
  }
  scored.sort((a, b) => b.score - a.score)
  // non-maximum suppression: keep a candidate only if it's at least one lattice step from the kept ones
  const kept: Candidate[] = []
  const minSep2 = LATTICE_M * LATTICE_M
  for (const { ci, score } of scored) {
    const c = ci % cols, r = (ci - c) / cols
    const x = g.x0 + (c + 0.5) * g.res, y = g.y0 + (r + 0.5) * g.res
    if (kept.some((k) => (k.x - x) ** 2 + (k.y - y) ** 2 < minSep2)) continue
    const mean = field.mean[ci]
    const pSource = prob && prob.peak > 0 ? prob.prob[ci] / prob.peak : 0
    kept.push({ x, y, r: half * g.res, score, sd: field.sd[ci], mean, level: level(Number.isNaN(mean) ? 0 : mean), pSource,
                ageS: nearestAge(obs, x, y), geo: Float32Array.from(geodesic(g, ci, GEO_MAX_M)) })
    if (kept.length >= max) break
  }
  return kept
}

/** Seconds since the newest reading within 1 m, or null when nothing has been measured there. */
function nearestAge(obs: Obs[], x: number, y: number): number | null {
  let best: number | null = null
  for (const o of obs) {
    if ((o.x - x) ** 2 + (o.y - y) ** 2 > 1) continue
    const age = o.t != null ? Math.max(0, (Date.now() - o.t) / 1000) : 0 // no timestamp: measured, age unknown
    if (best == null || age < best) best = age
  }
  return best
}

function cellScore(g: PassGrid, field: Field, prob: SourceProb | null, i: number): number {
  if (!g.pass[i]) return 0
  const conf = field.conf[i]
  if (!(conf > 0)) return 0 // out of the GP's reach: unexplored, not "next"
  const sd = field.sd[i]
  if (!(sd >= MIN_SD_FRAC * field.sigmaF)) return 0
  const mean = field.mean[i]
  const excess = Number.isNaN(mean) ? 0 : Math.max(0, mean - field.base)
  const p = prob && prob.peak > 0 ? prob.prob[i] / prob.peak : 0
  return sd * (1 + excess / field.sigmaF) * (1 + SOURCE_W * p)
}

/**
 * Pick the candidate worth walking to from where the wearer stands: within MAX_WALK_M by
 * walking distance (through doors, not walls), best score after dividing by (1 + d/6) so a
 * slightly weaker candidate next door beats a stronger one in the next room. Nothing within
 * reach means no suggestion, rather than a far-away one. Without a pose, the top-scored one.
 */
export function chooseNext(cands: Candidate[], pose: { x: number; y: number } | null,
                           grid: { x0: number; y0: number; res: number; cols: number; rows: number } | null = null): NextSample | null {
  if (!cands.length) return null
  let at = -1
  if (pose && grid) {
    const c = Math.floor((pose.x - grid.x0) / grid.res), r = Math.floor((pose.y - grid.y0) / grid.res)
    if (c >= 0 && r >= 0 && c < grid.cols && r < grid.rows) at = r * grid.cols + c
  }
  let best: NextSample | null = null, bestV = -Infinity
  for (const c of cands) {
    let dist = pose ? Math.hypot(c.x - pose.x, c.y - pose.y) : 0
    if (at >= 0) { const d = c.geo[at]; dist = Number.isFinite(d) ? d : Infinity }
    if (pose && dist > MAX_WALK_M) continue
    const v = c.score / (1 + dist / PREFER_NEAR_M)
    if (v > bestV) { bestV = v; best = { ...c, dist } }
  }
  return best
}

/**
 * Why this spot, in one line: distance and direction, then only the clauses that apply.
 * e.g. "7 m SW · uncertainty high (±120 ppb) · predicted 340 ppb, poor · near likely source"
 */
export function explainNext(n: NextSample, field: Field, from: { x: number; y: number } | null): string {
  const unit = SCALE.short ? ` ${SCALE.short}` : ''
  const parts: string[] = []
  parts.push(from ? `${n.dist.toFixed(0)} m ${bearing(from, n)}` : `(${n.x.toFixed(0)}, ${n.y.toFixed(0)})`)
  if (n.sd > 0.5 * field.sigmaF) parts.push(`uncertainty high (±${n.sd.toFixed(0)}${unit})`)
  if (!Number.isNaN(n.mean) && n.mean >= SCALE.bands[0]) parts.push(`predicted ${n.mean.toFixed(0)}${unit}, ${n.level === 'alert' ? 'hazardous' : n.level}`)
  if (n.pSource > 0.3) parts.push('near likely source')
  if (n.ageS == null) parts.push('not measured yet')
  return parts.join(' · ')
}

/** Compass direction from the wearer to a point, in map frame (x east, y north). */
export function bearing(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const a = Math.atan2(to.x - from.x, to.y - from.y) // 0 = north, clockwise
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[Math.round(((a + Math.PI * 2) / (Math.PI / 4))) % 8]
}
