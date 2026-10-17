// Paper: light and editorial, for projectors and daylight. A narrow column reads
// top to bottom (reading, then alerts, then summary); the map sits beside it.
import { useEffect } from 'react'
import MapStage from '../map/MapStage'
import { THEMES } from '../map/theme'
import { AlertBanner, Attitude, Crew, Reading, Sparkline, Status, Timeline, Waiting, useNow } from '../ui/parts'
import type { DesignProps } from './types'

const time = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export default function Paper({ s, setUntil, loadSummary, view, select }: DesignProps) {
  const now = useNow()
  useEffect(() => { if (s.session && !s.summary) loadSummary() }, [s.session, s.summary, loadSummary])
  return (
    <div className="design d-paper">
      <aside className="p-side">
        <div className="p-head">
          <span className="brand">Hazard Map</span>
          <Status s={s} />
        </div>

        <section>
          <span className="caption">VOC index</span>
          <Reading voc={s.voc} />
          <Sparkline points={s.window} width={268} height={40} />
          <Attitude pose={s.pose} />
          <Crew s={s} select={select} colors={THEMES.paper.crew} />
        </section>

        {s.alerts.length > 0 && (
          <section>
            <span className="caption">Alerts</span>
            <ul className="p-alerts">
              {s.alerts.slice(0, 3).map((a) => (
                <li key={a.ts}>
                  <span className="mono">{time(a.ts)}{s.crew.length > 1 && a.wearer ? ` ${a.wearer}` : ''}</span>
                  <span>VOC {a.voc.toFixed(0)}</span>
                  <span className="muted">({a.x.toFixed(1)}, {a.y.toFixed(1)})</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="p-summary">
          <span className="caption">Summary</span>
          <p>{s.summary?.text ?? (s.summaryLoading ? 'Writing summary…' : 'No summary yet.')}</p>
          <button className="link" onClick={() => loadSummary(true)} disabled={s.summaryLoading}>
            {s.summaryLoading ? 'Updating…' : 'Regenerate'}
          </button>
        </section>
      </aside>

      <main className="p-main">
        <div className="p-map">
          <MapStage theme={THEMES.paper} meta={s.meta} image={s.image} heat={s.heat} trail={s.trail} pose={s.pose} poses={s.poses} selected={s.selected!}
                   alerts={s.alerts} threshold={s.threshold} {...view} />
          <Waiting s={s} />
          <AlertBanner alerts={s.alerts} now={now} crew={s.crew.length} />
        </div>
        <Timeline s={s} now={now} setUntil={setUntil} />
      </main>
    </div>
  )
}
