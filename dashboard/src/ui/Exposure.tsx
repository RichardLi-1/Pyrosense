// Exposure history: each responder's cumulative dose this session (reading integrated over
// time), one small chart per responder on a shared time axis and a shared scale, so the
// rows compare directly. Hover any row to read every responder at that moment.
import { useMemo, useRef, useState } from 'react'
import { SCALE, levelColor } from '../lib/colors'
import type { Dashboard } from '../lib/useDashboard'
import { DEFAULT_WEARER, responderLabel } from '../lib/types'

const W = 300, H = 44

type Row = {
  id: string
  label: string
  dose: [number, number][] // [ms, cumulative dose]
  peak: number
  overMin: number // minutes at or above the alert threshold
  alerts: number[] // ms
}

const kfmt = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0))
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

function rows(s: Dashboard): Row[] {
  const by = new Map<string, Dashboard['history']>()
  for (const p of s.history) {
    const id = p.wearer ?? DEFAULT_WEARER
    let l = by.get(id)
    if (!l) by.set(id, (l = []))
    l.push(p)
  }
  const ids = s.crew.length ? s.crew : [...by.keys()]
  return ids.map((id) => {
    const pts = by.get(id) ?? []
    const dose: [number, number][] = []
    let acc = 0, peak = 0, over = 0
    for (let i = 0; i < pts.length; i++) {
      const t = Date.parse(pts[i].ts)
      peak = Math.max(peak, pts[i].voc)
      if (i) {
        const dt = (t - Date.parse(pts[i - 1].ts)) / 60_000
        if (dt > 0 && dt < 2) {
          const v = (pts[i].voc + pts[i - 1].voc) / 2
          acc += v * dt
          if (v >= s.threshold) over += dt
        }
      }
      dose.push([t, acc])
    }
    const alerts = s.alerts.filter((a) => (a.wearer ?? DEFAULT_WEARER) === id).map((a) => Date.parse(a.ts))
    return { id, label: responderLabel(s.crew, id), dose, peak, overMin: over, alerts }
  })
}

/** Last value at or before t (series sorted by time). */
function at(series: [number, number][], t: number) {
  let lo = 0, hi = series.length - 1, v = 0
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (series[m][0] <= t) { v = series[m][1]; lo = m + 1 } else hi = m - 1
  }
  return v
}

export function ExposurePanel({ s, now, colors, pick, close }: {
  s: Dashboard; now: number; colors: string[]; pick: (id: string) => void; close: () => void
}) {
  const data = useMemo(() => rows(s), [s.history, s.alerts, s.crew, s.threshold]) // eslint-disable-line react-hooks/exhaustive-deps
  const t0 = s.started ?? Math.min(...data.map((r) => r.dose[0]?.[0] ?? now))
  const t1 = s.until ?? now
  const span = Math.max(1000, t1 - t0)
  const yMax = Math.max(1, ...data.map((r) => r.dose.at(-1)?.[1] ?? 0))
  const [hover, setHover] = useState<number | null>(null) // ms
  const box = useRef<HTMLDivElement>(null)
  const X = (t: number) => ((t - t0) / span) * W
  const Y = (v: number) => H - 2 - (v / yMax) * (H - 6)
  const unit = `${SCALE.short || 'idx'}·min`

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    setHover(t0 + f * span)
  }

  return (
    <aside className="exposure" ref={box} aria-label="Exposure history">
      <header>
        <div>
          <span className="caption">Exposure history</span>
          <small className="muted">{hover != null ? `at ${clock(hover)}` : `cumulative dose, ${unit} · shared scale`}</small>
        </div>
        <button className="annotate-x" onClick={close} aria-label="Close">×</button>
      </header>
      {data.length === 0 && <p className="muted exposure-empty">No readings yet.</p>}
      <ol>
        {data.map((r, i) => {
          const pts = r.dose.filter(([t]) => t <= t1)
          // one vertex per pixel column is plenty
          const step = Math.max(1, Math.floor(pts.length / W))
          const line = pts.filter((_, j) => j % step === 0 || j === pts.length - 1)
            .map(([t, v], j) => `${j ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('')
          const last = pts.at(-1)
          const area = last ? `${line}L${X(last[0]).toFixed(1)},${H}L${X(pts[0][0]).toFixed(1)},${H}Z` : ''
          const cur = hover != null ? at(pts, hover) : last?.[1] ?? 0
          const sel = r.id === s.selected
          return (
            <li key={r.id} className={sel ? 'on' : ''}>
              <button className="exposure-name" onClick={() => pick(r.id)} title={`Show ${r.label}`}>
                <i style={{ background: colors[i % colors.length] }} />{r.label}
              </button>
              <span className="exposure-dose mono">{kfmt(cur)}<small>{unit}</small></span>
              <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}
                   role="img" aria-label={`${r.label}: ${kfmt(last?.[1] ?? 0)} ${unit} so far`}>
                <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="exposure-base" />
                {area && <path d={area} className="exposure-area" />}
                {line && <path d={line} className="exposure-line" />}
                {r.alerts.filter((t) => t <= t1).map((t) => <rect key={t} x={X(t) - 1} y={H - 7} width="2" height="7" rx="1" className="exposure-alert" />)}
                {hover != null && <line x1={X(hover)} x2={X(hover)} y1="0" y2={H} className="exposure-cross" />}
                {hover != null && pts.length > 0 && <circle cx={X(Math.min(hover, last![0]))} cy={Y(cur)} r="3.5" className="exposure-dot" />}
              </svg>
              <span className="exposure-stats">
                <span>peak <b className="mono" style={{ color: r.peak ? levelColor(r.peak) : undefined }}>{r.peak.toFixed(0)}</b></span>
                <span>over limit <b className="mono">{r.overMin.toFixed(1)}</b> min</span>
                <span>alerts <b className="mono">{r.alerts.length}</b></span>
              </span>
            </li>
          )
        })}
      </ol>
      <footer className="exposure-axis mono"><span>{clock(t0)}</span><span>{s.until != null ? clock(t1) : 'now'}</span></footer>
    </aside>
  )
}

/** Header toggle for the panel. */
export function ExposureToggle({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  return (
    <button className={`map-btn playback${on ? ' on' : ''}`} onClick={() => set(!on)} aria-pressed={on} title="Each responder's exposure this session">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
        <path d="M1.5 14.5h13" /><path d="M2 12 6 8l3 2.5L14 4" />
      </svg>
      Exposure
    </button>
  )
}
