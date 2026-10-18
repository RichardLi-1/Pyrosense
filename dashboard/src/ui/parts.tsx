import { useEffect, useRef, useState } from 'react'
import { LEVEL_LABEL, SCALE, level, levelColor } from '../lib/colors'
import type { Sensor } from '../lib/types'
import { bearing, chooseNext } from '../lib/nextSample'
import type { GasModel } from '../lib/gasModel'
import { sampleAt } from '../lib/gasModel'
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
  const t1 = points[points.length - 1][0], t0 = Math.max(points[0][0], t1 - 60_000), span = Math.max(1000, t1 - t0)
  const max = Math.max(SCALE.max * 0.1, ...points.map(([, v]) => v))
  const d = points
    .filter(([t]) => t >= t0)
    .map(([t, v], i) => `${i ? 'L' : 'M'}${(((t - t0) / span) * width).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`)
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
      <span>VOC {fmt(a.voc)} {SCALE.short} at ({a.x.toFixed(1)}, {a.y.toFixed(1)}) m · {ago}s ago</span>
    </div>
  )
}

export function Status({ s }: { s: Dashboard }) {
  const state = s.until != null ? 'replay' : !s.connected ? 'offline' : s.kind === 'demo' ? 'demo' : !s.bridge ? 'nopi' : 'live'
  const text = { replay: 'Replay', offline: 'Reconnecting…', demo: 'Simulation', nopi: 'Waiting for device', live: 'Live' }[state]
  return <span className={`status status--${state}`}><i className="dot" />{text}</span>
}

/** Simulation / Real: which data feeds the dashboard. Real is the backend and the wearable. */
export function SourceToggle({ kind, setSource }: { kind: 'live' | 'demo'; setSource: (k: 'live' | 'demo') => void }) {
  return (
    <div className="map-seg source-toggle" role="group" aria-label="Data source">
      <button className={kind === 'demo' ? 'on' : ''} onClick={() => setSource('demo')} title="In-browser simulated walk">Simulation</button>
      <button className={kind === 'live' ? 'on' : ''} onClick={() => setSource('live')} title="Live backend and wearable">Real</button>
    </div>
  )
}

/** Shows the session scrubber; turning it off returns to live. */
export function PlaybackToggle({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  return (
    <button className={`map-btn playback${on ? ' on' : ''}`} onClick={() => set(!on)} aria-pressed={on} title="Scrub back through this session">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2.5 1.5v9l7.5-4.5z" /></svg>
      Playback
    </button>
  )
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
      const hgt = Math.max(2, (Math.min(cols[i], SCALE.max) / SCALE.max) * r.height)
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
/** Where the wearer is on the map (metres from the map origin) and which way they face. */
export function Attitude({ pose }: { pose: Dashboard['pose'] }) {
  if (!pose) return null
  const yaw = ((pose.heading * 180) / Math.PI + 360) % 360
  const m = (v: number) => `${v < 0 ? '\u2212' : ''}${Math.abs(v).toFixed(1)} m`
  return (
    <span className="attitude mono" title="Position on the map (metres from origin) · heading">
      X {m(pose.x)} · Y {m(pose.y)} · {Math.round(yaw)}°
      {pose.roll != null && <> · R {deg(pose.roll)}</>}
      {pose.pitch != null && <> · P {deg(pose.pitch)}</>}
    </span>
  )
}

/**
 * Everything else the gas sensor reports. eCO2 is the SGP30's estimate from its H2 channel, not a CO2
 * measurement, and the raw signals are uncalibrated counts; shown for completeness, labelled as such.
 */
export function SensorPanel({ sensor }: { sensor: Sensor | null }) {
  if (!sensor) return null
  const n = (v: number | null, d = 0) => (v == null ? '—' : v.toFixed(d))
  const rows: [string, string, string][] = [
    ['eCO₂', n(sensor.eco2), 'ppm'],
    ['raw H₂', n(sensor.raw_h2), ''],
    ['raw EtOH', n(sensor.raw_ethanol), ''],
  ]
  if (sensor.temperature != null) rows.push(['temp', n(sensor.temperature, 1), '°C'])
  if (sensor.humidity != null) rows.push(['humidity', n(sensor.humidity, 0), '%'])
  return (
    <dl className="sensor" title="Secondary channels from the SGP30. eCO₂ is estimated from the H₂ signal, not measured.">
      {rows.map(([k, v, u]) => (
        <div key={k} className="sensor-row">
          <dt>{k}</dt>
          <dd className="mono">{v}<span className="sensor-unit">{u}</span></dd>
        </div>
      ))}
      {!sensor.warmed_up && <div className="sensor-row sensor-warm"><dt>sensor</dt><dd>warming up…</dd></div>}
    </dl>
  )
}

/**
 * Layer 4, what it means for the wearer: cumulative exposure this session (ppb·min, the
 * integral of the reading over time), from the forecast whether this spot is projected
 * to cross the alert threshold within five minutes, and where to sample next (GP variance).
 */
type OutlookNumbers = { dose: number | null; eta: number | null; peak: number | null; next: ReturnType<typeof chooseNext> | null }
function outlookNumbers(s: Dashboard, gas: GasModel | null): OutlookNumbers {
  const pts = s.history.filter((p) => (p.wearer ?? 'A') === s.selected)
  let dose = 0
  for (let i = 1; i < pts.length; i++) {
    const dt = (Date.parse(pts[i].ts) - Date.parse(pts[i - 1].ts)) / 60_000
    if (dt > 0 && dt < 2) dose += ((pts[i].voc + pts[i - 1].voc) / 2) * dt
  }
  let eta: number | null = null, peak: number | null = null
  const fc = gas?.forecast
  if (fc && s.pose && s.until == null) {
    for (let h = 0; h < fc.horizons.length; h++) {
      const v = sampleAt(fc, fc.mean[h], s.pose.x, s.pose.y)
      if (Number.isNaN(v)) continue
      peak = Math.max(peak ?? 0, v)
      if (v >= s.threshold && eta == null) eta = fc.horizons[h]
    }
  }
  const next = gas && s.until == null ? chooseNext(gas.next, s.pose, gas.field) : null
  return { dose: pts.length > 1 ? dose : null, eta, peak, next }
}

const kfmt = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0))

export function Outlook({ s, gas }: { s: Dashboard; gas: GasModel | null }) {
  const { dose, eta, peak, next: nx } = outlookNumbers(s, gas)
  if (dose == null && eta == null && !nx) return null
  const k = kfmt
  return (
    <dl className="sensor outlook" title="Exposure = reading integrated over time. Projection = diffusion forecast at this position.">
      {dose != null && <div className="sensor-row"><dt>exposure</dt><dd className="mono">{k(dose)}<span className="sensor-unit">{SCALE.short || 'idx'}·min</span></dd></div>}
      {eta != null
        ? <div className="sensor-row sensor-warn"><dt>projected</dt><dd>&gt; {SCALE.short ? `${s.threshold} ${SCALE.short}` : s.threshold} here in ≤{eta / 60} min</dd></div>
        : peak != null && <div className="sensor-row"><dt>projected</dt><dd className="mono">{peak.toFixed(0)}<span className="sensor-unit">{SCALE.short} in 5 min</span></dd></div>}
      {nx && <div className="sensor-row sensor-next" title="Where one more reading would most reduce the map's uncertainty (GP variance, weighted toward predicted-elevated areas)">
        <dt>sample next</dt>
        <dd className="mono">{s.pose ? <>{nx.dist.toFixed(0)}<span className="sensor-unit">m {bearing(s.pose, nx)}</span></> : <>({nx.x.toFixed(0)}, {nx.y.toFixed(0)})</>}</dd>
      </div>}
    </dl>
  )
}

function Tile({ caption, value, unit, title, tone }: { caption: string; value: string; unit?: string; title?: string; tone?: 'warn' | 'next' }) {
  return (
    <div className={`tile${tone ? ` tile--${tone}` : ''}`} title={title}>
      <span className="caption">{caption}</span>
      <span className="tile-value mono">{value}{unit && <span className="tile-unit">{unit}</span>}</span>
    </div>
  )
}

/**
 * The secondary channels as big live numbers under the hero reading: the SGP30's other
 * outputs (eCO₂, raw H₂, raw ethanol) and what the session adds up to (exposure, the
 * five-minute projection at this spot, where to sample next).
 */
export function SensorTiles({ s, gas }: { s: Dashboard; gas: GasModel | null }) {
  const sensor = s.sensor
  const { dose, eta, peak, next: nx } = outlookNumbers(s, gas)
  if (!sensor && dose == null && eta == null && !nx) return null
  const n = (v: number | null | undefined, d = 0) => (v == null ? '—' : v.toFixed(d))
  const unit = SCALE.short || 'idx'
  return (
    <div className="tiles">
      {sensor && <>
        <Tile caption="eCO₂ · ppm" value={n(sensor.eco2)} title="Estimated from the H₂ signal, not measured" />
        <Tile caption="Raw H₂" value={n(sensor.raw_h2)} />
        <Tile caption="Raw EtOH" value={n(sensor.raw_ethanol)} />
      </>}
      {dose != null && <Tile caption={`Exposure · ${unit}·min`} value={kfmt(dose)} title="Reading integrated over this session" />}
      {eta != null
        ? <Tile caption="Projected" value={`≤${eta / 60}`} unit="min to alert" tone="warn" title={`Forecast to pass ${s.threshold} here`} />
        : peak != null && <Tile caption="Projected" value={peak.toFixed(0)} unit="in 5 min" title="Diffusion forecast at this position" />}
      {nx && <Tile caption="Sample next" value={s.pose ? nx.dist.toFixed(0) : `${nx.x.toFixed(0)}, ${nx.y.toFixed(0)}`}
                   unit={s.pose ? `m ${bearing(s.pose, nx)}` : undefined} tone="next"
                   title="Where one more reading would most reduce the map's uncertainty" />}
      {sensor && (sensor.temperature != null || sensor.humidity != null || !sensor.warmed_up) && (
        <span className="tiles-note">
          {sensor.temperature != null && <>{sensor.temperature.toFixed(1)} °C</>}
          {sensor.temperature != null && sensor.humidity != null && <> · </>}
          {sensor.humidity != null && <>{sensor.humidity.toFixed(0)} % RH</>}
          {!sensor.warmed_up && <span className="tiles-warm"> · sensor warming up</span>}
        </span>
      )}
    </div>
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
