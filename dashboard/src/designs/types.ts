import type { GasModel } from '../lib/gasModel'
import type { Dashboard } from '../lib/useDashboard'

export type ViewOptions = { follow: boolean; showHeat: boolean; showTrail: boolean }

export type DesignProps = {
  s: Dashboard
  setUntil: (t: number | null) => void
  loadSummary: (force?: boolean) => void
  select: (wearer: string) => void
  view: ViewOptions
  gas: GasModel | null
}
