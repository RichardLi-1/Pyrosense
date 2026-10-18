import { useCallback, useEffect, useMemo, useState } from 'react'
import Focus from './designs/Focus'
import type { DesignProps, ViewOptions } from './designs/types'
import { createDemoSource } from './lib/demo'
import { backendReachable, createLiveSource } from './lib/live'
import { useGasModel } from './lib/useGasModel'
import type { DataSource } from './lib/types'
import { DEFAULT_LAYERS, LAYERS, needsGasModel } from './map/layers'
import { useDashboard } from './lib/useDashboard'

const DESIGNS = { focus: Focus } as const
type DesignName = keyof typeof DESIGNS
const NAMES = Object.keys(DESIGNS) as DesignName[]

function initialDesign(): DesignName {
  const q = new URLSearchParams(location.search).get('design')
  if (q && q in DESIGNS) return q as DesignName
  try {
    const saved = localStorage.getItem('design')
    if (saved && saved in DESIGNS) return saved as DesignName
  } catch { /* storage unavailable */ }
  return 'focus'
}

/** ?source=live|demo, else live if the backend answers, otherwise the in-browser demo. */
function useSource(): [DataSource | null, (kind: 'live' | 'demo') => void] {
  const [source, setSource] = useState<DataSource | null>(null)
  const pick = useCallback((kind: 'live' | 'demo') => {
    setSource(kind === 'demo' ? createDemoSource() : createLiveSource())
    const u = new URL(location.href)
    u.searchParams.set('source', kind)
    history.replaceState(null, '', u)
  }, [])
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('source')
    if (q === 'demo' || q === 'live') { pick(q); return }
    backendReachable().then((ok) => pick(ok ? 'live' : 'demo'))
  }, [pick])
  return [source, pick]
}

export default function App() {
  const [source, setSource] = useSource()
  // keyed on kind so a switch remounts the dashboard with fresh state
  return source ? <Dashboard key={source.kind} source={source} setSource={setSource} /> : null
}

function Dashboard({ source, setSource }: { source: DataSource; setSource: (kind: 'live' | 'demo') => void }) {
  const { s, setUntil, loadSummary, select, scans, markWarningsRead } = useDashboard(source)
  const [design, setDesign] = useState<DesignName>(initialDesign)
  const [view, setView] = useState<ViewOptions>({ follow: false, layers: DEFAULT_LAYERS, only: null })

  useEffect(() => {
    try { localStorage.setItem('design', design) } catch { /* ignore */ }
  }, [design])

  // F follow · layer shortcuts (H gas, U uncertainty, T paths, S source, N next, A alerts, M marks) · 1-3 design
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      const layer = LAYERS.find((l) => l.shortcut.toLowerCase() === k)
      if (k === 'f') setView((v) => ({ ...v, follow: !v.follow }))
      else if (layer) setView((v) => ({ ...v, layers: { ...v.layers, [layer.key]: !v.layers[layer.key] } }))
      else if (k >= '1' && k <= String(NAMES.length)) setDesign(NAMES[Number(k) - 1])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const gas = useGasModel(s.meta, s.image, s.heat, needsGasModel(view.layers), s.reviewing?.session ?? `live:${s.session}`)
  const Design = DESIGNS[design]
  const props: DesignProps = useMemo(() => ({ s, setUntil, loadSummary, view, setView, select, gas, setSource, scans, markWarningsRead }),
                                     [s, setUntil, loadSummary, view, select, gas, setSource, scans, markWarningsRead])
  return (
    <div className={`t-${design}`}>
      <Design {...props} />
    </div>
  )
}
