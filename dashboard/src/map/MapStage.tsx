import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { BAND_RGB } from '../lib/heatImage'
import { useSourceModel } from '../lib/useSourceModel'
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
  { key: 'good', label: 'Good', range: '<100' },
  { key: 'moderate', label: 'Moderate', range: '100–249' },
  { key: 'poor', label: 'Poor', range: '250–399' },
  { key: 'alert', label: 'Hazardous', range: '400+' },
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

  const model = useSourceModel(props.meta, props.image, props.heat, props.showHeat)
  const ins = insets(props.inset)
  const r = { ...props, recenter, onMoved, model }
  return (
    <>
      {mode === '2d' ? <MapView {...r} /> : <Suspense fallback={null}><Map3D {...r} firstPerson={mode === 'fp'} /></Suspense>}

      <div className="map-ctrl" style={{ right: ins.right + 16, bottom: ins.bottom + 16 }}>
        {moved && (!props.follow || mode === 'fp') && (
          <button className="map-btn recenter" onClick={doRecenter} title="Recenter (C)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="1.4" fill="currentColor" />
              <path d="M8 0v3M8 13v3M0 8h3M13 8h3" />
            </svg>
            {mode === 'fp' ? 'Look ahead' : 'Recenter'}
          </button>
        )}
        <div className="map-seg" role="group" aria-label="View">
          {MODES.map(({ m, label }) => (
            <button key={m} className={m === mode ? 'on' : ''} onClick={() => { setMode(m); setMoved(false) }}
                    title="Switch view (V)">{label}</button>
          ))}
        </div>
      </div>

      {props.legend !== false && (
        <div className="legend" style={{ left: ins.left + 16, bottom: ins.bottom + 16 }}>
          {LEGEND.map((l) => (
            <span key={l.key} title={`VOC index ${l.range}`}>
              <i style={{ background: `rgb(${BAND_RGB[l.key].join(',')})` }} />{l.label}
            </span>
          ))}
          <span className="legend-note">{mode === '2d' ? 'Striped = predicted' : 'Faint floor & gas cloud = predicted'}</span>
        </div>
      )}
    </>
  )
}
