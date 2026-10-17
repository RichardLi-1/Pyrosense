// Everything drawn "in cells": a 2D canvas at grid resolution (1 px = 1 cell) that the post
// pass samples per cell. Hint glyphs, the warning ring, the lungs, callout leaders, the laptop.
import * as THREE from 'three'
import { COLORS, clamp, lerp, rng, span } from './util'

type Seg = { x1: number; y1: number; x2: number; y2: number; level: number; parent: number; rnd: number; len: number }
type Pt = [number, number]

const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const RGB = {
  text: hex(COLORS.text), good: hex(COLORS.good), moderate: hex(COLORS.moderate),
  poor: hex(COLORS.poor), alert: hex(COLORS.alert), accent: hex(COLORS.accent),
}
type Col = number[]
const rgba = (c: Col, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a).toFixed(3)})`
const mix = (a: Col, b: Col, t: number): Col => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const frac = (v: number) => v - Math.floor(v)

// a little floor plan used by the hint glyphs (34 x 22 cells)
const PLAN: Pt[][] = [
  [[3, 3], [31, 3], [31, 19], [21, 19], [21, 11], [13, 11], [13, 19], [3, 19], [3, 3]],
  [[13, 3], [13, 8]],
  [[21, 3], [21, 8]],
]
const WALK: Pt[] = [[5, 17], [5, 6], [11, 6], [11, 9], [17, 9], [17, 6], [29, 6], [29, 16], [23, 16]]

function polyLen(pts: Pt[]) {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return l
}
function pointAt(pts: Pt[], u: number): Pt {
  const total = polyLen(pts)
  let d = clamp(u) * total
  for (let i = 1; i < pts.length; i++) {
    const sl = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    if (d <= sl) {
      const t = sl === 0 ? 0 : d / sl
      return [lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)]
    }
    d -= sl
  }
  return pts[pts.length - 1]
}

export class Hud {
  readonly canvas = document.createElement('canvas')
  readonly texture: THREE.CanvasTexture
  W = 1
  H = 1
  private ctx: CanvasRenderingContext2D
  private drew = false
  private had = false
  private segs: Seg[] = []
  private chains: number[][] = []
  private lobes: Pt[][] = []

  constructor() {
    this.ctx = this.canvas.getContext('2d')!
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.minFilter = THREE.NearestFilter
    this.texture.magFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    this.buildLungs()
  }

  resize(W: number, H: number) {
    this.W = W
    this.H = H
    this.canvas.width = W
    this.canvas.height = H
    this.had = true
  }
  begin() {
    if (this.had) this.ctx.clearRect(0, 0, this.W, this.H)
    this.drew = false
  }
  end() {
    if (this.drew || this.had) this.texture.needsUpdate = true
    this.had = this.drew
  }

  // ---- primitives ---------------------------------------------------------
  private line(x1: number, y1: number, x2: number, y2: number, c: Col, a: number, w = 1) {
    if (a <= 0.002) return
    const ctx = this.ctx
    ctx.strokeStyle = rgba(c, a)
    ctx.lineWidth = w
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x1 + 0.5, y1 + 0.5)
    ctx.lineTo(x2 + 0.5, y2 + 0.5)
    ctx.stroke()
    this.drew = true
  }
  private dot(x: number, y: number, c: Col, a: number, size = 1) {
    if (a <= 0.002) return
    this.ctx.fillStyle = rgba(c, a)
    this.ctx.fillRect(Math.floor(x), Math.floor(y), size, size)
    this.drew = true
  }
  private dotted(x1: number, y1: number, x2: number, y2: number, c: Col, a: number, step = 2) {
    const l = Math.hypot(x2 - x1, y2 - y1)
    const n = Math.max(1, Math.floor(l / step))
    for (let i = 0; i <= n; i++) this.dot(lerp(x1, x2, i / n), lerp(y1, y2, i / n), c, a)
  }
  private poly(pts: Pt[], c: Col, a: number, f = 1, ox = 0, oy = 0, s = 1) {
    if (a <= 0.002 || f <= 0) return
    const total = polyLen(pts)
    let left = clamp(f) * total
    for (let i = 1; i < pts.length && left > 0; i++) {
      const sl = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
      const t = Math.min(1, left / sl)
      this.line(ox + pts[i - 1][0] * s, oy + pts[i - 1][1] * s, ox + lerp(pts[i - 1][0], pts[i][0], t) * s, oy + lerp(pts[i - 1][1], pts[i][1], t) * s, c, a)
      left -= sl
    }
  }
  private ring(cx: number, cy: number, r: number, c: Col, a: number, dashed = false) {
    if (a <= 0.002) return
    const n = Math.max(8, Math.round(r * 6))
    for (let i = 0; i < n; i++) {
      if (dashed && i % 2) continue
      const th = (i / n) * Math.PI * 2
      this.dot(cx + Math.cos(th) * r, cy + Math.sin(th) * r, c, a)
    }
  }

  // ---- hint glyphs ----------------------------------------------------------
  /** Draw glyph `i` inside a box at (bx, by) scaled by s (34 x 22 cells at s = 1). */
  hint(i: number, bx: number, by: number, s: number, a: number, tl: number, reduced: boolean) {
    if (a <= 0.01) return
    const T = RGB.text
    const planDim = (al: number) => { for (const p of PLAN) this.poly(p, T, al * a, 1, bx, by, s) }
    const P = (p: Pt): Pt => [bx + p[0] * s, by + p[1] * s]
    const anim = reduced ? 0.35 : tl
    switch (i) {
      case 0: {
        const f = reduced ? 1 : clamp(tl / 2.4)
        for (const p of PLAN) this.poly(p, T, 0.95 * a, f, bx, by, s)
        const u = reduced ? 0.6 : frac(tl / 5)
        const trail = WALK.slice(0)
        this.poly(trail, RGB.good, 0.45 * a, u, bx, by, s)
        const d = P(pointAt(WALK, u))
        this.dot(d[0], d[1], T, a)
        break
      }
      case 1: {
        planDim(0.4)
        const u = reduced ? 0.8 : frac(tl / 6)
        const n = 18
        for (let k = 0; k <= Math.floor(u * n); k++) {
          const q = P(pointAt(WALK, k / n))
          const c = k < 7 ? RGB.good : k < 12 ? RGB.moderate : RGB.poor
          this.dot(q[0] - s, q[1] - s, c, 0.55 * a, Math.max(1, Math.round(3 * s)))
        }
        const d = P(pointAt(WALK, u))
        this.dot(d[0], d[1], T, a)
        break
      }
      case 2: {
        planDim(0.3)
        const c = P([17, 12])
        for (const ph of [0, 0.5]) {
          const k = reduced ? 0.5 : frac(anim / 1.3 + ph)
          this.ring(c[0], c[1], (2 + k * 9) * s, RGB.alert, (1 - k) * 0.9 * a)
        }
        this.dot(c[0], c[1], T, a)
        const b1 = P([8, 1]), b2 = P([26, 1])
        this.line(b1[0], b1[1], b2[0], b2[1], RGB.alert, 0.85 * a)
        break
      }
      case 3: {
        planDim(0.45)
        for (let x = 22; x <= 30; x++) for (let y = 4; y <= 10; y++) if ((x + y) % 3 === 0) { const q = P([x, y]); this.dot(q[0], q[1], RGB.poor, 0.7 * a) }
        const c = P([26, 7])
        const pulse = reduced ? 0 : 0.4 * (0.5 + 0.5 * Math.sin(anim * 3))
        this.ring(c[0], c[1], (3 + pulse) * s, RGB.alert, 0.95 * a, true)
        const d = P([9, 15])
        this.poly([[5, 17], [5, 15], [9, 15]], RGB.good, 0.45 * a, 1, bx, by, s)
        this.dot(d[0], d[1], T, a)
        break
      }
      case 4: {
        planDim(0.45)
        const u = reduced ? 0.6 : frac(tl / 6)
        this.poly(WALK, RGB.accent, 0.8 * a, u, bx, by, s)
        const d = P(pointAt(WALK, u))
        this.dot(d[0], d[1], T, a)
        const t1 = P([3, 21]), t2 = P([31, 21])
        this.line(t1[0], t1[1], t2[0], t2[1], T, 0.3 * a)
        const tick = P([3 + 28 * 0.72, 21])
        this.dot(tick[0], tick[1], RGB.alert, 0.9 * a)
        const h = P([3 + 28 * u, 21])
        this.dot(h[0], h[1], T, a)
        this.dot(h[0], h[1] - 1, T, a)
        break
      }
    }
  }

  // ---- warning ring -------------------------------------------------------
  warnRing(a: number, t: number, reduced: boolean) {
    if (a <= 0.01) return
    const cx = this.W / 2, cy = this.H / 2
    const base = Math.min(this.W, this.H) * 0.3
    if (reduced) { this.ring(cx, cy, base, RGB.alert, a); return }
    for (const ph of [0, 0.5]) {
      const k = frac(t / 1.1 + ph)
      this.ring(cx, cy, base + k * base * 0.4, RGB.alert, (1 - k) * a)
    }
  }

  // ---- lungs --------------------------------------------------------------
  private buildLungs() {
    const r = rng(7)
    const segs = this.segs
    const push = (x1: number, y1: number, x2: number, y2: number, level: number, parent: number) => {
      segs.push({ x1, y1, x2, y2, level, parent, rnd: r(), len: Math.hypot(x2 - x1, y2 - y1) })
      return segs.length - 1
    }
    push(0.5, 0.02, 0.5, 0.2, 0, -1)
    const branch = (x: number, y: number, a: number, len: number, level: number, parent: number) => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len
      const id = push(x, y, x2, y2, level, parent)
      if (level >= 4) return
      for (const sgn of [-1, 1]) {
        let na = a + sgn * (0.42 + r() * 0.3)
        na = lerp(na, Math.PI / 2, 0.16)
        branch(x2, y2, na, len * (0.64 + r() * 0.14), level + 1, id)
      }
    }
    branch(0.5, 0.2, Math.PI / 2 + 0.66, 0.19, 1, 0)
    branch(0.5, 0.2, Math.PI / 2 - 0.66, 0.19, 1, 0)
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].level !== 4) continue
      const chain: number[] = []
      for (let k = i; k >= 0; k = segs[k].parent) chain.unshift(k)
      this.chains.push(chain)
    }
    const lobe = (cx: number, mirror: boolean) => {
      const pts: Pt[] = []
      for (let i = 0; i <= 72; i++) {
        const th = (i / 72) * Math.PI * 2
        const c = Math.cos(th), s = Math.sin(th)
        let x = c * 0.2 * (c > 0 ? 0.55 : 1)
        if (mirror) x = -x
        pts.push([cx + x, 0.6 + s * 0.36 * (s < 0 ? 0.88 : 1)])
      }
      return pts
    }
    this.lobes = [lobe(0.29, false), lobe(0.71, true)]
  }

  /** The lungs, centred at (cx, cy), `hb` cells tall. q = 0..1 through the beat. */
  lungs(cx: number, cy: number, hb: number, q: number, a: number, t: number, reduced: boolean) {
    if (a <= 0.01) return
    const wb = hb * 0.95
    const s = lerp(2.3, 1, span(q, 0, 0.2))
    const X = (nx: number) => cx + (nx - 0.5) * wb * s
    const Y = (ny: number) => cy + (ny - 0.5) * hb * s
    const draw = span(q, 0.02, 0.34)
    const diss = span(q, 0.86, 1)
    // shoulders / neck: faint construction lines
    const sh = span(draw, 0.2, 0.6) * 0.22 * a * (1 - diss)
    this.dotted(X(0.5 - 0.035), Y(-0.04), X(0.5 - 0.035), Y(0.02), RGB.text, sh)
    this.dotted(X(0.5 + 0.035), Y(-0.04), X(0.5 + 0.035), Y(0.02), RGB.text, sh)
    this.dotted(X(0.44), Y(0.1), X(0.06), Y(0.3), RGB.text, sh)
    this.dotted(X(0.56), Y(0.1), X(0.94), Y(0.3), RGB.text, sh)
    const lo = span(draw, 0.3, 0.7) * 0.28 * a * (1 - diss)
    for (const lobe of this.lobes) for (let i = 0; i < lobe.length; i += 2) this.dot(X(lobe[i][0]), Y(lobe[i][1]), RGB.text, lo)
    // airways: draw level by level, redden tips first
    for (const sg of this.segs) {
      const f = clamp((draw - sg.level * 0.2) / 0.2)
      if (f <= 0 || sg.rnd > 1 - diss) continue
      const start = 0.3 + (4 - sg.level) * 0.1
      const red = span(q, start, start + 0.16)
      const c = mix(RGB.text, RGB.alert, red)
      const al = a * (sg.level <= 1 ? 1 : 0.8)
      this.line(X(sg.x1), Y(sg.y1), X(lerp(sg.x1, sg.x2, f)), Y(lerp(sg.y1, sg.y2, f)), c, al)
    }
    // smoke drifting into the airways
    if (!reduced && q > 0.12 && diss < 1) {
      const pa = 0.65 * span(q, 0.12, 0.26) * (1 - diss) * a
      for (let k = 0; k < 40; k++) {
        const chain = this.chains[(k * 7) % this.chains.length]
        const u = frac(t * 0.08 + k * 0.137)
        let total = 0
        for (const id of chain) total += this.segs[id].len
        let d = u * total
        for (const id of chain) {
          const sg = this.segs[id]
          if (d <= sg.len) {
            const tt = d / sg.len
            const c = mix([150, 150, 156], RGB.alert, span(q, 0.42, 0.75) * u)
            this.dot(X(lerp(sg.x1, sg.x2, tt)), Y(lerp(sg.y1, sg.y2, tt)), c, pa)
            break
          }
          d -= sg.len
        }
      }
    }
  }

  // ---- callout leaders ----------------------------------------------------
  leader(x1: number, y1: number, x2: number, y2: number, a: number) {
    if (a <= 0.01) return
    this.dotted(x1, y1, x2, y2, RGB.text, 0.5 * a, 2)
    this.dot(x2 - 0.5, y2 - 0.5, RGB.text, a, 2)
  }

  // ---- laptop outline + table ---------------------------------------------
  laptop(x: number, y: number, w: number, h: number, d: number, a: number) {
    if (a <= 0.01 || d <= 0) return
    const T = RGB.text
    const screen: Pt[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]
    this.poly(screen, T, 0.9 * a, span(d, 0, 0.7))
    const base = span(d, 0.6, 1)
    if (base > 0) {
      const by = y + h + 2.5
      this.line(x, y + h, x - 3, by, T, 0.7 * a * base)
      this.line(x + w, y + h, x + w + 3, by, T, 0.7 * a * base)
      this.line(x - 3, by, lerp(x - 3, x + w + 3, base), by, T, 0.9 * a)
      this.dotted(0, by + 2, this.W, by + 2, T, 0.22 * a * base, 2)
    }
  }
}
