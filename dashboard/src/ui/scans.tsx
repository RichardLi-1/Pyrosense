// Scans: save the current one, start a fresh one, and browse past ones for review.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { scanLabel } from '../lib/useDashboard'
import { apiUrl } from '../lib/live'
import type { ScanSession } from '../lib/types'

export type ScanActions = {
  supported: boolean
  list: () => Promise<ScanSession[]>
  open: (scan: ScanSession) => void
  close: () => void
  save: (name?: string, notes?: string) => Promise<unknown>
  restart: (name?: string) => Promise<unknown>
}

/** Closes on Escape or a click outside. */
function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', down)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', down) }
  }, [open, onClose])
  return ref
}

/** A small form: optional name, one confirming action. */
function NamePop({ title, hint, action, busyLabel, onSubmit, onClose }: {
  title: string; hint?: string; action: string; busyLabel: string; onSubmit: (name: string) => Promise<unknown>; onClose: () => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    await onSubmit(name.trim())
    setBusy(false)
    onClose()
  }
  return (
    <form className="pop scan-pop" onSubmit={submit}>
      <strong>{title}</strong>
      {hint && <p className="muted">{hint}</p>}
      <input ref={input} className="field" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      <div className="pop-actions">
        <button type="button" className="ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="map-btn solid" disabled={busy}>{busy ? busyLabel : action}</button>
      </div>
    </form>
  )
}

export function SaveScan({ scans }: { scans: ScanActions }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div className="pop-anchor" ref={ref}>
      <button className="map-btn" onClick={() => setOpen((o) => !o)} title="Name this scan and keep its floor plan">Save as project</button>
      {open && <NamePop title="Save as project" hint="Keeps the floor plan and readings so far under a name." action="Save" busyLabel="Saving…"
                        onSubmit={(n) => scans.save(n || undefined)} onClose={() => setOpen(false)} />}
    </div>
  )
}

export function RestartScan({ scans }: { scans: ScanActions }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div className="pop-anchor" ref={ref}>
      <button className="map-btn" onClick={() => setOpen((o) => !o)} title="Save this scan and start a new one">Reset</button>
      {open && <NamePop title="Reset and start a new scan?" action="Reset" busyLabel="Resetting…"
                        hint="The current scan is saved first. The device restarts mapping, which takes about half a minute."
                        onSubmit={(n) => scans.restart(n || undefined)} onClose={() => setOpen(false)} />}
    </div>
  )
}

const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function duration(scan: ScanSession) {
  const ms = (scan.ended ? Date.parse(scan.ended) : Date.now()) - Date.parse(scan.started)
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/** The catalog: a drawer listing every scan the backend has, newest first. */
export function ScansDrawer({ scans, current, reviewing, onClose }: {
  scans: ScanActions; current: string; reviewing: ScanSession | null; onClose: () => void
}) {
  const [list, setList] = useState<ScanSession[] | null>(null)
  const [error, setError] = useState(false)
  const ref = useDismiss(true, onClose)
  useEffect(() => {
    let live = true
    scans.list().then((l) => { if (live) setList(l) }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [scans])
  return (
    <aside className="drawer" ref={ref} aria-label="Scans">
      <header className="drawer-head">
        <strong>Scans</strong>
        <button className="ghost" onClick={onClose}>Close</button>
      </header>
      {error && <p className="muted drawer-note">Could not load the scan list.</p>}
      {list && !list.length && <p className="muted drawer-note">No scans yet. Save or restart a scan to add one.</p>}
      {!list && !error && <p className="muted drawer-note">Loading…</p>}
      <ul className="scan-list">
        {list?.map((scan) => {
          const isCurrent = scan.session === current && !scan.ended
          const on = reviewing?.session === scan.session
          return (
            <li key={scan.session}>
              <button className={`scan${on ? ' on' : ''}`} onClick={() => { if (isCurrent) scans.close(); else scans.open(scan) }}
                      title={isCurrent ? 'This is the live scan' : 'Review this scan'}>
                <span className="scan-thumb">{scan.map_png_url ? <img src={apiUrl(scan.map_png_url)} alt="" loading="lazy" /> : <i />}</span>
                <span className="scan-body">
                  <span className="scan-name">{scanLabel(scan)}{isCurrent && <em> · live</em>}</span>
                  <span className="scan-meta mono">{day(scan.started)} {time(scan.started)} · {duration(scan)} · {scan.n.toLocaleString()} readings</span>
                  {scan.notes && <span className="scan-notes">{scan.notes}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

export function ScansButton({ scans, current, reviewing }: { scans: ScanActions; current: string; reviewing: ScanSession | null }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className={`map-btn${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} title="Browse saved scans">Scans</button>
      {open && <ScansDrawer scans={scans} current={current} reviewing={reviewing} onClose={() => setOpen(false)} />}
    </>
  )
}
