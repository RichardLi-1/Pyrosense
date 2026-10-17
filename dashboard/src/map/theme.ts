export type RGBA = [number, number, number, number]

export type MapTheme = {
  free: RGBA
  wall: RGBA
  grid: string | null // 1 m grid line colour
  trail: string
  person: string
  halo: string
  alert: string
  heatBlend: GlobalCompositeOperation
  heatAlpha: number
  heatBlur: number // px
}

export const THEMES = {
  focus: {
    free: [255, 255, 255, 10], wall: [226, 230, 238, 235], grid: null,
    trail: 'rgba(255,255,255,0.22)', person: '#ffffff', halo: 'rgba(255,255,255,0.18)', alert: '#ff4d5e',
    heatBlend: 'screen', heatAlpha: 0.9, heatBlur: 10,
  },
  paper: {
    free: [255, 255, 255, 255], wall: [24, 28, 36, 255], grid: 'rgba(24,28,36,0.05)',
    trail: 'rgba(24,28,36,0.28)', person: '#1f4fff', halo: 'rgba(31,79,255,0.16)', alert: '#e5263c',
    heatBlend: 'multiply', heatAlpha: 0.75, heatBlur: 8,
  },
  dusk: {
    free: [255, 255, 255, 14], wall: [160, 170, 200, 200], grid: 'rgba(255,255,255,0.025)',
    trail: 'rgba(170,180,255,0.25)', person: '#9db4ff', halo: 'rgba(157,180,255,0.2)', alert: '#ff5d6c',
    heatBlend: 'lighter', heatAlpha: 0.6, heatBlur: 14,
  },
} satisfies Record<string, MapTheme>
