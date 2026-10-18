import type { GasModel } from '../lib/gasModel'
import type { SourceModel } from '../lib/sourceModel'
import type { Mark } from '../lib/marks'
import type { Alert, HeatCell, MapMeta, Pose, TrailPoint } from '../lib/types'
import type { Layers } from './layers'
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
  follow: boolean // camera tracks the selected wearer
  layers: Layers
  only: string | null // show just this wearer (others dimmed), null = everyone
  crew: string[] // for FF-n labels
  marks: Mark[]
  /** Set while placing an annotation: a click on the map reports the world point (metres). */
  onPick?: ((x: number, y: number) => void) | null
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
 * What has actually been mapped: the bounding box of FREE cells (alpha 255 in the map PNG),
 * widened by occupied cells that sit within `near` metres of that box (room walls, not stray
 * LiDAR specks far away), plus `pad`. Falls back to all known cells, then to the whole grid,
 * so the camera always has something to frame.
 */
export function knownBounds(alpha: (i: number) => number, m: MapMeta, pad = 0.5, near = 1): Box {
  let fc0 = Infinity, fr0 = Infinity, fc1 = -Infinity, fr1 = -Infinity // free
  let kc0 = Infinity, kr0 = Infinity, kc1 = -Infinity, kr1 = -Infinity // any known
  for (let r = 0; r < m.h; r++) for (let c = 0; c < m.w; c++) {
    const a = alpha(r * m.w + c)
    if (a === 0) continue
    if (c < kc0) kc0 = c; if (c > kc1) kc1 = c; if (r < kr0) kr0 = r; if (r > kr1) kr1 = r
    if (a > 240) { if (c < fc0) fc0 = c; if (c > fc1) fc1 = c; if (r < fr0) fr0 = r; if (r > fr1) fr1 = r }
  }
  const top = m.origin[1] + m.h * m.res
  const box = (c0: number, r0: number, c1: number, r1: number, p: number): Box => ({
    x0: m.origin[0] + c0 * m.res - p, x1: m.origin[0] + (c1 + 1) * m.res + p,
    y0: top - (r1 + 1) * m.res - p, y1: top - r0 * m.res + p, // PNG row 0 is the north edge
  })
  if (kc0 === Infinity) return { x0: m.origin[0], y0: m.origin[1], x1: m.origin[0] + m.w * m.res, y1: top }
  if (fc0 === Infinity) return box(kc0, kr0, kc1, kr1, pad)
  // occupied cells within `near` of the free box pull it outward (walls); anything farther is ignored
  const n = Math.ceil(near / m.res)
  let c0 = fc0, r0 = fr0, c1 = fc1, r1 = fr1
  for (let r = Math.max(0, fr0 - n); r <= Math.min(m.h - 1, fr1 + n); r++) for (let c = Math.max(0, fc0 - n); c <= Math.min(m.w - 1, fc1 + n); c++) {
    const a = alpha(r * m.w + c)
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
