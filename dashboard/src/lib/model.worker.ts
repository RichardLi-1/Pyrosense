// Runs the gas model off the main thread (see gasModel.ts).
import { runGasModel, transferables, type GasRequest } from './gasModel'

self.onmessage = (e: MessageEvent<GasRequest & { id: number }>) => {
  const { id, ...req } = e.data
  const model = runGasModel(req)
  ;(self as unknown as Worker).postMessage({ id, model }, transferables(model))
}
