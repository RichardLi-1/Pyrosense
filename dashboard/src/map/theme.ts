import { DARK_INK, LIGHT_INK, type Ink } from '../lib/heatImage'

export type RGBA = [number, number, number, number]

export type MapTheme = {
  free: RGBA
  wall: RGBA
  grid: string | null // 1 m grid line colour
  trail: string
  badge: string // wearer badge fill (single wearer)
  crew: string[] // badge fills per wearer when there are several
  icon: string // hard hat on the badge
  halo: string
  alert: string
  next: string // next-best sample marker
  heatBlend: GlobalCompositeOperation
  heatAlpha: number
  ink: Ink // contour line colours over the thermal field
  // 3D
  floor3d: string
  wall3d: string
  wallTop3d: string
  glow3d: 'additive' | 'normal'
}

export const THEMES = {
  focus: {
    free: [255, 255, 255, 14], wall: [226, 230, 238, 235], grid: null,
    trail: 'rgba(255,255,255,0.22)', badge: '#ffffff', crew: ['#ffffff', '#7dd3fc', '#c4b5fd', '#e2e8f0'], icon: '#0b0e14', halo: 'rgba(255,255,255,0.16)', alert: '#ff4d5e', next: '#5eead4',
    heatBlend: 'source-over', heatAlpha: 0.96, ink: LIGHT_INK,
    floor3d: '#141922', wall3d: '#3a4150', wallTop3d: '#e2e6ee', glow3d: 'additive',
  },
  paper: {
    free: [255, 255, 255, 255], wall: [24, 28, 36, 255], grid: 'rgba(24,28,36,0.05)',
    trail: 'rgba(24,28,36,0.28)', badge: '#1f4fff', crew: ['#1f4fff', '#111827', '#7c3aed', '#0e7490'], icon: '#ffffff', halo: 'rgba(31,79,255,0.14)', alert: '#e5263c', next: '#0f766e',
    heatBlend: 'source-over', heatAlpha: 0.92, ink: DARK_INK,
    floor3d: '#ffffff', wall3d: '#d9d4c8', wallTop3d: '#181c24', glow3d: 'normal',
  },
  dusk: {
    free: [255, 255, 255, 14], wall: [160, 170, 200, 200], grid: 'rgba(255,255,255,0.025)',
    trail: 'rgba(170,180,255,0.25)', badge: '#9db4ff', crew: ['#9db4ff', '#e0e7ff', '#f0abfc', '#a5f3fc'], icon: '#06070d', halo: 'rgba(157,180,255,0.18)', alert: '#ff5d6c', next: '#5eead4',
    heatBlend: 'source-over', heatAlpha: 0.96, ink: LIGHT_INK,
    floor3d: '#161a2c', wall3d: '#3b4266', wallTop3d: '#a0aac8', glow3d: 'additive',
  },
} satisfies Record<string, MapTheme>

/** Wearer badge: a circle with a hard hat, centred on (cx, cy). */
export function drawHardHat(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, badge: string, icon: string) {
  ctx.fillStyle = badge
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = icon
  const base = cy + 0.22 * r
  // dome
  ctx.beginPath(); ctx.arc(cx, base, 0.5 * r, Math.PI, 0); ctx.closePath(); ctx.fill()
  // brim
  const bw = 0.76 * r, bh = 0.16 * r
  ctx.beginPath(); ctx.roundRect(cx - bw, base - 0.02 * r, bw * 2, bh, bh / 2); ctx.fill()
  // centre ridge (cut out in badge colour)
  ctx.fillStyle = badge
  ctx.fillRect(cx - 0.07 * r, base - 0.5 * r, 0.14 * r, 0.42 * r)
}
