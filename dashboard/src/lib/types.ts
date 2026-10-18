// Shapes of the backend's /ws/live events and REST responses (backend/README.md).

/** heading = yaw; roll/pitch (radians) only when the wearer's IMU reports them. `wearer` defaults to 'A'. */
export type Pose = { ts: string; x: number; y: number; heading: number; roll?: number; pitch?: number; voc: number | null; wearer?: string }

export type MapMeta = {
  url: string
  version: number
  origin: [number, number]
  res: number
  w: number
  h: number
  free_area_m2: number
  ts: string
}

export type Alert = { id: number | null; ts: string; x: number; y: number; voc: number; threshold?: number; wearer?: string }

/** Raw frame from the gas sensor (SGP30): TVOC plus the values the chip reports alongside it. */
export type Sensor = {
  ts: string; voc: number | null; unit: VocUnit; eco2: number | null; raw_h2: number | null; raw_ethanol: number | null
  temperature: number | null; humidity: number | null; warmed_up: boolean
}
export type VocUnit = 'ppb' | 'index'

export type LiveEvent =
  | { t: 'hello'; session: string; started: string; threshold: number; unit?: VocUnit; sensor?: Sensor | null;
      bridge_connected: boolean; n_samples: number; voc_window: [number, number][]; wearers?: string[] }
  | ({ t: 'sensor' } & Sensor)
  | ({ t: 'map' } & MapMeta)
  | ({ t: 'pose' } & Pose)
  | { t: 'voc'; ts: string; voc: number; n_new: number; x: number; y: number; wearer?: string }
  | ({ t: 'alert'; map_png_url: string | null } & Alert)
  | { t: 'bridge'; connected: boolean }

export type HeatCell = { cx: number; cy: number; mean: number; weight: number; sd: number; n: number }
export type TrailPoint = { ts: string; x: number; y: number; heading: number | null; voc: number; wearer?: string }

export const DEFAULT_WEARER = 'A'
/** Radio call sign for a wearer: FF-1, FF-2… in crew order (the raw id when it isn't on the crew list). */
export const responderLabel = (crew: string[], id: string) => { const i = crew.indexOf(id); return i >= 0 ? `FF-${i + 1}` : id }
export type Summary = { text: string; source: 'gemini' | 'fallback' }

/** Where the dashboard's data comes from: the backend, or the in-browser demo. */
export interface DataSource {
  readonly kind: 'live' | 'demo'
  connect(onEvent: (e: LiveEvent) => void, onStatus: (open: boolean) => void): () => void
  heatmap(until: number | null): Promise<HeatCell[]>
  trail(until: number | null): Promise<TrailPoint[]>
  alerts(): Promise<Alert[]>
  summary(force: boolean): Promise<Summary>
  mapImage(meta: MapMeta): Promise<CanvasImageSource>
}

export const CELL_SIZE = 0.2 // metres, matches voc_cells in db/schema.sql
