// Quick marks for the incident commander: pick what was reported, then click the map
// (or drop it where the reporting responder stands).
import { useEffect, useRef, useState } from 'react'
import { MARK_KINDS, markKind, type Mark, type MarkKind } from '../lib/marks'

export function Glyph({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
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
            <Glyph d={m.d} />
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
                  <i style={{ color: mk.color }}><Glyph d={mk.d} size={16} /></i>
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
          <i><Glyph d={k.d} size={16} /></i>
          <span>Click the map to mark <b>{k.label.toLowerCase()}</b></span>
          {here && <button className="map-btn" onClick={dropHere} title="Enter">At {here.label}’s position</button>}
          <button className="link" onClick={() => setArmed(null)}>Cancel (Esc)</button>
        </div>
      )}
    </>
  )
}
