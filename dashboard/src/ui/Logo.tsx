/** The mark: a pair of goggle lenses traced in dots, the way the LiDAR traces a room. */

/** Points at equal arc length around a rounded rectangle, clockwise from top centre. */
function dotsAround(x: number, y: number, w: number, h: number, r: number, spacing: number): [number, number][] {
  const sw = w - 2 * r, sh = h - 2 * r, arc = (Math.PI / 2) * r
  const perimeter = 2 * sw + 2 * sh + 4 * arc
  const n = 2 * Math.round(perimeter / spacing / 2) // even count, so the layout mirrors left/right
  const step = perimeter / n
  // segments clockwise from top centre: half top edge, TR arc, right edge, BR arc, bottom edge, BL arc, left edge, TL arc, half top edge
  const at = (s: number): [number, number] => {
    let d = s
    if (d < sw / 2) return [x + w / 2 + d, y]
    d -= sw / 2
    if (d < arc) { const a = -Math.PI / 2 + d / r; return [x + w - r + r * Math.cos(a), y + r + r * Math.sin(a)] }
    d -= arc
    if (d < sh) return [x + w, y + r + d]
    d -= sh
    if (d < arc) { const a = d / r; return [x + w - r + r * Math.cos(a), y + h - r + r * Math.sin(a)] }
    d -= arc
    if (d < sw) return [x + w - r - d, y + h]
    d -= sw
    if (d < arc) { const a = Math.PI / 2 + d / r; return [x + r + r * Math.cos(a), y + h - r + r * Math.sin(a)] }
    d -= arc
    if (d < sh) return [x, y + h - r - d]
    d -= sh
    if (d < arc) { const a = Math.PI + d / r; return [x + r + r * Math.cos(a), y + r + r * Math.sin(a)] }
    d -= arc
    return [x + r + d, y]
  }
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) out.push(at(i * step))
  return out
}

const W = 86, H = 46, CX = W / 2
const SPACING = 2.5, DOT = 0.78, INSET = 2.4
// outer frame, centred; lenses mirrored about the vertical centre line
const FRAME = { x: 2, y: 2, w: W - 4, h: H - 4, r: 10 }
const LENS = { w: 32, h: 26, r: 7, gap: 6 }
const LENS_Y = (H - LENS.h) / 2
const LEFT_X = CX - LENS.gap / 2 - LENS.w, RIGHT_X = CX + LENS.gap / 2

function ring(x: number, y: number, w: number, h: number, r: number) {
  return [
    ...dotsAround(x, y, w, h, r, SPACING),
    ...dotsAround(x + INSET, y + INSET, w - 2 * INSET, h - 2 * INSET, r - INSET, SPACING),
  ]
}

const DOTS: [number, number][] = [
  ...ring(FRAME.x, FRAME.y, FRAME.w, FRAME.h, FRAME.r),
  ...ring(LEFT_X, LENS_Y, LENS.w, LENS.h, LENS.r),
  ...ring(RIGHT_X, LENS_Y, LENS.w, LENS.h, LENS.r),
]

export default function Logo({ height = 20 }: { height?: number }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} height={height} width={(height * W) / H} aria-label="PyroSense" role="img" fill="currentColor">
      {DOTS.map(([x, y], i) => <circle key={i} cx={x.toFixed(2)} cy={y.toFixed(2)} r={DOT} />)}
    </svg>
  )
}
