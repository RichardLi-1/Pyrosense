// Focus: the map is the screen. One big reading floats over it; everything else is quiet.
import MapView from '../map/MapView'
import { THEMES } from '../map/theme'
import { AlertBanner, Reading, Sparkline, Status, SummaryButton, Timeline, Waiting, useNow } from '../ui/parts'
import type { DesignProps } from './types'

export default function Focus({ s, setUntil, loadSummary, view }: DesignProps) {
  const now = useNow()
  return (
    <div className="design d-focus">
      <MapView theme={THEMES.focus} meta={s.meta} image={s.image} heat={s.heat} trail={s.trail} pose={s.pose}
               alerts={s.alerts} {...view} inset={{ left: 280, top: 40, bottom: 70 }} />
      <Waiting s={s} />
      <header className="f-top">
        <span className="brand">Hazard Map</span>
        <div className="row"><Status s={s} /><SummaryButton s={s} load={loadSummary} /></div>
      </header>
      <section className="f-reading">
        <span className="caption">VOC index</span>
        <Reading voc={s.voc} />
        <Sparkline points={s.window} />
      </section>
      <AlertBanner alerts={s.alerts} now={now} />
      <footer className="f-bottom"><Timeline s={s} now={now} setUntil={setUntil} /></footer>
    </div>
  )
}
