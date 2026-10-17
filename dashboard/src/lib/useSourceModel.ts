// Refit the source model in a worker whenever the heat map or floor plan changes
// (at most one fit in flight; the latest request wins).
import { useEffect, useRef, useState } from 'react'
import type { SourceModel } from './sourceModel'
import type { HeatCell, MapMeta } from './types'
import { CELL_SIZE } from './types'

export function useSourceModel(meta: MapMeta | null, image: CanvasImageSource | null, heat: HeatCell[], enabled = true) {
  const [model, setModel] = useState<SourceModel | null>(null)
  const worker = useRef<Worker | null>(null)
  const busy = useRef(false)
  const pending = useRef<(() => void) | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const w = new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<{ id: number; model: SourceModel | null }>) => {
      if (e.data.id === seq.current) setModel(e.data.model)
      if (location.search.includes('debug')) console.log('MODEL', JSON.stringify({ base: e.data.model?.base, L: e.data.model?.L, sources: e.data.model?.sources }))
      busy.current = false
      const next = pending.current
      pending.current = null
      next?.()
    }
    worker.current = w
    return () => { w.terminate(); worker.current = null }
  }, [])

  useEffect(() => {
    if (!enabled || !meta || !image || !heat.length) return
    const run = () => {
      const c = document.createElement('canvas')
      c.width = meta.w; c.height = meta.h
      const g = c.getContext('2d', { willReadFrequently: true })!
      g.drawImage(image, 0, 0)
      const alpha = g.getImageData(0, 0, meta.w, meta.h).data
      const obs = heat.filter((h) => h.weight > 0.15).map((h) => ({
        x: (h.cx + 0.5) * CELL_SIZE, y: (h.cy + 0.5) * CELL_SIZE, v: h.mean, w: Math.min(3, h.weight),
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
