// VOC index (SGP40, 0-500) -> level and colour. Same LUT as the backend's heat PNG.

export type Level = 'good' | 'moderate' | 'poor' | 'alert'

export function level(v: number): Level {
  return v < 100 ? 'good' : v < 250 ? 'moderate' : v < 400 ? 'poor' : 'alert'
}

export const LEVEL_LABEL: Record<Level, string> = {
  good: 'Good', moderate: 'Moderate', poor: 'Poor', alert: 'Hazardous',
}

const STOPS: [number, [number, number, number]][] = [
  [0.0, [29, 211, 176]],
  [0.2, [29, 211, 176]],
  [0.5, [255, 209, 102]],
  [0.75, [255, 140, 66]],
  [1.0, [239, 35, 60]],
]

export function lut(v: number, max = 500): [number, number, number] {
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
