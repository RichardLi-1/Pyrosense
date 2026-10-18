// Client-side plume: what the map shows the instant a reading comes in, before /heatmap
// catches up, and a long-lived particle cloud that random-walks through free space so
// gas found ten minutes ago is still visibly "somewhere around here".
//
//   bloom     one radial splat per elevated reading at the wearer (yellow / orange / red by
//             level, ~1 m growing with level), fading with the same 45 s half-life, so
//             walking while elevated leaves a coloured trail
//   particles N per elevated reading (N ∝ excess over the moderate band, ≤ 40), Brownian
//             steps blocked by walls, a slight drift up the forecast gradient, alpha
//             half-life 45 s, at most 4000 (oldest dropped first)
//
// Both are rebuilt from the trail in replay, so scrubbing shows the cloud as it was.
import { SCALE, level, rampColor, type Level } from './colors'
import type { MapMeta, TrailPoint } from './types'

export type FreeMask = { data: Uint8Array; meta: MapMeta } // 1 = scanned free space, map-pixel grid

type Bloom = { x: number; y: number; t: number; level: Level }
type Particle = { x: number; y: number; born: number; level: Level }

const MAX_BLOOMS = 1500
const BLOOM_R_M: Record<Level, number> = { good: 0.7, moderate: 0.9, poor: 1.2, alert: 1.5 }
const HALF_LIFE_S = 45 // a brief whiff is gone within a couple of minutes
const MAX_PARTICLES = 4000
const MAX_PER_EVENT = 40
const SIGMA = 0.75 // m/√s: ~0.1 m per frame at 60 fps, so puffs thin out visibly
const DRIFT = 0.06 // m/s up the forecast gradient
const SPRITE_R_M = 0.5 // large and soft so neighbours merge into haze rather than speckle
const GAIN_2D: Record<Level, number> = { good: 0.3, moderate: 0.8, poor: 1, alert: 1.2 }

export class Plume {
  private blooms: Bloom[] = []
  private parts: Particle[] = []
  private seen = new Set<string>()
  private firstKey: string | null = null
  private mask: FreeMask | null = null
  private sprites = new Map<Level, HTMLCanvasElement>()
  private rng = 1234567

  setMask(mask: FreeMask | null) { this.mask = mask }

  get count() { return this.parts.length }

  /** Forget everything (new session, new source). */
  reset() { this.blooms = []; this.parts = []; this.seen.clear(); this.firstKey = null }

  /**
   * Bring the cloud in line with the trail: new points are emitted; if the trail was
   * replaced (replay scrub, session change) everything is rebuilt from it with each
   * point's age applied, so the cloud looks as it would have at that moment.
   */
  sync(trail: TrailPoint[], now: number) {
    const key = (p: TrailPoint) => `${p.ts}|${p.wearer ?? ''}`
    const first = trail.length ? key(trail[0]) : null
    const lastKey = trail.length ? key(trail[trail.length - 1]) : null
    const replaced = first !== this.firstKey || (lastKey && !this.seen.has(lastKey) && trail.length < this.seen.size)
    if (replaced) { this.reset(); this.firstKey = first }
    for (const p of trail) {
      const k = key(p)
      if (this.seen.has(k)) continue
      this.seen.add(k)
      this.emit(p, now - Date.parse(p.ts))
    }
  }

  private recent: number[] = [] // last readings, for a running background estimate
  private emit(p: TrailPoint, ageMs: number) {
    const [a] = SCALE.bands
    this.recent.push(p.voc); if (this.recent.length > 90) this.recent.shift()
    const background = Math.min(...this.recent)
    const lift = SCALE.unit === 'index' ? 10 : 25 // what counts as "above background"
    if (!(p.voc >= background + lift) && !(p.voc >= a)) return
    const lv = level(p.voc)
    if (p.voc >= a) {
      this.blooms.push({ x: p.x, y: p.y, t: Date.now() - Math.max(0, ageMs), level: lv })
      if (this.blooms.length > MAX_BLOOMS) this.blooms.splice(0, this.blooms.length - MAX_BLOOMS)
    }
    // light readings drift a little; elevated ones a lot
    const n = p.voc >= a ? Math.min(MAX_PER_EVENT, Math.ceil((8 * (p.voc - a)) / a) + 2) : Math.min(3, 1 + Math.floor((p.voc - background) / (2 * lift)))
    const ageS = Math.max(0, ageMs / 1000)
    for (let i = 0; i < n; i++) {
      const q: Particle = { x: p.x, y: p.y, born: Date.now() - ageMs, level: lv }
      // a point from the past has already wandered: a coarse walk covering its age
      if (ageS > 0.5) {
        const steps = Math.min(40, Math.ceil(ageS / 5))
        const dt = ageS / steps
        for (let k = 0; k < steps; k++) this.walk(q, dt, null)
      }
      this.parts.push(q)
    }
    if (this.parts.length > MAX_PARTICLES) this.parts.splice(0, this.parts.length - MAX_PARTICLES)
  }

  private rand() { this.rng = (this.rng * 1103515245 + 12345) & 0x7fffffff; return this.rng / 0x7fffffff }
  private gauss() { return Math.sqrt(-2 * Math.log(this.rand() + 1e-9)) * Math.cos(2 * Math.PI * this.rand()) }

  private free(x: number, y: number): boolean {
    const m = this.mask
    if (!m) return true
    const { origin, res, w, h } = m.meta
    const c = Math.floor((x - origin[0]) / res), r = h - 1 - Math.floor((y - origin[1]) / res)
    if (c < 0 || r < 0 || c >= w || r >= h) return false
    return m.data[r * w + c] === 1
  }

  private walk(q: Particle, dt: number, grad: ((x: number, y: number) => [number, number] | null) | null) {
    const s = SIGMA * Math.sqrt(dt)
    let dx = this.gauss() * s, dy = this.gauss() * s
    const g = grad?.(q.x, q.y)
    if (g) { dx += g[0] * DRIFT * dt; dy += g[1] * DRIFT * dt }
    // walls block: try the full step, then each axis alone, else stay
    if (this.free(q.x + dx, q.y + dy)) { q.x += dx; q.y += dy }
    else if (this.free(q.x + dx, q.y)) q.x += dx
    else if (this.free(q.x, q.y + dy)) q.y += dy
  }

  /** Advance the cloud by `dt` seconds; `grad` gives the unit direction of increasing forecast, if any. */
  step(dt: number, grad: ((x: number, y: number) => [number, number] | null) | null, now: number) {
    const d = Math.min(0.25, Math.max(0, dt))
    for (const q of this.parts) this.walk(q, d, grad)
    const cutoff = now - HALF_LIFE_S * 1000 * 4.5 // < 5% alpha: gone
    if (this.parts.length && this.parts[0].born < cutoff) this.parts = this.parts.filter((q) => q.born >= cutoff)
    if (this.blooms.length && this.blooms[0].t < cutoff) this.blooms = this.blooms.filter((b) => b.t >= cutoff)
  }

  private sprite(lv: Level): HTMLCanvasElement {
    let c = this.sprites.get(lv)
    if (c) return c
    c = document.createElement('canvas'); c.width = c.height = 32
    const g = c.getContext('2d')!
    const [r, gg, b] = rampColor({ good: 0.3, moderate: 0.5, poor: 0.7, alert: 0.9 }[lv])
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16)
    grad.addColorStop(0, `rgba(${r},${gg},${b},1)`); grad.addColorStop(0.5, `rgba(${r},${gg},${b},0.45)`); grad.addColorStop(1, `rgba(${r},${gg},${b},0)`)
    g.fillStyle = grad; g.fillRect(0, 0, 32, 32)
    this.sprites.set(lv, c)
    return c
  }

  /**
   * The cloud as 3D points for the volumetric view: every particle and bloom becomes a
   * short vertical stack around sensor height, spread growing with level. World axes
   * x, height, −y; colours from the band ramp; alpha as drawn in 2D, scaled by level.
   */
  snapshot(now: number, eyeH = 1.2): { positions: Float32Array; colors: Float32Array; alphas: Float32Array; phases: Float32Array } {
    const spread: Record<Level, number> = { good: 0.2, moderate: 0.3, poor: 0.45, alert: 0.6 }
    const gain: Record<Level, number> = { good: 0.6, moderate: 0.8, poor: 1, alert: 1.2 }
    const pos: number[] = [], col: number[] = [], alp: number[] = [], ph: number[] = []
    const rgb = (lv: Level) => rampColor({ good: 0.3, moderate: 0.5, poor: 0.7, alert: 0.9 }[lv]).map((v) => v / 255)
    const hash = (i: number, k: number) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x) }
    let i = 0
    const add = (x: number, y: number, lv: Level, a: number, r: number, n: number) => {
      const [cr, cg, cb] = rgb(lv)
      for (let k = 0; k < n; k++, i++) {
        const ang = hash(i, 1) * Math.PI * 2, rad = Math.sqrt(hash(i, 2)) * r
        pos.push(x + Math.cos(ang) * rad, Math.max(0.15, eyeH + (hash(i, 3) - 0.5) * 2 * spread[lv]), -(y + Math.sin(ang) * rad))
        col.push(cr, cg, cb)
        alp.push(a * gain[lv])
        ph.push(hash(i, 4) * Math.PI * 2)
      }
    }
    for (const q of this.parts) {
      const a = 0.22 * Math.pow(0.5, (now - q.born) / (HALF_LIFE_S * 1000))
      if (a < 0.01) continue
      add(q.x, q.y, q.level, a, 0.08, 1)
    }
    for (const b of this.blooms) {
      const a = 0.3 * Math.pow(0.5, (now - b.t) / (HALF_LIFE_S * 1000))
      if (a < 0.01) continue
      add(b.x, b.y, b.level, a, BLOOM_R_M[b.level] * 0.8, 6)
    }
    return { positions: Float32Array.from(pos), colors: Float32Array.from(col), alphas: Float32Array.from(alp), phases: Float32Array.from(ph) }
  }

  /** Draw blooms and particles (additive) with a world→screen mapping. */
  draw(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, scale: number, now: number) {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const b of this.blooms) {
      const age = now - b.t
      const pop = Math.min(1, age / 600) // swells in over the first moments
      const r = BLOOM_R_M[b.level] * scale * (0.5 + 0.5 * pop)
      const a = 0.5 * Math.pow(0.5, age / (HALF_LIFE_S * 1000))
      if (a < 0.012) continue
      ctx.globalAlpha = a
      ctx.drawImage(this.sprite(b.level), sx(b.x) - r, sy(b.y) - r, r * 2, r * 2)
    }
    ctx.globalAlpha = 1
    const d = Math.max(3, SPRITE_R_M * 2 * scale)
    for (const q of this.parts) {
      const a = 0.22 * GAIN_2D[q.level] * Math.pow(0.5, (now - q.born) / (HALF_LIFE_S * 1000))
      if (a < 0.008) continue
      ctx.globalAlpha = a
      ctx.drawImage(this.sprite(q.level), sx(q.x) - d / 2, sy(q.y) - d / 2, d, d)
    }
    ctx.restore()
  }
}
