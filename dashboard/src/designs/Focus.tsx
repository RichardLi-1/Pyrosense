// Focus: the map is the screen. One big reading floats over it; everything else is quiet.
import MapStage from '../map/MapStage'
import { THEMES } from '../map/theme'
import { AlertBanner, Attitude, Crew, Reading, Sparkline, Status, SummaryButton, Timeline, Waiting, useNow } from '../ui/parts'
import type { DesignProps } from './types'

export default function Focus({ s, setUntil, loadSummary, view, select }: DesignProps) {
  const now = useNow()
  return (
    <div className="design d-focus">
      <MapStage theme={THEMES.focus} meta={s.meta} image={s.image} heat={s.heat} trail={s.trail} pose={s.pose} poses={s.poses} selected={s.selected!}
               alerts={s.alerts} threshold={s.threshold} {...view} inset={{ left: 280, top: 40, bottom: 70 }} />
      <Waiting s={s} />
      <header className="f-top">
        <span className="brand">Hazard Map</span>
        <div className="row"><Status s={s} /><SummaryButton s={s} load={loadSummary} /></div>
      </header>
      <section className="f-reading">
        <span className="caption">VOC index</span>
        <Reading voc={s.voc} />
        <Sparkline points={s.window} />
        <Attitude pose={s.pose} />
        <Crew s={s} select={select} colors={THEMES.focus.crew} />
      </section>
      <AlertBanner alerts={s.alerts} now={now} crew={s.crew.length} />
      <footer className="f-bottom"><Timeline s={s} now={now} setUntil={setUntil} /></footer>
    </div>
  )
}
