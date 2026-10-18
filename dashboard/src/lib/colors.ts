// VOC level and colour. The scale follows the unit the backend announces in `hello`:
//   ppb   SGP30 TVOC   good <220 · moderate <660 · poor <2200 · alert ≥2200   (colour ramp 0-3000)
//   index SGP40 index  good <100 · moderate <250 · poor <400  · alert ≥400    (colour ramp 0-500)
import type { VocUnit } from './types'

export type Level = 'good' | 'moderate' | 'poor' | 'alert'

type Scale = { unit: VocUnit; label: string; short: string; bands: [number, number, number]; max: number }
const SCALES: Record<VocUnit, Scale> = {
  ppb: { unit: 'ppb', label: 'TVOC · ppb', short: 'ppb', bands: [220, 660, 2200], max: 3000 },
  index: { unit: 'index', label: 'VOC index', short: '', bands: [100, 250, 400], max: 500 },
}
export let SCALE: Scale = SCALES.ppb

/** Called once from the `hello` event; every reading on screen is interpreted on this scale. */
export function configureScale(unit: VocUnit | undefined) {
  SCALE = SCALES[unit ?? 'ppb'] ?? SCALES.ppb
}

export function level(v: number): Level {
  const [a, b, c] = SCALE.bands
  return v < a ? 'good' : v < b ? 'moderate' : v < c ? 'poor' : 'alert'
}

export const LEVEL_LABEL: Record<Level, string> = {
  good: 'Good', moderate: 'Moderate', poor: 'Poor', alert: 'Hazardous',
}

/** Legend ranges for the current scale. */
export function levelRanges(): Record<Level, string> {
  const [a, b, c] = SCALE.bands
  return { good: `<${a}`, moderate: `${a}–${b - 1}`, poor: `${b}–${c - 1}`, alert: `${c}+` }
}

const STOPS: [number, [number, number, number]][] = [
  [0.0, [29, 211, 176]],
  [0.2, [29, 211, 176]],
  [0.5, [255, 209, 102]],
  [0.75, [255, 140, 66]],
  [1.0, [239, 35, 60]],
]

export function lut(v: number, max = SCALE.max): [number, number, number] {
  const x = Math.min(1, Math.max(0, v / max))
  for (let i = 1; i < STOPS.length; i++) {
    const [b, cb] = STOPS[i]
    const [a, ca] = STOPS[i - 1]
    if (x <= b) {
      const f = b === a ? 0 : (x - a) / (b - a)
      return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * f)) as [number, number, number]
    }
  }
  return STOPS[STOPS.length - 1][1]
}

export const rgb = (c: [number, number, number], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`
export const levelColor = (v: number) => rgb(lut(v))
