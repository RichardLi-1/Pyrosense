import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { RAMP_BANDS, SCALE, levelRanges, rampGradient, rampT } from '../lib/colors'
import { responderLabel } from '../lib/types'
import { LAYERS, type LayerKey, type Layers } from './layers'
import Compass from '../ui/Compass'
import MapView from './MapView'
import type { MapProps } from './types'

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

/** Switches for what the map draws. */
function LayersMenu({ layers, set }: { layers: Layers; set: (k: LayerKey, on: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc) }
  }, [open])
  const off = LAYERS.filter((l) => !layers[l.key]).length
  return (
    <div className="layers" ref={ref}>
      <button className={`map-btn${open ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} title="Choose what the map shows">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M8 2 1.5 5.5 8 9l6.5-3.5Z" /><path d="m1.5 8.5 6.5 3.5 6.5-3.5" /><path d="m1.5 11.2 6.5 3.3 6.5-3.3" opacity=".55" />
        </svg>
        Layers{off > 0 && <span className="layers-count mono">{LAYERS.length - off}/{LAYERS.length}</span>}
      </button>
      {open && (
        <div className="layers-pop" role="group" aria-label="Map layers">
          {LAYERS.map((l) => (
            <label key={l.key} className="switch-row" title={l.hint}>
              <span className="switch-text"><span>{l.label}</span><small>{l.hint}</small></span>
              <kbd>{l.shortcut}</kbd>
              <input type="checkbox" role="switch" checked={layers[l.key]} onChange={(e) => set(l.key, e.target.checked)} />
              <i className="switch" aria-hidden />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

type StageProps = MapProps & {
  legend?: boolean
  setLayer?: (k: LayerKey, on: boolean) => void
  setFollow?: (on: boolean) => void
}

/** The map, a 2D/3D switch, layer switches, Follow, a Recenter button when the view has moved, and the legend. */
export default function MapStage(props: StageProps) {
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

  const gas = props.gas ?? null
  const model = gas?.source ?? null
  const r = { ...props, recenter, onMoved, model, gas, horizon: null }
  return (
    <>
      {mode === '2d' ? <MapView {...r} /> : <Suspense fallback={null}><Map3D {...r} firstPerson={mode === 'fp'} /></Suspense>}
      {mode === '2d' && <Compass className="compass-2d" />}

      <div className="map-bar" style={{ left: 28, right: 28, bottom: 0 }}>
        <div className="map-ctrl">
        {moved && (!props.follow || mode === 'fp') && (
          <button className="map-btn recenter" onClick={doRecenter} title="Recenter (C)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="1.4" fill="currentColor" />
              <path d="M8 0v3M8 13v3M0 8h3M13 8h3" />
            </svg>
            {mode === 'fp' ? 'Look ahead' : 'Recenter'}
          </button>
        )}
        {props.setLayer && <LayersMenu layers={props.layers} set={props.setLayer} />}
        {props.setFollow && mode !== 'fp' && props.pose && (
          <button className={`map-btn follow${props.follow ? ' on' : ''}`} onClick={() => props.setFollow!(!props.follow)}
                  aria-pressed={props.follow} title="Keep the camera on the selected responder (F)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M8 1.5 13.5 14 8 11 2.5 14Z" strokeLinejoin="round" />
            </svg>
            {props.follow ? 'Following' : 'Follow'}{props.crew.length > 1 ? ` ${responderLabel(props.crew, props.selected)}` : ''}
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
          <div className="legend-scale" title={SCALE.label}>
            {props.voc != null && (
              <div className="legend-marker" style={{ left: `${rampT(props.voc) * 100}%` }}>
                <span className="mono">{props.voc.toFixed(0)}</span>
              </div>
            )}
            <div className="legend-ramp" style={{ background: rampGradient() }}>
              {RAMP_BANDS.slice(1).map((t) => <i key={t} style={{ left: `${t * 100}%` }} />)}
            </div>
            <div className="legend-bands">
              {LEGEND.map((l, i) => (
                <span key={l.key} style={{ left: `${RAMP_BANDS[i] * 100}%` }} title={`${SCALE.label} ${levelRanges()[l.key]}`}>{l.label}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
