import type { GasModel } from '../lib/gasModel'
import type { SourceModel } from '../lib/sourceModel'
import type { Alert, HeatCell, MapMeta, Pose, TrailPoint } from '../lib/types'
import type { MapTheme } from './theme'

export type Inset = { top?: number; right?: number; bottom?: number; left?: number }

export type MapProps = {
  theme: MapTheme
  meta: MapMeta | null
  image: CanvasImageSource | null
  heat: HeatCell[]
  trail: TrailPoint[]
  pose: Pose | null // selected wearer
  poses: { id: string; pose: Pose }[] // everyone
  selected: string
  alerts: Alert[]
  threshold?: number
  voc?: number | null // current (or replayed) reading, for the marker on the colour scale
  follow: boolean
  showHeat: boolean
  showTrail: boolean
  /** Screen-space insets (px) the camera keeps clear for overlaid UI. */
  inset?: Inset
  /** The gas model (field, source posterior, forecast, next-sample candidates), computed once at the top level. */
  gas?: GasModel | null
}

/** What MapStage adds for the 2D/3D renderers. */
export type RendererProps = MapProps & {
  model: SourceModel | null // predicted VOC beyond what's sensed
  horizon: number | null // seconds ahead to show the forecast for, null = now
  recenter: number // bump to animate back to the default view
  onMoved: (moved: boolean) => void
}

export const TRAIL_S = 90 // seconds of trail shown, fading with age
export const insets = (i?: Inset) => ({ top: 0, right: 0, bottom: 0, left: 0, ...i })

/** Badge colour for a wearer: the theme's single badge colour when alone, else per-crew. */
export const crewColor = (crew: string[], single: string, poses: { id: string }[], id: string) =>
  poses.length <= 1 ? single : crew[Math.max(0, poses.findIndex((p) => p.id === id)) % crew.length]

export type Box = { x0: number; y0: number; x1: number; y1: number } // metres

/**
 * What has actually been mapped: the bounding box of SOLID free space (a free cell whose 5x5
 * neighbourhood is at least 60% free, which keeps rooms and corridors and drops the thin
 * ray-traced spokes a stationary LiDAR leaves), widened by occupied cells within `near`
 * metres of that box (walls, not stray specks), plus `pad`. Falls back to any free cell,
 * then any known cell, then the whole grid, so the camera always has something to frame.
 */
export function knownBounds(alpha: (i: number) => number, m: MapMeta, pad = 0.5, near = 1): Box {
  const W = m.w, H = m.h
  // integral image of free cells, so each 5x5 window is four lookups
  const S = new Int32Array((W + 1) * (H + 1))
  let kc0 = Infinity, kr0 = Infinity, kc1 = -Infinity, kr1 = -Infinity // any known
  let anyFree = false
  for (let r = 0; r < H; r++) {
    let row = 0
    for (let c = 0; c < W; c++) {
      const a = alpha(r * W + c)
      const free = a > 240 ? 1 : 0
      if (free) anyFree = true
      if (a !== 0) { if (c < kc0) kc0 = c; if (c > kc1) kc1 = c; if (r < kr0) kr0 = r; if (r > kr1) kr1 = r }
      row += free
      S[(r + 1) * (W + 1) + (c + 1)] = S[r * (W + 1) + (c + 1)] + row
    }
  }
  const top = m.origin[1] + m.h * m.res
  const box = (c0: number, r0: number, c1: number, r1: number, p: number): Box => ({
    x0: m.origin[0] + c0 * m.res - p, x1: m.origin[0] + (c1 + 1) * m.res + p,
    y0: top - (r1 + 1) * m.res - p, y1: top - r0 * m.res + p, // PNG row 0 is the north edge
  })
  if (kc0 === Infinity) return { x0: m.origin[0], y0: m.origin[1], x1: m.origin[0] + m.w * m.res, y1: top }
  if (!anyFree) return box(kc0, kr0, kc1, kr1, pad)
  const sum = (c0: number, r0: number, c1: number, r1: number) => // inclusive cell ranges, clamped
    S[(r1 + 1) * (W + 1) + (c1 + 1)] - S[r0 * (W + 1) + (c1 + 1)] - S[(r1 + 1) * (W + 1) + c0] + S[r0 * (W + 1) + c0]
  let fc0 = Infinity, fr0 = Infinity, fc1 = -Infinity, fr1 = -Infinity // solid free
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (alpha(r * W + c) <= 240) continue
    const a0 = Math.max(0, c - 2), a1 = Math.min(W - 1, c + 2), b0 = Math.max(0, r - 2), b1 = Math.min(H - 1, r + 2)
    const n = (a1 - a0 + 1) * (b1 - b0 + 1)
    if (sum(a0, b0, a1, b1) < 0.6 * n) continue
    if (c < fc0) fc0 = c; if (c > fc1) fc1 = c; if (r < fr0) fr0 = r; if (r > fr1) fr1 = r
  }
  if (fc0 === Infinity) { // only thin rays so far: fall back to every free cell
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      if (alpha(r * W + c) <= 240) continue
      if (c < fc0) fc0 = c; if (c > fc1) fc1 = c; if (r < fr0) fr0 = r; if (r > fr1) fr1 = r
    }
  }
  // occupied cells within `near` of the free box pull it outward (walls); anything farther is ignored
  const nn = Math.ceil(near / m.res)
  let c0 = fc0, r0 = fr0, c1 = fc1, r1 = fr1
  for (let r = Math.max(0, fr0 - nn); r <= Math.min(H - 1, fr1 + nn); r++) for (let c = Math.max(0, fc0 - nn); c <= Math.min(W - 1, fc1 + nn); c++) {
    const a = alpha(r * W + c)
    if (a === 0 || a > 240) continue
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r
  }
  return box(c0, r0, c1, r1, pad)
}

/** `box` grown to include the given points (wearers), so nobody is framed out. */
export function growBox(b: Box, pts: { x: number; y: number }[], pad = 0.5): Box {
  const o = { ...b }
  for (const p of pts) {
    o.x0 = Math.min(o.x0, p.x - pad); o.x1 = Math.max(o.x1, p.x + pad)
    o.y0 = Math.min(o.y0, p.y - pad); o.y1 = Math.max(o.y1, p.y + pad)
  }
  return o
}
