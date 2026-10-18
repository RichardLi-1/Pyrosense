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
  | ({ t: 'warning' } & Warning)

/** A plain-language warning the backend speaks when a reading stays elevated. */
export type Warning = {
  id: string; ts: string; voc: number; unit: VocUnit; level: 'good' | 'moderate' | 'poor' | 'hazardous'
  x: number; y: number; text: string; source: 'gemini' | 'fallback'; audio_url: string | null; voice: 'elevenlabs' | 'browser'
}
export type WarningsResponse = { threshold: number; unit: VocUnit; voice: 'elevenlabs' | 'browser'; gemini: boolean; items: Warning[] }

export type HeatCell = { cx: number; cy: number; mean: number; weight: number; sd: number; n: number }
export type TrailPoint = { ts: string; x: number; y: number; heading: number | null; voc: number; wearer?: string }

export const DEFAULT_WEARER = 'A'
/** Radio call sign for a wearer: FF-1, FF-2… in crew order (the raw id when it isn't on the crew list). */
/** How a wearer is named on screen: nothing when there is only one, their short id (A, B, …) when there are several. */
export const responderLabel = (crew: string[], id: string) => (crew.length > 1 ? id : '')
export type Summary = { text: string; source: 'gemini' | 'fallback' }

/** A past (or the current) scan as the backend catalogs it: GET /sessions. */
export type ScanSession = {
  session: string
  name: string | null
  notes: string | null
  saved: boolean
  started: string
  ended: string | null
  n: number // readings
  map_png_url: string | null
  map: { origin: [number, number]; res: number; w: number; h: number } | null
}
export type RestartResult = { session: string; previous: string | null; previous_saved: boolean; pi: { url: string; ok: boolean; error: string | null } }
export type SaveResult = { session: string; name: string | null; saved: boolean; has_map: boolean }

/** Where the dashboard's data comes from: the backend, or the in-browser demo. */
export interface DataSource {
  readonly kind: 'live' | 'demo'
  connect(onEvent: (e: LiveEvent) => void, onStatus: (open: boolean) => void): () => void
  /** `session` selects a past scan; omitted = the live one. */
  heatmap(until: number | null, session?: string): Promise<HeatCell[]>
  trail(until: number | null, session?: string): Promise<TrailPoint[]>
  alerts(session?: string): Promise<Alert[]>
  summary(force: boolean): Promise<Summary>
  /** The floor plan: for the live map from its meta, or any map PNG by url. */
  mapImage(meta: MapMeta | { url: string }): Promise<CanvasImageSource>
  /** Scan catalog; only the backend has one. */
  sessions?(): Promise<ScanSession[]>
  restart?(name?: string): Promise<RestartResult>
  save?(name?: string, notes?: string): Promise<SaveResult>
  /** Spoken warnings so far, newest first. */
  warnings?(): Promise<WarningsResponse>
}

export const CELL_SIZE = 0.2 // metres, matches voc_cells in db/schema.sql
