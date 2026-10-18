// Quick marks for the incident commander: pick what was reported, then click the map
// (or drop it where the reporting responder stands).
import { useEffect, useRef, useState } from 'react'
import { DETAIL_INK, MARK_KINDS, markKind, tint, type Mark, type MarkDef, type MarkKind } from '../lib/marks'

/** Shaded mark icon: drop shadow, light-to-dark fill in the mark's colour, dark cut-out detail. */
export function Glyph({ k, size = 20 }: { k: MarkDef; size?: number }) {
  const id = `mk-${k.kind}`
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tint(k.color, 0.45)} />
          <stop offset="1" stopColor={k.color} />
        </linearGradient>
      </defs>
      <path d={k.d} fill="rgba(0,0,0,.4)" fillRule="evenodd" transform="translate(0 1)" />
      <path d={k.d} fill={`url(#${id})`} fillRule="evenodd" />
      {k.detail && (k.accent
        ? <path d={k.detail} fill={k.accent} />
        : <path d={k.detail} fill="none" stroke={DETAIL_INK} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
  )
}

const ago = (ts: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`
}

type Props = {
  marks: Mark[]
  armed: MarkKind | null
  setArmed: (k: MarkKind | null) => void
  remove: (id: string) => void
  /** Drop the armed mark where this responder stands (label + position), if known. */
  here: { label: string; x: number; y: number } | null
  dropHere: () => void
  now: number
}

export function AnnotateBar({ marks, armed, setArmed, remove, here, dropHere, now }: Props) {
  const [list, setList] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!armed) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setArmed(null); else if (e.key === 'Enter' && here) dropHere() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [armed, setArmed, here, dropHere])

  useEffect(() => {
    if (!list) return
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setList(false) }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [list])

  const k = armed && markKind(armed)
  return (
    <>
      <div className="annotate" ref={ref} role="toolbar" aria-label="Mark on map">
        <span className="caption">Mark</span>
        {MARK_KINDS.map((m) => (
          <button key={m.kind} className={armed === m.kind ? 'on' : ''} style={{ ['--mark' as string]: m.color }}
                  onClick={() => setArmed(armed === m.kind ? null : m.kind)} aria-pressed={armed === m.kind}
                  title={`Mark ${m.label.toLowerCase()} on the map`}>
            <Glyph k={m} />
            <span>{m.label}</span>
          </button>
        ))}
        <button className={`annotate-list-btn${list ? ' on' : ''}`} onClick={() => setList(!list)} disabled={!marks.length}
                title="Marks placed this session">
          <span className="mono">{marks.length}</span><span>Placed</span>
        </button>
        {list && marks.length > 0 && (
          <ul className="annotate-list">
            {[...marks].reverse().map((m) => {
              const mk = markKind(m.kind)
              return (
                <li key={m.id}>
                  <i style={{ color: mk.color }}><Glyph k={mk} size={16} /></i>
                  <span className="annotate-list-main">
                    <b>{mk.label}</b>
                    <small className="mono">({m.x.toFixed(1)}, {m.y.toFixed(1)}) m · {ago(m.ts, now)}{m.by ? ` · ${m.by}` : ''}</small>
                  </span>
                  <button className="annotate-x" onClick={() => remove(m.id)} title="Remove this mark" aria-label={`Remove ${mk.label}`}>×</button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {k && (
        <div className="annotate-hint" role="status" style={{ ['--mark' as string]: k.color }}>
          <i><Glyph k={k} size={16} /></i>
          <span>Click the map to mark <b>{k.label.toLowerCase()}</b></span>
          {here && <button className="map-btn" onClick={dropHere} title="Enter">At {here.label}’s position</button>}
          <button className="link" onClick={() => setArmed(null)}>Cancel (Esc)</button>
        </div>
      )}
    </>
  )
}
