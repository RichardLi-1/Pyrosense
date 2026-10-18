// Focus: the map is the screen. One big reading floats over it; everything else is quiet.
import MapStage from '../map/MapStage'
import { THEMES } from '../map/theme'
import { SCALE } from '../lib/colors'
import { AlertBanner, Attitude, Crew, Outlook, Reading, SensorPanel, Sparkline, Status, Timeline, Waiting, useNow } from '../ui/parts'
import type { DesignProps } from './types'

export default function Focus({ s, setUntil, view, select, gas }: DesignProps) {
  const now = useNow()
  return (
    <div className="design d-focus">
      <MapStage theme={THEMES.focus} meta={s.meta} image={s.image} heat={s.heat} trail={s.trail} pose={s.pose} poses={s.poses} selected={s.selected!}
               alerts={s.alerts} threshold={s.threshold} {...view} gas={gas} inset={{ left: 280, top: 40, bottom: 70 }} />
      <Waiting s={s} />
      <header className="f-top">
        <span className="brand">PyroSafe</span>
        <div className="row"><Status s={s} /></div>
      </header>
      <section className="f-reading">
        <span className="caption">{SCALE.label}</span>
        <Reading voc={s.voc} />
        <Sparkline points={s.window} />
        <Attitude pose={s.pose} />
        <SensorPanel sensor={s.sensor} />
        <Outlook s={s} gas={gas} />
        <Crew s={s} select={select} colors={THEMES.focus.crew} />
      </section>
      <AlertBanner alerts={s.alerts} now={now} crew={s.crew.length} />
      <footer className="f-bottom"><Timeline s={s} now={now} setUntil={setUntil} /></footer>
    </div>
  )
}
