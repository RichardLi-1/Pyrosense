// Fits the source model off the main thread (see sourceModel.ts).
import { fitSourceModel, passGridFromAlpha, type Obs } from './sourceModel'

type Req = { id: number; alpha: Uint8ClampedArray; meta: { origin: [number, number]; res: number; w: number; h: number }; obs: Obs[] }

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, alpha, meta, obs } = e.data
  const grid = passGridFromAlpha(alpha, meta)
  const model = fitSourceModel(grid, obs)
  ;(self as unknown as Worker).postMessage({ id, model }, model ? [model.field.buffer] : [])
}
