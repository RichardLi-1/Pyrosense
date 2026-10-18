// Spoken warnings: the backend's plain-language warnings as a side panel, read aloud when
// voice is on. Browsers only allow sound after a click, so the voice toggle is also the unlock.
import { useCallback, useEffect, useRef, useState } from 'react'
import { LEVEL_LABEL, SCALE, type Level } from '../lib/colors'
import { apiUrl } from '../lib/live'
import type { Warning } from '../lib/types'

const VOICE_KEY = 'voice'
const asLevel = (l: Warning['level']): Level => (l === 'hazardous' ? 'alert' : l)
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

/** Play one warning: its audio file when there is one (through the /api proxy), else the browser's speech. A warning is never silent. */
function speak(w: Warning) {
  if (w.audio_url) {
    const a = new Audio(apiUrl(w.audio_url))
    let spoken = false
    const voice = () => { if (!spoken) { spoken = true; fallback(w.text) } }
    a.onerror = voice // 404, wrong type (an HTML page), decode failure
    a.onstalled = voice
    a.play().catch(voice)
    return
  }
  fallback(w.text)
}
function fallback(text: string) {
  if (!('speechSynthesis' in window)) return
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 1.0
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(u)
}

/** One unlock after a click: a silent utterance plus a silent clip, so later plays are allowed. */
function unlockAudio() {
  try {
    if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u) }
    const a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=')
    a.volume = 0
    a.play().catch(() => {})
  } catch { /* nothing to unlock */ }
}

/** Speaks each new live warning while enabled; never in replay or review. */
export function useVoice(warnings: Warning[], enabled: boolean, muted: boolean) {
  const spoken = useRef<Set<string>>(new Set())
  const mounted = useRef(Date.now())
  useEffect(() => {
    for (const w of warnings) {
      if (spoken.current.has(w.id)) continue
      spoken.current.add(w.id)
      if (!enabled || muted) continue
      if (Date.parse(w.ts) < mounted.current - 5000) continue // seeded history, not news
      speak(w)
    }
  }, [warnings, enabled, muted])
}

export function useVoiceSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(VOICE_KEY) === 'on' } catch { return false } })
  const set = useCallback((v: boolean) => {
    setOn(v)
    try { localStorage.setItem(VOICE_KEY, v ? 'on' : 'off') } catch { /* ignore */ }
    if (v) unlockAudio()
  }, [])
  return [on, set]
}

export function VoiceToggle({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  return (
    <button className={`map-btn voice${on ? ' on' : ''}`} onClick={() => set(!on)} aria-pressed={on} title="Read warnings aloud">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor" stroke="none" />
        {on ? <><path d="M11 5.5a3.5 3.5 0 0 1 0 5" /><path d="M12.8 3.5a6 6 0 0 1 0 9" /></> : <path d="M11 6l4 4M15 6l-4 4" />}
      </svg>
      {on ? 'Voice on' : 'Voice off'}
    </button>
  )
}

export function WarningsButton({ count, unread, open, toggle }: { count: number; unread: number; open: boolean; toggle: () => void }) {
  return (
    <button className={`map-btn warnings-btn${open ? ' on' : ''}`} onClick={toggle} title="Spoken warnings" disabled={!count && !open}>
      Warnings
      {unread > 0 && <span className="badge">{unread}</span>}
    </button>
  )
}

export function WarningsPanel({ warnings, onClose, flash }: { warnings: Warning[]; onClose: () => void; flash: string | null }) {
  return (
    <aside className="drawer warnings" aria-label="Warnings">
      <header className="drawer-head">
        <strong>Warnings</strong>
        <button className="ghost" onClick={onClose}>Close</button>
      </header>
      {!warnings.length && <p className="muted drawer-note">No warnings yet. One is spoken when a reading stays elevated.</p>}
      <ul className="warning-list">
        {warnings.map((w) => {
          const lv = asLevel(w.level)
          return (
            <li key={w.id} className={`warning${flash === w.id ? ' flash' : ''}`}>
              <div className="warning-top">
                <span className="mono muted">{clock(w.ts)}</span>
                <span className="pill" style={{ ['--pill' as string]: `var(--${lv})` }}>{LEVEL_LABEL[lv]}</span>
                <span className="mono">{w.voc.toFixed(0)} {w.unit === 'index' ? '' : w.unit || SCALE.short}</span>
                <span className="muted tag">{w.source === 'gemini' ? '✦ Gemini' : 'auto'}</span>
                <button className="play" onClick={() => speak(w)} title={w.audio_url ? 'Play' : 'Read aloud'} aria-label="Play">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2.5 1.5v9l7.5-4.5z" /></svg>
                </button>
              </div>
              <p>{w.text}</p>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
