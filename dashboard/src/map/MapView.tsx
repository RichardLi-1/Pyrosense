import { useEffect, useRef } from 'react'
import { lut } from '../lib/colors'
import type { Alert, HeatCell, MapMeta, Pose, TrailPoint } from '../lib/types'
import { CELL_SIZE } from '../lib/types'
import type { MapTheme } from './theme'

type Props = {
  theme: MapTheme
  meta: MapMeta | null
  image: CanvasImageSource | null
  heat: HeatCell[]
  trail: TrailPoint[]
  pose: Pose | null
  alerts: Alert[]
  follow: boolean
  showHeat: boolean
  showTrail: boolean
  /** Screen-space insets (px) the camera should keep clear, for overlaid UI. */
  inset?: { top?: number; right?: number; bottom?: number; left?: number }
}

type Camera = { cx: number; cy: number; scale: number } // metres, px per metre

const W_REF = 1.2 // kernel-weighted sample weight at which heat is fully opaque
const TRAIL_S = 90 // seconds of trail shown, fading with age
const KERNEL_R = 5 // cells (1 m)
const KERNEL = Float32Array.from({ length: (2 * KERNEL_R + 1) ** 2 }, (_, i) => {
  const dx = (i % (2 * KERNEL_R + 1)) - KERNEL_R, dy = Math.floor(i / (2 * KERNEL_R + 1)) - KERNEL_R
  const d2 = dx * dx + dy * dy
  return d2 > KERNEL_R * KERNEL_R ? 0 : Math.exp(-d2 / (2 * 2.2 * 2.2)) // sigma 0.44 m
})

export default function MapView(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const p = useRef(props)
  p.current = props

  // Re-render the occupancy grid in theme colours whenever the map or theme changes.
  const occ = useRef<HTMLCanvasElement | null>(null)
  const free = useRef<HTMLCanvasElement | null>(null) // scanned free space, to clip heat at walls
  const { image, meta, theme, heat: cells } = props
  useEffect(() => {
    if (!image || !meta) return
    const c = document.createElement('canvas')
    c.width = meta.w; c.height = meta.h
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(image, 0, 0)
    const px = g.getImageData(0, 0, meta.w, meta.h)
    const d = px.data
    const mask = new ImageData(meta.w, meta.h)
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]
      if (a === 0) continue
      const isFree = a > 240 // backend PNG: free alpha 255, occupied 217
      const col = isFree ? theme.free : theme.wall
      d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = col[3]
      if (isFree) mask.data[i + 3] = 255
    }
    g.putImageData(px, 0, 0)
    occ.current = c
    const mc = document.createElement('canvas')
    mc.width = meta.w; mc.height = meta.h
    mc.getContext('2d')!.putImageData(mask, 0, 0)
    free.current = mc
  }, [image, meta, theme])

  // Heat: kernel-weighted mean of the 20 cm cells (docs/voc-mapping.md), so sparse
  // readings read as areas. One pixel per cell; drawn scaled + lightly blurred.
  const heat = useRef<{ c: HTMLCanvasElement; x0: number; y1: number; w: number; h: number } | null>(null)
  useEffect(() => {
    if (!cells.length) { heat.current = null; return }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const c of cells) {
      minX = Math.min(minX, c.cx); maxX = Math.max(maxX, c.cx); minY = Math.min(minY, c.cy); maxY = Math.max(maxY, c.cy)
    }
    const pad = KERNEL_R + 1
    const w = maxX - minX + 1 + pad * 2, h = maxY - minY + 1 + pad * 2
    const num = new Float32Array(w * h), den = new Float32Array(w * h)
    for (const cell of cells) {
      const col = cell.cx - minX + pad, row = maxY + pad - cell.cy
      for (let dy = -KERNEL_R; dy <= KERNEL_R; dy++) for (let dx = -KERNEL_R; dx <= KERNEL_R; dx++) {
        const k = KERNEL[(dy + KERNEL_R) * (2 * KERNEL_R + 1) + dx + KERNEL_R] * cell.weight
        if (!k) continue
        const i = (row + dy) * w + col + dx
        num[i] += k * cell.mean; den[i] += k
      }
    }
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const g = c.getContext('2d')!
    const img = g.createImageData(w, h)
    for (let i = 0; i < den.length; i++) {
      if (den[i] < 0.03) continue
      const mean = num[i] / den[i]
      const [r, gg, b] = lut(mean)
      const conf = Math.min(1, den[i] / W_REF)
      const strength = 0.05 + 0.95 * Math.min(1, Math.max(0, (mean - 110) / 150)) ** 0.8 // near-invisible when air is fine
      img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b
      img.data[i * 4 + 3] = Math.round(255 * conf * strength)
    }
    g.putImageData(img, 0, 0)
    heat.current = { c, x0: (minX - pad) * CELL_SIZE, y1: (maxY + 1 + pad) * CELL_SIZE, w: w * CELL_SIZE, h: h * CELL_SIZE }
  }, [cells])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const layer = document.createElement('canvas')
    const lctx = layer.getContext('2d')!
    let raf = 0
    let cam: Camera | null = null
    let manual = false
    let shown: { x: number; y: number; h: number } | null = null
    const seenAlerts = new Set<string>()
    const rings: { x: number; y: number; t0: number }[] = []
    let first = true

    const size = () => {
      const r = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(r.width * dpr)) canvas.width = Math.round(r.width * dpr)
      if (canvas.height !== Math.round(r.height * dpr)) canvas.height = Math.round(r.height * dpr)
      return { w: r.width, h: r.height, dpr }
    }

    const fit = (w: number, h: number): Camera | null => {
      const m = p.current.meta
      if (!m) return null
      const ins = { top: 0, right: 0, bottom: 0, left: 0, ...p.current.inset }
      const aw = Math.max(50, w - ins.left - ins.right), ah = Math.max(50, h - ins.top - ins.bottom)
      const mw = m.w * m.res, mh = m.h * m.res
      const scale = Math.min(aw / mw, ah / mh) * 0.9
      // centre of the map, shifted so it sits in the un-inset area
      return { cx: m.origin[0] + mw / 2 - (ins.left - ins.right) / 2 / scale,
               cy: m.origin[1] + mh / 2 + (ins.top - ins.bottom) / 2 / scale, scale }
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const { w, h, dpr } = size()
      const P = p.current
      const T = P.theme
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // wearer position glides toward the latest pose
      if (P.pose) {
        if (!shown) shown = { x: P.pose.x, y: P.pose.y, h: P.pose.heading }
        const k = 0.18
        shown.x += (P.pose.x - shown.x) * k
        shown.y += (P.pose.y - shown.y) * k
        const dh = Math.atan2(Math.sin(P.pose.heading - shown.h), Math.cos(P.pose.heading - shown.h))
        shown.h += dh * k
      }

      // camera: fit (default), follow, or wherever the user left it
      let target: Camera | null = null
      if (P.follow && shown) target = { cx: shown.x, cy: shown.y, scale: cam?.scale ?? fit(w, h)?.scale ?? 40 }
      else if (!manual) target = fit(w, h)
      if (target) {
        if (!cam || first) { cam = { ...target }; first = false }
        else {
          cam.cx += (target.cx - cam.cx) * 0.08
          cam.cy += (target.cy - cam.cy) * 0.08
          cam.scale += (target.scale - cam.scale) * 0.08
        }
      }
      if (!cam) return
      const c = cam
      const sx = (x: number) => (x - c.cx) * c.scale + w / 2
      const sy = (y: number) => h / 2 - (y - c.cy) * c.scale

      // 1 m grid
      if (T.grid) {
        ctx.strokeStyle = T.grid
        ctx.lineWidth = 1
        ctx.beginPath()
        const x0 = Math.floor(c.cx - w / 2 / c.scale), x1 = Math.ceil(c.cx + w / 2 / c.scale)
        const y0 = Math.floor(c.cy - h / 2 / c.scale), y1 = Math.ceil(c.cy + h / 2 / c.scale)
        for (let x = x0; x <= x1; x++) { ctx.moveTo(Math.round(sx(x)) + 0.5, 0); ctx.lineTo(Math.round(sx(x)) + 0.5, h) }
        for (let y = y0; y <= y1; y++) { ctx.moveTo(0, Math.round(sy(y)) + 0.5); ctx.lineTo(w, Math.round(sy(y)) + 0.5) }
        ctx.stroke()
      }

      // occupancy grid (north-up PNG: top-left corner is (origin.x, origin.y + h*res))
      const m = P.meta
      if (m && occ.current) {
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(occ.current, sx(m.origin[0]), sy(m.origin[1] + m.h * m.res), m.w * m.res * c.scale, m.h * m.res * c.scale)
      }

      // heat
      // heat, blurred on its own layer, then clipped to scanned free space so it stops at walls
      const hm = heat.current
      if (P.showHeat && hm && m && free.current) {
        if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height }
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lctx.globalCompositeOperation = 'source-over'
        lctx.clearRect(0, 0, w, h)
        lctx.imageSmoothingEnabled = true
        lctx.imageSmoothingQuality = 'high'
        lctx.filter = `blur(${T.heatBlur}px)`
        lctx.drawImage(hm.c, sx(hm.x0), sy(hm.y1), hm.w * c.scale, hm.h * c.scale)
        lctx.filter = 'none'
        lctx.globalCompositeOperation = 'destination-in'
        lctx.drawImage(free.current, sx(m.origin[0]), sy(m.origin[1] + m.h * m.res), m.w * m.res * c.scale, m.h * m.res * c.scale)
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalCompositeOperation = T.heatBlend
        ctx.globalAlpha = T.heatAlpha
        ctx.drawImage(layer, 0, 0)
        ctx.restore()
      }

      // trail: the last 90 s in one quiet colour, fading with age (the heat carries VOC)
      if (P.showTrail && P.trail.length > 1) {
        const tEnd = Date.parse(P.trail[P.trail.length - 1].ts)
        const pts = P.trail.filter((pt) => Date.parse(pt.ts) >= tEnd - TRAIL_S * 1000)
        const chunks = 8
        ctx.strokeStyle = T.trail
        ctx.lineWidth = 1.5
        ctx.lineJoin = ctx.lineCap = 'round'
        for (let k = 0; k < chunks; k++) {
          const a = Math.floor((k * (pts.length - 1)) / chunks), b = Math.floor(((k + 1) * (pts.length - 1)) / chunks)
          if (b <= a) continue
          ctx.globalAlpha = (k + 1) / chunks
          ctx.beginPath()
          ctx.moveTo(sx(pts[a].x), sy(pts[a].y))
          for (let i = a + 1; i <= b; i++) ctx.lineTo(sx(pts[i].x), sy(pts[i].y))
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }

      // alerts: a small ring where each fired; a new one expands once
      for (const a of P.alerts) {
        const key = `${a.ts}`
        if (!seenAlerts.has(key)) {
          seenAlerts.add(key)
          if (Date.now() - Date.parse(a.ts) < 15_000) rings.push({ x: a.x, y: a.y, t0: now })
        }
        ctx.strokeStyle = T.alert
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(sx(a.x), sy(a.y), 5, 0, Math.PI * 2)
        ctx.stroke()
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const f = (now - rings[i].t0) / 1600
        if (f >= 1) { rings.splice(i, 1); continue }
        ctx.strokeStyle = T.alert
        ctx.globalAlpha = 1 - f
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(sx(rings[i].x), sy(rings[i].y), 6 + f * 70, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
      }

      // wearer
      if (shown) {
        const x = sx(shown.x), y = sy(shown.y)
        const pulse = (now % 2000) / 2000
        ctx.fillStyle = T.halo
        ctx.beginPath(); ctx.arc(x, y, 8 + pulse * 14, 0, Math.PI * 2)
        ctx.globalAlpha = 1 - pulse; ctx.fill(); ctx.globalAlpha = 1
        // heading cone
        const g = ctx.createRadialGradient(x, y, 0, x, y, 34)
        g.addColorStop(0, T.halo); g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = g
        ctx.beginPath(); ctx.moveTo(x, y)
        ctx.arc(x, y, 34, -shown.h - 0.45, -shown.h + 0.45)
        ctx.closePath(); ctx.fill()
        ctx.fillStyle = T.person
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill()
      }
    }
    raf = requestAnimationFrame(frame)

    // interactions: wheel zoom at cursor, drag to pan, double-click to re-fit
    const pt = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    const onWheel = (e: WheelEvent) => {
      if (!cam) return
      e.preventDefault()
      manual = true
      const { x, y } = pt(e), r = canvas.getBoundingClientRect()
      const wx = (x - r.width / 2) / cam.scale + cam.cx, wy = (r.height / 2 - y) / cam.scale + cam.cy
      cam.scale = Math.min(400, Math.max(5, cam.scale * Math.exp(-e.deltaY * 0.0015)))
      cam.cx = wx - (x - r.width / 2) / cam.scale
      cam.cy = wy - (r.height / 2 - y) / cam.scale
    }
    let drag: { x: number; y: number } | null = null
    const onDown = (e: MouseEvent) => { drag = pt(e) }
    const onMove = (e: MouseEvent) => {
      if (!drag || !cam) return
      const q = pt(e)
      cam.cx -= (q.x - drag.x) / cam.scale
      cam.cy += (q.y - drag.y) / cam.scale
      drag = q
      manual = true
    }
    const onUp = () => { drag = null }
    const onDbl = () => { manual = false }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    canvas.addEventListener('dblclick', onDbl)
    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('dblclick', onDbl)
    }
  }, [])

  return <canvas ref={canvasRef} className="map-canvas" />
}
