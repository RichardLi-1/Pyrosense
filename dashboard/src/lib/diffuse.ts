// The displayed gas field keeps moving between /heatmap updates: a coarse (0.2 m) copy of
// the latest field diffuses through free space each tick (walls block), decays slowly
// toward background, and blends toward each new update instead of snapping to it. What
// the eye sees is therefore a cloud that grows outward and softens in real time.
import { SCALE } from './colors'
import type { Grid } from './heatImage'

export type DisplayGrid = Grid & { prior: (i: number) => number; alphaBy: Float32Array }

const RES = 0.2 // m; diffusion is stable per 100 ms tick at D = 0.08 here
const D = 0.08 // m²/s
const DECAY_S = 90 // toward background
const BLEND = 0.18 // per tick toward a fresh update
const TICK_MS = 100

export class DisplayField {
  private cols = 0; private rows = 0; private x0 = 0; private y0 = 0
  private V: Float32Array | null = null // shown value
  private T: Float32Array | null = null // latest target
  private S: Uint8Array | null = null // supported by data (vs. only spread here)
  private A: Float32Array | null = null // target alpha
  private F: Uint8Array | null = null // free (passable) cells
  private base = 0
  private last = 0
  private dirty = false

  /** Replace the target from a source grid: `value(i)`, `support(i)`, `alpha(i)` on that grid. */
  setTarget(g: Grid, value: (i: number) => number, support: (i: number) => boolean, alpha: (i: number) => number,
            free: (x: number, y: number) => boolean, base: number) {
    const k = Math.max(1, Math.round(RES / g.res))
    const cols = Math.ceil(g.cols / k), rows = Math.ceil(g.rows / k)
    const same = this.V && cols === this.cols && rows === this.rows && Math.abs(g.x0 - this.x0) < 1e-6 && Math.abs(g.y0 - this.y0) < 1e-6
    const T = new Float32Array(cols * rows), S = new Uint8Array(cols * rows), A = new Float32Array(cols * rows), F = new Uint8Array(cols * rows)
    const n = new Uint16Array(cols * rows)
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c, j = Math.floor(r / k) * cols + Math.floor(c / k)
      const v = value(i)
      if (Number.isNaN(v)) continue
      T[j] += v; n[j]++
      if (support(i)) { S[j] = 1; A[j] = Math.max(A[j], alpha(i)) }
    }
    for (let j = 0; j < T.length; j++) {
      T[j] = n[j] ? T[j] / n[j] : base
      const c = j % cols, r = (j - c) / cols
      F[j] = free(g.x0 + (c + 0.5) * RES, g.y0 + (r + 0.5) * RES) ? 1 : 0
    }
    this.base = base
    this.T = T; this.A = A; this.F = F
    if (!same) { this.V = Float32Array.from(T); this.S = S; this.cols = cols; this.rows = rows; this.x0 = g.x0; this.y0 = g.y0 }
    else { const S0 = this.S!; for (let j = 0; j < S.length; j++) if (S[j]) S0[j] = 1 }
    this.dirty = true
  }

  clear() { this.V = this.T = this.S = this.A = this.F = null; this.dirty = true }

  /** Advance to `now` (ms). Returns true when the display changed and should be redrawn. */
  tick(now: number, live: boolean): boolean {
    if (!this.V || !this.T || !this.S || !this.F) { const d = this.dirty; this.dirty = false; return d }
    if (now - this.last < TICK_MS) return false
    // explicit diffusion is only stable for D·dt/res² ≤ 0.25; a dropped frame must not blow the field up
    const dt = Math.min(0.2 * RES * RES / D, this.last ? (now - this.last) / 1000 : TICK_MS / 1000)
    this.last = now
    if (!live) { const d = this.dirty; this.dirty = false; return d }
    const { cols, rows, V, T, S, F, base } = this
    // blend toward the latest data where it has any
    for (let j = 0; j < V.length; j++) if (S[j]) V[j] += (T[j] - V[j]) * BLEND
    // diffuse through free cells; a wall neighbour contributes no flux
    const a = (D * dt) / (RES * RES)
    const N = Float32Array.from(V)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const j = r * cols + c
      if (!F[j]) continue
      let sum = 0
      const nb = [c > 0 ? j - 1 : -1, c < cols - 1 ? j + 1 : -1, r > 0 ? j - cols : -1, r < rows - 1 ? j + cols : -1]
      for (const q of nb) sum += q >= 0 && F[q] ? V[q] - V[j] : 0
      N[j] = V[j] + a * sum
    }
    const thresh = base + 0.1 * SCALE.bands[0]
    for (let j = 0; j < V.length; j++) {
      V[j] = N[j] + (base - N[j]) * (dt / DECAY_S)
      if (!S[j] && V[j] > thresh && F[j]) S[j] = 2 // reached by spreading, not measured
    }
    this.dirty = false
    return true
  }

  /** The grid to draw: est = shown value, thin where nothing (measured or spread) reaches. */
  grid(): DisplayGrid | null {
    const { V, S, A, cols, rows, base } = this
    if (!V || !S || !A) return null
    const den = new Float32Array(V.length), alphaBy = new Float32Array(V.length)
    for (let j = 0; j < V.length; j++) {
      if (!S[j]) continue
      den[j] = 1
      const spread = Math.min(1, Math.max(0, (V[j] - base) / SCALE.bands[0]))
      alphaBy[j] = S[j] === 1 ? Math.max(A[j], spread * 0.8) : spread * 0.8
    }
    return { x0: this.x0, y0: this.y0, res: RES, cols, rows, num: V, den, prior: (i) => V[i], alphaBy }
  }
}
