import { useEffect, useRef, useState } from 'react'
import { LEVEL_LABEL, level, levelColor } from '../lib/colors'
import type { Dashboard } from '../lib/useDashboard'
import type { Alert, TrailPoint } from '../lib/types'

const fmt = (n: number) => n.toFixed(0)

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** The one number that matters, and what it means. */
export function Reading({ voc }: { voc: number | null }) {
  if (voc == null) return <div className="reading reading--empty"><span className="reading-value">—</span></div>
  const lv = level(voc)
  return (
    <div className={`reading reading--${lv}`} style={{ ['--level' as string]: `var(--${lv})` }}>
      <span className="reading-value">{fmt(voc)}</span>
      <span className="reading-label"><i className="dot" />{LEVEL_LABEL[lv]}</span>
    </div>
  )
}

/** Last 60 s of readings. */
export function Sparkline({ points, width = 220, height = 36 }: { points: [number, number][]; width?: number; height?: number }) {
  if (points.length < 2) return <svg className="sparkline" width={width} height={height} />
  const t1 = points[points.length - 1][0], t0 = t1 - 60_000
  const max = Math.max(300, ...points.map(([, v]) => v))
  const d = points
    .filter(([t]) => t >= t0)
    .map(([t, v], i) => `${i ? 'L' : 'M'}${(((t - t0) / 60_000) * width).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`)
    .join('')
  const last = points[points.length - 1][1]
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={d} fill="none" stroke={levelColor(last)} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** Shown only while an alert is recent. */
export function AlertBanner({ alerts, now, holdMs = 30_000, crew = 1 }: { alerts: Alert[]; now: number; holdMs?: number; crew?: number }) {
  const [dismissed, setDismissed] = useState<string | null>(null)
  const a = alerts[0]
  if (!a || a.ts === dismissed || now - Date.parse(a.ts) > holdMs) return null
  const ago = Math.max(0, Math.round((now - Date.parse(a.ts)) / 1000))
  return (
    <div className="alert-banner" role="alert" onClick={() => setDismissed(a.ts)}>
      <strong>High VOC{crew > 1 && a.wearer ? ` · ${a.wearer}` : ''}</strong>
      <span>VOC {fmt(a.voc)} at ({a.x.toFixed(1)}, {a.y.toFixed(1)}) m · {ago}s ago</span>
    </div>
  )
}

export function Status({ s }: { s: Dashboard }) {
  const state = s.until != null ? 'replay' : !s.connected ? 'offline' : s.kind === 'demo' ? 'demo' : !s.bridge ? 'nopi' : 'live'
  const text = { replay: 'Replay', offline: 'Reconnecting…', demo: 'Simulation', nopi: 'Waiting for device', live: 'Live' }[state]
  return <span className={`status status--${state}`}><i className="dot" />{text}</span>
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

/**
 * Session timeline. Drag to replay; release at the right edge to go live.
 * With `history`, it doubles as the session's VOC strip, with alerts as ticks.
 */
export function Timeline({ s, now, setUntil, history, alerts }: {
  s: Dashboard; now: number; setUntil: (t: number | null) => void; history?: TrailPoint[]; alerts?: Alert[]
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState(false)
  const start = s.started ?? now - 60_000
  const span = Math.max(1, now - start)
  const at = s.until ?? now
  const frac = Math.min(1, (at - start) / span)

  const fromEvent = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    setUntil(f > 0.985 ? null : start + f * span)
  }
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => fromEvent(e.clientX)
    const up = () => setDrag(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  })

  return (
    <div className={`timeline${history ? ' timeline--strip' : ''}`}>
      <div className="timeline-track" ref={ref} onPointerDown={(e) => { setDrag(true); fromEvent(e.clientX) }}>
        {history && <Strip points={history} start={start} span={span} />}
        {alerts?.map((a) => (
          <i key={a.ts} className="timeline-alert" style={{ left: `${((Date.parse(a.ts) - start) / span) * 100}%` }} />
        ))}
        <div className="timeline-fill" style={{ width: `${frac * 100}%` }} />
        <div className="timeline-handle" style={{ left: `${frac * 100}%` }} />
      </div>
      <div className="timeline-labels">
        <span>{clock(start)}</span>
        {s.until != null
          ? <button className="link" onClick={() => setUntil(null)}>{clock(at)} · back to live</button>
          : <span>Live</span>}
      </div>
    </div>
  )
}

function Strip({ points, start, span }: { points: TrailPoint[]; start: number; span: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current!
    const r = c.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr))
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, r.width, r.height)
    // one bar per pixel column: the max VOC in that slice of the session
    const cols = new Float32Array(Math.ceil(r.width))
    for (const p of points) {
      const i = Math.floor(((Date.parse(p.ts) - start) / span) * r.width)
      if (i >= 0 && i < cols.length) cols[i] = Math.max(cols[i], p.voc)
    }
    for (let i = 0; i < cols.length; i++) {
      if (!cols[i]) continue
      const hgt = Math.max(2, (Math.min(cols[i], 500) / 500) * r.height)
      g.fillStyle = levelColor(cols[i])
      g.fillRect(i, r.height - hgt, 1, hgt)
    }
  })
  return <canvas ref={ref} className="timeline-strip" />
}

export function SummaryButton({ s, load }: { s: Dashboard; load: (force?: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="summary">
      <button className="ghost" onClick={() => { setOpen(!open); if (!open && !s.summary) load() }}>
        Summary
      </button>
      {open && (
        <div className="summary-pop">
          {s.summaryLoading && !s.summary ? <p className="muted">Writing summary…</p> : <p>{s.summary?.text ?? 'No summary yet.'}</p>}
          <div className="summary-foot">
            <span className="muted">{s.summary?.source === 'gemini' ? '✦ Gemini' : 'Auto summary'}</span>
            <button className="link" onClick={() => load(true)} disabled={s.summaryLoading}>
              {s.summaryLoading ? 'Updating…' : 'Regenerate'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function Waiting({ s }: { s: Dashboard }) {
  if (s.meta) return null
  return <div className="waiting">{s.connected ? 'Waiting for the first scan…' : 'Connecting…'}</div>
}

const deg = (r: number) => `${Math.round((r * 180) / Math.PI)}°`

/** Roll / pitch / yaw of the selected wearer, one quiet line. Roll and pitch need an IMU. */
export function Attitude({ pose }: { pose: Dashboard['pose'] }) {
  if (!pose) return null
  const yaw = ((pose.heading * 180) / Math.PI + 360) % 360
  return (
    <span className="attitude mono" title="Roll · pitch · yaw (heading)">
      {pose.roll != null && <>R {deg(pose.roll)} · </>}
      {pose.pitch != null && <>P {deg(pose.pitch)} · </>}
      Y {Math.round(yaw)}°
    </span>
  )
}

/** Pick whose reading to show (only when there's more than one wearer). */
export function Crew({ s, select, colors }: { s: Dashboard; select: (id: string) => void; colors: string[] }) {
  if (s.crew.length < 2) return null
  return (
    <div className="crew" role="group" aria-label="Firefighter">
      {s.crew.map((id, i) => {
        const v = s.wearers[id]?.voc
        return (
          <button key={id} className={id === s.selected ? 'on' : ''} onClick={() => select(id)} title={`Firefighter ${id}`}>
            <i style={{ background: colors[i % colors.length] }} />{id}
            {v != null && <span className="mono" style={{ color: levelColor(v) }}>{v.toFixed(0)}</span>}
          </button>
        )
      })}
    </div>
  )
}
