// Dusk: calm and dark. The map fills the screen; one bar along the bottom holds the
// reading and a timeline that is also the walk's VOC history (alerts are red ticks).
import MapStage from '../map/MapStage'
import { THEMES } from '../map/theme'
import { AlertBanner, Attitude, Crew, Reading, Status, SummaryButton, Timeline, Waiting, useNow } from '../ui/parts'
import type { DesignProps } from './types'

export default function Dusk({ s, setUntil, loadSummary, view, select }: DesignProps) {
  const now = useNow()
  return (
    <div className="design d-dusk">
      <div className="k-map">
        <MapStage theme={THEMES.dusk} meta={s.meta} image={s.image} heat={s.heat} trail={s.trail} pose={s.pose} poses={s.poses} selected={s.selected!}
                 alerts={s.alerts} threshold={s.threshold} {...view} />
        <Waiting s={s} />
        <AlertBanner alerts={s.alerts} now={now} crew={s.crew.length} />
      </div>
      <footer className="k-bar">
        <div className="k-start"><Reading voc={s.voc} /><Attitude pose={s.pose} /></div>
        <Timeline s={s} now={now} setUntil={setUntil} history={s.history} alerts={s.alerts} />
        <div className="k-end"><Crew s={s} select={select} colors={THEMES.dusk.crew} /><Status s={s} /><SummaryButton s={s} load={loadSummary} /></div>
      </footer>
    </div>
  )
}
