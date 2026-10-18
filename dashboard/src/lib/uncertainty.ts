// Uncertainty layer: a fog over the floor whose density is the GP posterior sd, relative
// to the prior sd (σf). Clear where the field is well measured, dense where it's a guess.
import type { Field } from './gp'
import type { HeatImage } from './heatImage'
import { layerGrid } from './heatImage'

export function uncertaintyImage(field: Field, rgb: [number, number, number] = [196, 206, 228], maxAlpha = 0.45): HeatImage | null {
  if (!(field.sigmaF > 0)) return null
  const g = layerGrid(field, field.sd, null, 0.1) // bilinear upsample so the fog is soft
  const canvas = document.createElement('canvas')
  canvas.width = g.cols; canvas.height = g.rows
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(g.cols, g.rows)
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    const v = g.num[r * g.cols + c]
    const u = Number.isFinite(v) ? Math.min(1, Math.max(0, v / field.sigmaF)) : 1
    if (u < 0.15) continue
    const o = ((g.rows - 1 - r) * g.cols + c) * 4 // image row 0 = max y
    img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]
    img.data[o + 3] = Math.round(255 * maxAlpha * ((u - 0.15) / 0.85) ** 1.3)
  }
  ctx.putImageData(img, 0, 0)
  return { canvas, x0: g.x0, y1: g.y0 + g.rows * g.res, w: g.cols * g.res, h: g.rows * g.res }
}
