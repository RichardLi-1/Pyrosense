import type { GasModel } from '../lib/gasModel'
import type { Dashboard } from '../lib/useDashboard'
import type { Layers } from '../map/layers'
import type { ScanActions } from '../ui/scans'

export type ViewOptions = { follow: boolean; layers: Layers; only: string | null } // only: show just this responder

export type DesignProps = {
  s: Dashboard
  setUntil: (t: number | null) => void
  loadSummary: (force?: boolean) => void
  select: (wearer: string) => void
  view: ViewOptions
  setView: (f: (v: ViewOptions) => ViewOptions) => void
  gas: GasModel | null
  setSource: (kind: 'live' | 'demo') => void // Simulation / Real toggle
  scans: ScanActions
  markWarningsRead: () => void
}
