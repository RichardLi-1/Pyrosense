import { useEffect, useMemo, useState } from 'react'
import Focus from './designs/Focus'
import type { DesignProps, ViewOptions } from './designs/types'
import { createDemoSource } from './lib/demo'
import { backendReachable, createLiveSource } from './lib/live'
import { useGasModel } from './lib/useGasModel'
import type { DataSource } from './lib/types'
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
function useSource(): DataSource | null {
  const [source, setSource] = useState<DataSource | null>(null)
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('source')
    if (q === 'demo') { setSource(createDemoSource()); return }
    if (q === 'live') { setSource(createLiveSource()); return }
    backendReachable().then((ok) => setSource(ok ? createLiveSource() : createDemoSource()))
  }, [])
  return source
}

export default function App() {
  const source = useSource()
  return source ? <Dashboard source={source} /> : null
}

function Dashboard({ source }: { source: DataSource }) {
  const { s, setUntil, loadSummary, select } = useDashboard(source)
  const [design, setDesign] = useState<DesignName>(initialDesign)
  const [view, setView] = useState<ViewOptions>({ follow: false, showHeat: true, showTrail: true })

  useEffect(() => {
    try { localStorage.setItem('design', design) } catch { /* ignore */ }
  }, [design])

  // F follow · H heat · T trail · 1-3 design
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return
      const k = e.key.toLowerCase()
      if (k === 'f') setView((v) => ({ ...v, follow: !v.follow }))
      else if (k === 'h') setView((v) => ({ ...v, showHeat: !v.showHeat }))
      else if (k === 't') setView((v) => ({ ...v, showTrail: !v.showTrail }))
      else if (k >= '1' && k <= String(NAMES.length)) setDesign(NAMES[Number(k) - 1])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const gas = useGasModel(s.meta, s.image, s.heat, view.showHeat)
  const Design = DESIGNS[design]
  const props: DesignProps = useMemo(() => ({ s, setUntil, loadSummary, view, select, gas }), [s, setUntil, loadSummary, view, select, gas])
  return (
    <div className={`t-${design}`}>
      <Design {...props} />
    </div>
  )
}
