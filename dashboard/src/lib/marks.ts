// Incident commander's annotations: what a responder reports over the radio (a victim, a
// blocked exit, stairs, fire), pinned to the map. Kept per session in this browser.
import { useCallback, useEffect, useState } from 'react'

export type MarkKind = 'victim' | 'fire' | 'blocked' | 'exit' | 'stairs' | 'hazard'
export type Mark = { id: string; kind: MarkKind; x: number; y: number; ts: string; by?: string } // by: responder label who reported it

/** Glyphs are 16×16 stroked SVG paths, shared by the toolbar (SVG) and the map (Path2D). */
export const MARK_KINDS: { kind: MarkKind; label: string; color: string; d: string }[] = [
  { kind: 'victim', label: 'Victim', color: '#f0abfc',
    d: 'M8 1.8a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4Z M8 6.6v4.2 M4.6 7.6 8 6.6l3.4 1 M5.6 14.2 8 10.8l2.4 3.4' },
  { kind: 'fire', label: 'Fire', color: '#ff7a2e',
    d: 'M8 14.2c-2.7 0-4.4-1.8-4.4-4.2 0-2.6 2.1-3.8 2.6-6.4 1.5 1 2.3 2.4 2.3 3.8.6-.5 1-1.3 1.1-2.2 1.5 1.2 2.8 3 2.8 4.8 0 2.4-1.7 4.2-4.4 4.2Z' },
  { kind: 'blocked', label: 'Blocked exit', color: '#ff4d5e',
    d: 'M3 14V2.5h6.5V14 M1.5 14h13 M10.6 5.2l3.6 3.6 M14.2 5.2l-3.6 3.6' },
  { kind: 'exit', label: 'Exit', color: '#4ade80',
    d: 'M3 14V2.5h6V14 M1.5 14h13 M9.6 8.2h4.6 M12.4 6.2l2 2-2 2' },
  { kind: 'stairs', label: 'Stairs', color: '#93c5fd',
    d: 'M1.8 13.8h3.4v-3h3v-3h3v-3h3' },
  { kind: 'hazard', label: 'Hazard', color: '#facc15',
    d: 'M8 2.2l6.4 11.4H1.6Z M8 6.4v3.4 M8 11.6v.4' },
]
export const markKind = (k: MarkKind) => MARK_KINDS.find((m) => m.kind === k)!

const paths = new Map<MarkKind, Path2D>()
/** Map pin: dark disc with a coloured ring and the white glyph, label underneath. */
export function drawMark(ctx: CanvasRenderingContext2D, m: { kind: MarkKind }, x: number, y: number, r = 13, label?: string) {
  const k = markKind(m.kind)
  let p = paths.get(m.kind)
  if (!p) paths.set(m.kind, (p = new Path2D(k.d)))
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2
  ctx.fillStyle = '#0b0e14'
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = k.color; ctx.lineWidth = 2
  ctx.stroke()
  const s = (r * 1.15) / 16
  ctx.translate(x - 8 * s, y - 8 * s)
  ctx.scale(s, s)
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.lineCap = ctx.lineJoin = 'round'
  ctx.stroke(p)
  ctx.restore()
  if (label) {
    ctx.save()
    ctx.font = '600 11px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(7,9,13,0.85)'; ctx.lineJoin = 'round'
    ctx.strokeText(label, x, y + r + 4)
    ctx.fillStyle = '#eef1f6'
    ctx.fillText(label, x, y + r + 4)
    ctx.restore()
  }
}

const load = (key: string): Mark[] => {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]') as Mark[] } catch { return [] }
}

export function useMarks(session: string) {
  const key = `marks:${session || 'none'}`
  const [marks, setMarks] = useState<Mark[]>(() => load(key))
  useEffect(() => { setMarks(load(key)) }, [key])
  const save = useCallback((f: (m: Mark[]) => Mark[]) => setMarks((prev) => {
    const next = f(prev)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* storage unavailable */ }
    return next
  }), [key])
  const add = useCallback((m: Omit<Mark, 'id' | 'ts'>) =>
    save((p) => [...p, { ...m, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString() }]), [save])
  const remove = useCallback((id: string) => save((p) => p.filter((m) => m.id !== id)), [save])
  return { marks, add, remove }
}
