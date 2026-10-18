import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { RAMP_BANDS, SCALE, levelRanges, rampGradient } from '../lib/colors'
import { HORIZONS } from '../lib/forecast'
import MapView from './MapView'
import { insets, type MapProps } from './types'

const Map3D = lazy(() => import('./Map3D'))

type Mode = '2d' | '3d' | 'fp'
const MODES: { m: Mode; label: string }[] = [{ m: '2d', label: '2D' }, { m: '3d', label: '3D' }, { m: 'fp', label: 'First person' }]

function savedMode(): Mode {
  const ok = (v: string | null): v is Mode => v === '2d' || v === '3d' || v === 'fp'
  const q = new URLSearchParams(location.search).get('view')
  if (ok(q)) return q
  try { const v = localStorage.getItem('mapMode'); return ok(v) ? v : '2d' } catch { return '2d' }
}

const LEGEND = [
  { key: 'good', label: 'Good' },
  { key: 'moderate', label: 'Moderate' },
  { key: 'poor', label: 'Poor' },
  { key: 'alert', label: 'Hazardous' },
] as const

/** The map, a 2D/3D switch, a Recenter button when the view has moved, and the legend. */
export default function MapStage(props: MapProps & { legend?: boolean }) {
  const [mode, setMode] = useState<Mode>(savedMode)
  const [moved, setMoved] = useState(false)
  const [recenter, setRecenter] = useState(0)
  const doRecenter = useCallback(() => setRecenter((n) => n + 1), [])
  const onMoved = useCallback((m: boolean) => setMoved(m), [])

  useEffect(() => {
    try { localStorage.setItem('mapMode', mode) } catch { /* ignore */ }
  }, [mode])

  // C or 0: recenter · V: 2D → 3D → first person
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.target instanceof HTMLInputElement) return
      const k = e.key.toLowerCase()
      if (k === 'c' || k === '0') doRecenter()
      else if (k === 'v') { setMode((m) => MODES[(MODES.findIndex((x) => x.m === m) + 1) % MODES.length].m); setMoved(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doRecenter])

  const [horizon, setHorizon] = useState<number | null>(null)
  const gas = props.showHeat ? props.gas ?? null : null
  const model = gas?.source ?? null
  const ins = insets(props.inset)
  const r = { ...props, recenter, onMoved, model, gas, horizon: mode === '2d' ? horizon : null }
  return (
    <>
      {mode === '2d' ? <MapView {...r} /> : <Suspense fallback={null}><Map3D {...r} firstPerson={mode === 'fp'} /></Suspense>}

      <div className="map-ctrl" style={{ right: ins.right + 16, bottom: ins.bottom + 16 }}>
        {moved && (!props.follow || mode === 'fp') && (
          <button className="map-btn recenter" onClick={doRecenter} title="Recenter (C)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="1.4" fill="currentColor" />
              <path d="M8 0v3M8 13v3M0 8h3M13 8h3" />
            </svg>
            {mode === 'fp' ? 'Look ahead' : 'Recenter'}
          </button>
        )}
        {mode === '2d' && gas?.forecast && (
          <div className="map-seg" role="group" aria-label="Forecast" title="Projected spread by diffusion through the mapped floor plan (no airflow model)">
            <button className={horizon == null ? 'on' : ''} onClick={() => setHorizon(null)}>Now</button>
            {HORIZONS.map((h) => (
              <button key={h} className={horizon === h ? 'on' : ''} onClick={() => setHorizon(h)}>+{h / 60} min</button>
            ))}
          </div>
        )}
        <div className="map-seg" role="group" aria-label="View">
          {MODES.map(({ m, label }) => (
            <button key={m} className={m === mode ? 'on' : ''} onClick={() => { setMode(m); setMoved(false) }}
                    title="Switch view (V)">{label}</button>
          ))}
        </div>
      </div>

      {props.legend !== false && (
        <div className="legend" style={{ left: ins.left + 16, bottom: ins.bottom + 16 }} title={SCALE.label}>
          <div className="legend-ramp" style={{ background: rampGradient() }}>
            {RAMP_BANDS.slice(1).map((t) => <i key={t} style={{ left: `${t * 100}%` }} />)}
          </div>
          <div className="legend-bands">
            {LEGEND.map((l, i) => {
              const w = ((RAMP_BANDS[i + 1] ?? 1) - RAMP_BANDS[i]) * 100
              return <span key={l.key} style={{ width: `${w}%` }} title={`${SCALE.label} ${levelRanges()[l.key]}`}>{l.label}</span>
            })}
          </div>
          <span className="legend-note">{mode === '2d' ? 'Striped = predicted · dotted ring = sample next' : 'Faint floor & gas cloud = predicted · dotted ring = sample next'}</span>
        </div>
      )}
    </>
  )
}
