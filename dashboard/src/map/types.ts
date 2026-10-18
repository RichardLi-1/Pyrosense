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
