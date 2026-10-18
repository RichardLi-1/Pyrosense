// Incident commander's annotations: what a responder reports over the radio (a victim, a
// blocked exit, stairs, fire), pinned to the map. Kept per session in this browser.
import { useCallback, useEffect, useState } from 'react'

export type MarkKind = 'victim' | 'fire' | 'blocked' | 'exit' | 'stairs' | 'hazard'
export type Mark = { id: string; kind: MarkKind; x: number; y: number; ts: string; by?: string } // by: responder label who reported it

/**
 * Glyphs are filled 24×24 silhouettes (`d`), shaded light-to-dark in the mark's colour, with dark
 * cut-out `detail` strokes (the X, the "!", the door). Shared by the toolbar (SVG) and the map (Path2D).
 * Colours follow the gas map: blue for people, the heat ramp for fire and danger, "good" teal for the way out.
 */
export type MarkDef = { kind: MarkKind; label: string; color: string; d: string; detail?: string; accent?: string }
export const MARK_KINDS: MarkDef[] = [
  { kind: 'victim', label: 'Victim', color: '#4f8cff',
    d: 'M12 2.5a3.75 3.75 0 1 1 0 7.5a3.75 3.75 0 0 1 0-7.5Z M4.5 20.2c0-4.2 3.3-7.2 7.5-7.2s7.5 3 7.5 7.2c0 .7-.6 1.3-1.3 1.3H5.8c-.7 0-1.3-.6-1.3-1.3Z' },
  { kind: 'fire', label: 'Fire', color: '#ef233c', accent: '#ffd166',
    d: 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5Z',
    detail: 'M12 21.5a3.6 3.6 0 0 1-3.6-3.6c0-1.8 1.3-2.7 1.8-4.5.9.9 1.4 1.8 1.4 2.7.5-.4.9-.9 1.1-1.6.9.9 2.1 2.1 2.1 3.4a3.6 3.6 0 0 1-2.8 3.6Z' },
  { kind: 'blocked', label: 'Blocked exit', color: '#ef233c',
    d: 'M7.6 2h8.8c.5 0 1 .2 1.4.6l5.6 5.6c.4.4.6.9.6 1.4v8.8c0 .5-.2 1-.6 1.4l-5.6 5.6c-.4.4-.9.6-1.4.6H7.6c-.5 0-1-.2-1.4-.6L.6 19.8c-.4-.4-.6-.9-.6-1.4V9.6c0-.5.2-1 .6-1.4L6.2 2.6c.4-.4.9-.6 1.4-.6Z',
    detail: 'M8.8 8.8l6.4 6.4 M15.2 8.8l-6.4 6.4' },
  { kind: 'exit', label: 'Exit', color: '#1dd3b0',
    d: 'M2 6.5A2.5 2.5 0 0 1 4.5 4h15A2.5 2.5 0 0 1 22 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5Z',
    detail: 'M5.5 8h4.5v8H5.5Z M13 12h5.5 M16.5 10l2 2-2 2' },
  { kind: 'stairs', label: 'Stairs', color: '#93c5fd',
    d: 'M2 21.5v-4.5h4.5v-4.5H11V8h4.5V3.5H22v18Z' },
  { kind: 'hazard', label: 'Hazard', color: '#ffd166',
    d: 'M10.1 3.4a2.2 2.2 0 0 1 3.8 0l8.3 14.4a2.2 2.2 0 0 1-1.9 3.3H3.7a2.2 2.2 0 0 1-1.9-3.3Z',
    detail: 'M12 8.5v5 M12 17.2h.01' },
]
export const markKind = (k: MarkKind) => MARK_KINDS.find((m) => m.kind === k)!

/** Lighter tint of a hex colour, for the top of the shading gradient. */
export function tint(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16)
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * t))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}
export const DETAIL_INK = '#0b0e14'

const paths = new Map<string, Path2D>()
const path2d = (key: string, d: string) => { let p = paths.get(key); if (!p) paths.set(key, (p = new Path2D(d))); return p }

/** Map pin: dark disc with a coloured ring and the shaded glyph, label underneath. */
export function drawMark(ctx: CanvasRenderingContext2D, m: { kind: MarkKind }, x: number, y: number, r = 13, label?: string) {
  const k = markKind(m.kind)
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2
  ctx.fillStyle = '#0b0e14'
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = k.color; ctx.lineWidth = 2
  ctx.stroke()
  const s = (r * 1.2) / 24
  ctx.translate(x - 12 * s, y - 12 * s)
  ctx.scale(s, s)
  const body = path2d(k.kind, k.d)
  // soft drop shadow under the silhouette, then the light-to-dark fill, then the cut-out detail
  ctx.save(); ctx.translate(0, 1); ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill(body, 'evenodd'); ctx.restore()
  const g = ctx.createLinearGradient(0, 2, 0, 22)
  g.addColorStop(0, tint(k.color, 0.45)); g.addColorStop(1, k.color)
  ctx.fillStyle = g; ctx.fill(body, 'evenodd')
  if (k.detail) {
    const d = path2d(k.kind + ':detail', k.detail)
    if (k.accent) { ctx.fillStyle = k.accent; ctx.fill(d) }
    else { ctx.strokeStyle = DETAIL_INK; ctx.lineWidth = 2; ctx.lineCap = ctx.lineJoin = 'round'; ctx.stroke(d) }
  }
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
