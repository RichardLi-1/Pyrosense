// Rerun the gas model in a worker whenever the heat map or floor plan changes
// (at most one run in flight; the latest request wins).
import { useEffect, useRef, useState } from 'react'
import type { GasModel } from './gasModel'
import type { HeatCell, MapMeta } from './types'
import { CELL_SIZE } from './types'

/** `scope` names the scan the inputs belong to (session id); when it changes the old model is dropped at once. */
export function useGasModel(meta: MapMeta | null, image: CanvasImageSource | null, heat: HeatCell[], enabled = true, scope = '') {
  const [model, setModel] = useState<GasModel | null>(null)
  const worker = useRef<Worker | null>(null)
  const busy = useRef(false)
  const pending = useRef<(() => void) | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const w = new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<{ id: number; model: GasModel }>) => {
      if (e.data.id === seq.current) setModel(e.data.model)
      if (location.search.includes('debug')) {
        const m = e.data.model
        console.log('GAS', JSON.stringify({ ms: m.ms, sources: m.source?.sources, L: m.source?.L, gp: m.field && { n: m.field.n, ell: m.field.ell, sigmaF: m.field.sigmaF } }))
      }
      busy.current = false
      const next = pending.current
      pending.current = null
      next?.()
    }
    worker.current = w
    return () => { w.terminate(); worker.current = null }
  }, [])

  // a different scan, or one without a floor plan: nothing from before may show
  const lastScope = useRef(scope)
  useEffect(() => {
    if (lastScope.current !== scope) { lastScope.current = scope; seq.current++; pending.current = null; setModel(null) }
  }, [scope])
  useEffect(() => {
    if (!meta || !image) { seq.current++; pending.current = null; setModel(null) }
  }, [meta, image])

  useEffect(() => {
    if (!enabled || !meta || !image || !heat.length) return
    const run = () => {
      const c = document.createElement('canvas')
      c.width = meta.w; c.height = meta.h
      const g = c.getContext('2d', { willReadFrequently: true })!
      g.drawImage(image, 0, 0)
      const alpha = g.getImageData(0, 0, meta.w, meta.h).data
      const obs = heat.filter((h) => h.weight > 0.15).map((h) => ({
        x: (h.cx + 0.5) * CELL_SIZE, y: (h.cy + 0.5) * CELL_SIZE, v: h.mean, w: Math.min(3, h.weight), sd: h.sd,
      }))
      busy.current = true
      worker.current?.postMessage({ id: ++seq.current, alpha, meta: { origin: meta.origin, res: meta.res, w: meta.w, h: meta.h }, obs },
                                  [alpha.buffer])
    }
    if (busy.current) pending.current = run
    else run()
  }, [meta, image, heat, enabled])

  return enabled ? model : null
}
