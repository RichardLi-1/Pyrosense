// What the map draws, each switchable on its own (Layers popover, keyboard shortcuts).
export type LayerKey = 'gas' | 'uncertainty' | 'paths' | 'source' | 'next' | 'alerts' | 'marks'
export type Layers = Record<LayerKey, boolean>

export const LAYERS: { key: LayerKey; label: string; hint: string; shortcut: string }[] = [
  { key: 'gas', label: 'Gas map', hint: 'Measured VOC field, fading where the model is less sure', shortcut: 'H' },
  { key: 'uncertainty', label: 'Uncertainty', hint: 'Fog where the model is least sure (GP standard deviation)', shortcut: 'U' },
  { key: 'paths', label: 'Responder paths', hint: 'Last 90 s of each responder’s track', shortcut: 'T' },
  { key: 'alerts', label: 'Alerts', hint: 'Where high-VOC alerts fired', shortcut: 'A' },
  { key: 'marks', label: 'Annotations', hint: 'Commander’s marks: victims, exits, fire…', shortcut: 'M' },
]

export const DEFAULT_LAYERS: Layers = { gas: true, uncertainty: false, paths: true, source: false, next: false, alerts: true, marks: true }

/** Whether anything on screen needs the gas model (it's expensive; skip it when all of these are off). */
export const needsGasModel = (l: Layers) => l.gas || l.uncertainty
