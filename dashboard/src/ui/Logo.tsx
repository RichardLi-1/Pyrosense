/** The mark: a pair of goggle lenses traced in dots, the way the LiDAR traces a room. */
export default function Logo({ height = 20 }: { height?: number }) {
  // Each outline is two concentric dotted rings; dots are round dashes on a stroke.
  const ring = (x: number, y: number, w: number, h: number, r: number, gap: number, dot: number) => (
    <rect x={x} y={y} width={w} height={h} rx={r} ry={r} fill="none" stroke="currentColor"
          strokeWidth={dot} strokeLinecap="round" strokeDasharray={`0 ${gap}`} />
  )
  const lens = (x: number) => (
    <>
      {ring(x, 24, 34, 26, 7, 2.6, 1.5)}
      {ring(x + 2.4, 26.4, 29.2, 21.2, 5, 2.6, 1.5)}
    </>
  )
  return (
    <svg viewBox="0 14 86 46" height={height} width={(height * 86) / 46} aria-label="Hazard Map" role="img">
      {ring(2, 16, 82, 42, 10, 2.6, 1.5)}
      {ring(4.4, 18.4, 77.2, 37.2, 8, 2.6, 1.5)}
      {lens(8)}
      {lens(49)}
    </svg>
  )
}
