// Dusk: calm and dark. The map fills the screen; one bar along the bottom holds the
// reading and a timeline that is also the walk's VOC history (alerts are red ticks).
import MapView from '../map/MapView'
import { THEMES } from '../map/theme'
import { AlertBanner, Reading, Status, SummaryButton, Timeline, Waiting, useNow } from '../ui/parts'
import type { DesignProps } from './types'

export default function Dusk({ s, setUntil, loadSummary, view }: DesignProps) {
  const now = useNow()
  return (
    <div className="design d-dusk">
      <div className="k-map">
        <MapView theme={THEMES.dusk} meta={s.meta} image={s.image} heat={s.heat} trail={s.trail} pose={s.pose}
                 alerts={s.alerts} {...view} />
        <Waiting s={s} />
        <AlertBanner alerts={s.alerts} now={now} />
      </div>
      <footer className="k-bar">
        <Reading voc={s.voc} />
        <Timeline s={s} now={now} setUntil={setUntil} history={s.history} alerts={s.alerts} />
        <div className="k-end"><Status s={s} /><SummaryButton s={s} load={loadSummary} /></div>
      </footer>
    </div>
  )
}
