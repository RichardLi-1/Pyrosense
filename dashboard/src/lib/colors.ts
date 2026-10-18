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

/**
 * Thermal ramp, in band space: 0–0.33 good (deep navy → royal blue), 0.33–0.55 moderate
 * (pale blue → amber), 0.55–0.78 poor (red-orange → orange), 0.78–1 hazardous (yellow → white-hot).
 * Cool colours are calm air; warmth and brightness are the gas.
 */
const STOPS: [number, [number, number, number]][] = [
  [0.00, [10, 16, 48]],
  [0.16, [24, 50, 128]],
  [0.33, [47, 111, 224]],
  [0.46, [146, 188, 236]],
  [0.55, [240, 170, 74]],
  [0.67, [226, 84, 32]],
  [0.78, [255, 138, 31]],
  [0.90, [255, 210, 60]],
  [1.00, [255, 247, 216]],
]
const SEG: [number, number, number, number] = [0, 0.33, 0.55, 0.78] // band starts in ramp space

/** Position of a reading on the ramp (0–1): bands get fixed widths so the look is unit-independent. */
export function rampT(v: number, scale = SCALE): number {
  const [a, b, c] = scale.bands
  const edges = [0, a, b, c, scale.max]
  const stops = [...SEG, 1]
  if (v <= 0) return 0
  for (let i = 0; i < 4; i++) {
    if (v < edges[i + 1]) return stops[i] + ((v - edges[i]) / (edges[i + 1] - edges[i])) * (stops[i + 1] - stops[i])
  }
  return 1
}

/** Colour at ramp position t (0–1). */
export function rampColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t))
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

/** CSS gradient of the whole ramp, for legends. */
export function rampGradient(dir = 'to right'): string {
  const n = 24
  const parts: string[] = []
  for (let i = 0; i <= n; i++) parts.push(`rgb(${rampColor(i / n).join(',')}) ${((i / n) * 100).toFixed(1)}%`)
  return `linear-gradient(${dir}, ${parts.join(', ')})`
}

/** Where each band starts along the ramp, as fractions (for legend ticks). */
export const RAMP_BANDS = SEG

export function lut(v: number): [number, number, number] {
  return rampColor(rampT(v))
}

export const rgb = (c: [number, number, number], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`
export const levelColor = (v: number) => rgb(lut(v))
