import { useEffect, useRef } from 'react'
import { bandImage, isolines, kernelGrid, strokeIsolines, type HeatImage, type Isoline } from '../lib/heatImage'
import { predict, predictedOnly } from '../lib/predict'
import { DEFAULT_WEARER } from '../lib/types'
import { drawHardHat } from './theme'
import { TRAIL_S, crewColor, insets, type RendererProps } from './types'

type Camera = { cx: number; cy: number; scale: number } // metres, px per metre

const SIGMA_M = 0.3 // heat spreads ~1 m around each reading: hugs the path, no blobs

/** Diagonal stripes, used to cut predicted areas so they read as "not measured". */
function stripePattern(ctx: CanvasRenderingContext2D) {
  const c = document.createElement('canvas')
  c.width = c.height = 8
  const g = c.getContext('2d')!
  g.strokeStyle = '#000'; g.lineWidth = 3
  g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.moveTo(-2, 2); g.lineTo(2, -2); g.stroke()
  return ctx.createPattern(c, 'repeat')!
}

export default function MapView(props: RendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const p = useRef(props)
  p.current = props
  const manual = useRef(false)

  // Re-render the occupancy grid in theme colours whenever the map or theme changes.
  const occ = useRef<HTMLCanvasElement | null>(null)
  const free = useRef<HTMLCanvasElement | null>(null) // scanned free space, to clip heat at walls
  const { image, meta, theme, heat: cells, recenter, onMoved, model } = props
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

  // Heat: crisp level bands from the kernel-smoothed 20 cm cells.
  const heat = useRef<HeatImage | null>(null)
  const contours = useRef<Isoline[]>([])
  useEffect(() => {
    const g = kernelGrid(cells, SIGMA_M, 0.05)
    heat.current = g ? bandImage(g) : null
    contours.current = g ? isolines(g) : []
  }, [cells])

  // Predicted (not yet measured) areas from the source model: drawn striped, and not
  // clipped to scanned space, since the point is to show what's behind unexplored doors.
  const predicted = useRef<{ img: HeatImage; lines: Isoline[] } | null>(null)
  useEffect(() => {
    if (!model || !cells.length) { predicted.current = null; return }
    const bounds = { x0: model.x0, y0: model.y0, x1: model.x0 + model.cols * model.res, y1: model.y0 + model.rows * model.res }
    const pred = predict(cells, bounds, model, SIGMA_M, model.res)
    if (!pred) { predicted.current = null; return }
    const g = predictedOnly(pred)
    predicted.current = { img: bandImage(g, { minSupport: 0.5 }), lines: isolines(g, { minSupport: 0.5 }) }
  }, [model, cells])

  useEffect(() => {
    if (recenter) { manual.current = false; onMoved(false) }
  }, [recenter, onMoved])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const layer = document.createElement('canvas')
    const lctx = layer.getContext('2d')!
    const play = document.createElement('canvas')
    const pctx = play.getContext('2d')!
    const stripes = stripePattern(pctx)
    let raf = 0
    let cam: Camera | null = null
    const shown = new Map<string, { x: number; y: number; h: number }>()
    const seenAlerts = new Set<string>()
    const rings: { x: number; y: number; t0: number }[] = []
    const setManual = () => {
      if (!manual.current) { manual.current = true; p.current.onMoved(true) }
    }

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
      const ins = insets(p.current.inset)
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

      // each wearer glides toward their latest pose
      for (const { id, pose } of P.poses) {
        let sh = shown.get(id)
        if (!sh) { sh = { x: pose.x, y: pose.y, h: pose.heading }; shown.set(id, sh) }
        const k = 0.18
        sh.x += (pose.x - sh.x) * k
        sh.y += (pose.y - sh.y) * k
        sh.h += Math.atan2(Math.sin(pose.heading - sh.h), Math.cos(pose.heading - sh.h)) * k
      }
      const me = shown.get(P.selected)

      // camera: fit (default), follow, or wherever the user left it
      let target: Camera | null = null
      if (P.follow && me) target = { cx: me.x, cy: me.y, scale: cam?.scale ?? fit(w, h)?.scale ?? 40 }
      else if (!manual.current) target = fit(w, h)
      if (target) {
        if (!cam) cam = { ...target }
        else {
          cam.cx += (target.cx - cam.cx) * 0.1
          cam.cy += (target.cy - cam.cy) * 0.1
          cam.scale += (target.scale - cam.scale) * 0.1
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
      const mapRect = m && [sx(m.origin[0]), sy(m.origin[1] + m.h * m.res), m.w * m.res * c.scale, m.h * m.res * c.scale] as const
      if (mapRect && occ.current) {
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(occ.current, ...mapRect)
      }

      // heat on its own layer, clipped to scanned free space so it stops at walls
      const hm = heat.current
      if (P.showHeat && hm && mapRect && free.current) {
        if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height }
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lctx.globalCompositeOperation = 'source-over'
        lctx.clearRect(0, 0, w, h)
        lctx.imageSmoothingEnabled = true
        lctx.drawImage(hm.canvas, sx(hm.x0), sy(hm.y1), hm.w * c.scale, hm.h * c.scale)
        strokeIsolines(lctx, contours.current, sx, sy, 1.5)
        lctx.globalCompositeOperation = 'destination-in'
        lctx.imageSmoothingEnabled = false
        lctx.drawImage(free.current, ...mapRect)
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalCompositeOperation = T.heatBlend
        ctx.globalAlpha = T.heatAlpha
        ctx.drawImage(layer, 0, 0)
        ctx.restore()
      }

      // predicted areas: striped band fills + thin contours, plus likely sources
      const pr = predicted.current
      if (P.showHeat && pr) {
        if (play.width !== canvas.width || play.height !== canvas.height) { play.width = canvas.width; play.height = canvas.height }
        pctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        pctx.globalCompositeOperation = 'source-over'
        pctx.clearRect(0, 0, w, h)
        pctx.imageSmoothingEnabled = true
        pctx.globalAlpha = 2.2 // band fills are faint; predicted ones need more body before striping
        pctx.drawImage(pr.img.canvas, sx(pr.img.x0), sy(pr.img.y1), pr.img.w * c.scale, pr.img.h * c.scale)
        pctx.globalAlpha = 1
        pctx.globalCompositeOperation = 'destination-out'
        pctx.setTransform(1, 0, 0, 1, 0, 0)
        pctx.fillStyle = stripes
        pctx.fillRect(0, 0, play.width, play.height)
        pctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        pctx.globalCompositeOperation = 'source-over'
        pctx.globalAlpha = 0.55
        strokeIsolines(pctx, pr.lines, sx, sy, 1)
        pctx.globalAlpha = 1
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalCompositeOperation = T.heatBlend
        ctx.drawImage(play, 0, 0)
        ctx.restore()
      }
      if (P.showHeat && P.model) {
        ctx.save()
        ctx.setLineDash([3, 4])
        ctx.lineWidth = 1.25
        ctx.strokeStyle = T.alert
        ctx.fillStyle = T.alert
        ctx.font = '500 10px Inter, system-ui, sans-serif'
        ctx.textAlign = 'center'
        for (const src of P.model.sources) {
          if (src.q < 120) continue
          const x = sx(src.x), y = sy(src.y), r = 0.9 * c.scale
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke()
          ctx.fillText('likely source', x, y - r - 6)
        }
        ctx.restore()
      }

      // trails: the last 90 s per wearer, fading with age (the heat carries VOC)
      const byWearer = new Map<string, typeof P.trail>()
      if (P.showTrail) for (const pt of P.trail) {
        const id = pt.wearer ?? DEFAULT_WEARER
        let list = byWearer.get(id)
        if (!list) byWearer.set(id, (list = []))
        list.push(pt)
      }
      for (const [id, trail] of byWearer) {
        if (trail.length < 2) continue
        const tEnd = Date.parse(trail[trail.length - 1].ts)
        const pts = trail.filter((pt) => Date.parse(pt.ts) >= tEnd - TRAIL_S * 1000)
        const chunks = 8
        ctx.strokeStyle = P.poses.length > 1 ? crewColor(T.crew, T.badge, P.poses, id) : T.trail
        ctx.lineWidth = 1.5
        ctx.lineJoin = ctx.lineCap = 'round'
        for (let k = 0; k < chunks; k++) {
          const a = Math.floor((k * (pts.length - 1)) / chunks), b = Math.floor(((k + 1) * (pts.length - 1)) / chunks)
          if (b <= a) continue
          ctx.globalAlpha = ((k + 1) / chunks) * (P.poses.length > 1 ? 0.45 : 1)
          ctx.beginPath()
          ctx.moveTo(sx(pts[a].x), sy(pts[a].y))
          for (let i = a + 1; i <= b; i++) ctx.lineTo(sx(pts[i].x), sy(pts[i].y))
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }

      // alerts: a small ring where each fired; a new one expands once
      for (const a of P.alerts) {
        if (!seenAlerts.has(a.ts)) {
          seenAlerts.add(a.ts)
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

      // wearers: hard-hat badges with heading cones; the selected one larger, with a pulse
      const crew = P.poses.length > 1
      for (const { id } of [...P.poses].sort((a, b) => (a.id === P.selected ? 1 : 0) - (b.id === P.selected ? 1 : 0))) {
        const sh = shown.get(id)
        if (!sh) continue
        const sel = id === P.selected
        const x = sx(sh.x), y = sy(sh.y)
        const color = crewColor(T.crew, T.badge, P.poses, id)
        if (sel) {
          const pulse = (now % 2200) / 2200
          ctx.fillStyle = T.halo
          ctx.globalAlpha = 1 - pulse
          ctx.beginPath(); ctx.arc(x, y, 15 + pulse * 18, 0, Math.PI * 2); ctx.fill()
          ctx.globalAlpha = 1
        }
        const cone = sel ? 58 : 40
        const g = ctx.createRadialGradient(x, y, 10, x, y, cone)
        g.addColorStop(0, T.halo); g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = g
        ctx.beginPath(); ctx.moveTo(x, y)
        ctx.arc(x, y, cone, -sh.h - 0.42, -sh.h + 0.42)
        ctx.closePath(); ctx.fill()
        ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2
        drawHardHat(ctx, x, y, sel ? 14 : 11, color, T.icon)
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0
        if (crew) {
          ctx.fillStyle = color
          ctx.font = '600 11px Inter, system-ui, sans-serif'
          ctx.textAlign = 'left'
          ctx.fillText(id, x + (sel ? 18 : 15), y + 4)
        }
      }
    }
    raf = requestAnimationFrame(frame)

    // interactions: wheel zoom at cursor, drag to pan, double-click to re-fit
    const pt = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    const onWheel = (e: WheelEvent) => {
      if (!cam) return
      e.preventDefault()
      setManual()
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
      if (q.x === drag.x && q.y === drag.y) return
      cam.cx -= (q.x - drag.x) / cam.scale
      cam.cy += (q.y - drag.y) / cam.scale
      drag = q
      setManual()
    }
    const onUp = () => { drag = null }
    const onDbl = () => { manual.current = false; p.current.onMoved(false) }
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
