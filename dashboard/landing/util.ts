export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const smooth = (t: number) => {
  const x = clamp(t)
  return x * x * (3 - 2 * x)
}
/** 0 -> 1 (smoothstep) as p goes from a to b. */
export const span = (p: number, a: number, b: number) => smooth((p - a) / (b - a))
/** 1 inside [a, b] with fades of fi / fo at the edges, 0 outside. */
export const win = (p: number, a: number, b: number, fi = 0.02, fo = 0.02) =>
  span(p, a, a + fi) * (1 - span(p, b - fo, b))

export const reducedMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export const isMobile = () => window.innerWidth < 768
/** Size of one cell in CSS pixels. Fixed per breakpoint so the HUD canvas maps 1:1. */
export const cellPx = () => (window.innerWidth >= 1200 ? 8 : window.innerWidth >= 768 ? 7 : 6)

/** Deterministic pseudo random in [0, 1). */
export function rng(seed: number) {
  let s = (seed * 9301 + 49297) % 233280
  return () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
}

/** Scroll timeline (progress 0..1). Total page = 10.5 viewport heights. */
export const T = {
  intro: [0.03, 0.068],
  helmet: [0.075, 0.225],
  helmetSpin: [0.09, 0.21],
  outside: [0.225, 0.335],
  hatLand: [0.245, 0.268],
  pov: 0.315,
  door: 0.335,
  warn: [0.428, 0.487],
  warnImpulse: 0.431,
  lungs: [0.492, 0.602],
  hints: [
    [0.352, 0.412],
    [0.612, 0.655],
    [0.655, 0.698],
    [0.698, 0.741],
    [0.741, 0.78],
  ],
  lift: [0.782, 0.818],
  cut: 0.818,
  cool: [0.818, 0.878],
  laptop: [0.845, 0.905],
  cta: [0.905, 0.955],
} as const

export const COLORS = {
  text: '#eef1f6',
  muted: 'rgba(238,241,246,0.48)',
  good: '#1dd3b0',
  moderate: '#ffd166',
  poor: '#ff8c42',
  alert: '#ef233c',
  accent: '#4f8cff',
  bg: '#07090d',
}

export function vocAt(p: number) {
  const k: [number, number][] = [
    [0.23, 110], [0.335, 130], [0.37, 260], [0.41, 700], [0.428, 1400], [0.446, 2410], [0.487, 2600],
    [0.61, 2300], [0.72, 1900], [0.79, 1700],
  ]
  if (p <= k[0][0]) return k[0][1]
  for (let i = 0; i < k.length - 1; i++) {
    if (p < k[i + 1][0]) return Math.round(lerp(k[i][1], k[i + 1][1], (p - k[i][0]) / (k[i + 1][0] - k[i][0])))
  }
  return k[k.length - 1][1]
}
export function levelOf(v: number): [string, string] {
  if (v < 220) return ['Good', COLORS.good]
  if (v < 660) return ['Moderate', COLORS.moderate]
  if (v < 2200) return ['Poor', COLORS.poor]
  return ['Hazardous', COLORS.alert]
}
