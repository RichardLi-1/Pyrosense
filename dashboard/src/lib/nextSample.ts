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
import { geodesic, lattice, LATTICE_M, type PassGrid } from './sourceModel'
import type { SourceProb } from './sourcePosterior'

export type Candidate = {
  x: number; y: number // metres, world frame
  r: number // metres, region radius (half the lattice spacing)
  score: number
  sd: number // ppb, GP posterior sd at the centre
  mean: number // ppb, GP posterior mean at the centre
  /** Walking distance (m) from this candidate to every cell of the field grid, Infinity where unreachable. */
  geo: Float32Array
}

export type NextSample = Candidate & { dist: number } // dist: walking metres from the wearer

const SOURCE_W = 2
const MAX_CANDIDATES = 5
const MIN_SD_FRAC = 0.25 // ignore cells whose sd is below this fraction of σf: already known well enough
/** How quickly a farther candidate loses out to a nearer one: score · exp(−dist / PREFER_NEAR_M). */
export const PREFER_NEAR_M = 12
const GEO_MAX_M = 60 // walking distance beyond which a candidate is simply "far"

export function nextSampleCandidates(g: PassGrid, field: Field, prob: SourceProb | null, max = MAX_CANDIDATES): Candidate[] {
  if (field.sigmaF <= 0) return []
  const { cols, rows } = g
  const half = Math.max(1, Math.round(LATTICE_M / g.res / 2))
  const scored: { ci: number; score: number }[] = []
  for (const ci of lattice(g)) {
    // best cell in the lattice block, so a region isn't missed because its centre is a wall
    const c0 = ci % cols, r0 = (ci - c0) / cols
    let best = -1, bestScore = 0
    for (let r = r0 - half; r <= r0 + half; r++) for (let c = c0 - half; c <= c0 + half; c++) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue
      const j = r * cols + c
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
    kept.push({ x, y, r: half * g.res, score, sd: field.sd[ci], mean: field.mean[ci], geo: Float32Array.from(geodesic(g, ci, GEO_MAX_M)) })
    if (kept.length >= max) break
  }
  return kept
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
 * Pick the candidate worth walking to from where the wearer stands: the best score after
 * discounting by walking distance (through doors, not walls), so a slightly weaker
 * candidate next door beats a stronger one in the next room. Without a pose, or when the
 * wearer's cell is off the grid, the top-scored candidate.
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
    if (at >= 0) { const d = c.geo[at]; dist = Number.isFinite(d) ? d : GEO_MAX_M + dist }
    const v = c.score * (pose ? Math.exp(-dist / PREFER_NEAR_M) : 1)
    if (v > bestV) { bestV = v; best = { ...c, dist } }
  }
  return best
}

/** Compass direction from the wearer to a point, in map frame (x east, y north). */
export function bearing(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const a = Math.atan2(to.x - from.x, to.y - from.y) // 0 = north, clockwise
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[Math.round(((a + Math.PI * 2) / (Math.PI / 4))) % 8]
}
