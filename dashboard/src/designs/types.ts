import type { Dashboard } from '../lib/useDashboard'

export type ViewOptions = { follow: boolean; showHeat: boolean; showTrail: boolean }

export type DesignProps = {
  s: Dashboard
  setUntil: (t: number | null) => void
  loadSummary: (force?: boolean) => void
  view: ViewOptions
}
