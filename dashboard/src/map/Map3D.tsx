// 3D view built from the 2D data: walls extruded from the occupancy grid, the floor
// painted with the VOC field (measured, else predicted), and a drifting particle cloud
// for predicted gas in the air, including in rooms nobody has entered yet.
// Two cameras: overhead orbit, and first person at the selected wearer's eyes.
// World axes: map x -> x, map y -> -z, height -> y.
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { bandImage, isolines, strokeIsolines } from '../lib/heatImage'
import { gasCloud, predict, PRIOR_WEIGHT, type GasCloud } from '../lib/predict'
import type { Source } from '../lib/sourceModel'
import { DEFAULT_WEARER, type MapMeta } from '../lib/types'
import { drawHardHat } from './theme'
import { TRAIL_S, crewColor, insets, type RendererProps } from './types'

const WALL_OVERHEAD = 0.9 // m: cut-away height so rooms stay visible from above
const WALL_FULL = 2.6 // m: in first person
const EYE_H = 1.6
const FOV_OVERHEAD = 32
const FOV_FIRST = 72
const GAS_SIZE = 0.32 // m, particle diameter

type Rect = { c0: number; r0: number; w: number; h: number } // grid pixels, image rows (row 0 = max y)

/** Occupied pixels -> few rectangles: runs per row, merged with identical runs below. */
function wallRects(alpha: (i: number) => number, W: number, H: number): Rect[] {
  const done: Rect[] = []
  let open = new Map<string, Rect>()
  for (let r = 0; r < H; r++) {
    const next = new Map<string, Rect>()
    let c = 0
    while (c < W) {
      const a = alpha(r * W + c)
      if (a === 0 || a > 240) { c++; continue } // unknown or free
      const c0 = c
      while (c < W) { const b = alpha(r * W + c); if (b === 0 || b > 240) break; c++ }
      const key = `${c0},${c - c0}`
      const prev = open.get(key)
      if (prev) { prev.h++; next.set(key, prev); open.delete(key) } else next.set(key, { c0, r0: r, w: c - c0, h: 1 })
    }
    for (const rect of open.values()) done.push(rect)
    open = next
  }
  for (const rect of open.values()) done.push(rect)
  return done
}

function badgeTexture(badge: string, icon: string) {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 10; g.shadowOffsetY = 3
  drawHardHat(g, 64, 62, 50, badge, icon)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

const GAS_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aPhase;
  uniform float uTime;
  uniform float uScale;
  uniform float uMaxSize;
  uniform float uAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 p = position + vec3(sin(uTime * 0.35 + aPhase) * 0.07,
                             sin(uTime * 0.5 + aPhase * 1.7) * 0.06,
                             cos(uTime * 0.3 + aPhase * 0.7) * 0.07);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    gl_PointSize = min(uScale / dist, uMaxSize);
    vColor = aColor;
    vAlpha = aAlpha * uAlpha * smoothstep(0.4, 1.6, dist); // fade what's right in front of the eye
  }`
const GAS_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.5, 0.0, d));
  }`

type Person = { group: THREE.Group; body: THREE.Group; ring: THREE.Mesh; stem: THREE.Mesh; badge: THREE.Sprite;
                shown: THREE.Vector3 | null; heading: number; roll: number; pitch: number; color: string }

type Api = {
  setWalls: (rects: Rect[], meta: MapMeta) => void
  setFloor: (canvas: HTMLCanvasElement, meta: MapMeta) => void
  setGas: (cloud: GasCloud) => void
  setSources: (sources: Source[]) => void
  setTheme: () => void
  recenter: () => void
}

export default function Map3D(props: RendererProps & { firstPerson: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const p = useRef(props)
  p.current = props
  const api = useRef<Api | null>(null)

  // scene setup, once
  useEffect(() => {
    const host = hostRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)
    renderer.domElement.className = 'map-canvas'

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(FOV_OVERHEAD, 1, 0.05, 500)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI * 0.47
    controls.minDistance = 3
    controls.maxDistance = 160
    controls.screenSpacePanning = false

    scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.4)
    sun.position.set(-6, 14, 8)
    scene.add(sun)

    // walls: one instanced box per merged rectangle (unit height, scaled by the group)
    const wallMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 })
    const capMat = new THREE.MeshBasicMaterial()
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
    const cap = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 1.001, 0)
    const wallGroup = new THREE.Group()
    wallGroup.scale.y = WALL_OVERHEAD
    scene.add(wallGroup)

    // floor: free space + VOC field, one canvas texture
    const floorMat = new THREE.MeshBasicMaterial({ transparent: true })
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), floorMat)
    floor.visible = false
    scene.add(floor)

    // gas: particle cloud, drifting
    const gasMat = new THREE.ShaderMaterial({
      vertexShader: GAS_VERT, fragmentShader: GAS_FRAG, transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uMaxSize: { value: 64 }, uAlpha: { value: 1 } },
    })
    const gas = new THREE.Points(new THREE.BufferGeometry(), gasMat)
    gas.frustumCulled = false
    scene.add(gas)

    // likely sources: dashed-looking rings on the floor
    const sourceGroup = new THREE.Group()
    scene.add(sourceGroup)
    const sourceMat = new THREE.LineDashedMaterial({ dashSize: 0.18, gapSize: 0.14, transparent: true, opacity: 0.9 })

    // wearers, created as they appear
    const people = new Map<string, Person>()
    const ringGeo = new THREE.RingGeometry(0.22, 0.3, 48).rotateX(-Math.PI / 2)
    const stemGeo = new THREE.CylinderGeometry(0.012, 0.012, EYE_H, 8).translate(0, EYE_H / 2, 0)
    const person = (id: string): Person => {
      let pr = people.get(id)
      if (pr) return pr
      const group = new THREE.Group(), body = new THREE.Group()
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true }))
      ring.position.y = 0.02
      const stem = new THREE.Mesh(stemGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6 }))
      const badge = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, sizeAttenuation: false }))
      badge.position.y = EYE_H
      badge.renderOrder = 10
      body.add(stem, badge) // tilts with roll/pitch about the feet
      group.add(ring, body)
      scene.add(group)
      pr = { group, body, ring, stem, badge, shown: null, heading: 0, roll: 0, pitch: 0, color: '' }
      people.set(id, pr)
      return pr
    }
    const paint = (pr: Person, color: string) => {
      if (pr.color === color) return
      pr.color = color
      const T = p.current.theme
      pr.badge.material.map?.dispose()
      pr.badge.material.map = badgeTexture(color, T.icon)
      pr.badge.material.needsUpdate = true
      ;(pr.ring.material as THREE.MeshBasicMaterial).color.set(color)
      ;(pr.stem.material as THREE.MeshBasicMaterial).color.set(color)
    }

    // trails (one segment list, only between consecutive points of the same wearer) + alerts
    const trailMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55, vertexColors: true })
    const trail = new THREE.LineSegments(new THREE.BufferGeometry(), trailMat)
    scene.add(trail)
    const alertGroup = new THREE.Group()
    scene.add(alertGroup)
    const alertGeo = new THREE.RingGeometry(0.16, 0.22, 32).rotateX(-Math.PI / 2)
    const alertMat = new THREE.MeshBasicMaterial({ transparent: true })

    const setTheme = () => {
      const T = p.current.theme
      wallMat.color.set(T.wall3d)
      capMat.color.set(T.wallTop3d)
      for (const pr of people.values()) pr.color = '' // repaint next frame
      alertMat.color.set(T.alert)
      sourceMat.color.set(T.alert)
      gasMat.blending = T.glow3d === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending
      gasMat.needsUpdate = true
    }
    setTheme()

    // overhead camera: fit the map in the un-inset area, from the south, 50° up
    let size = { w: 1, h: 1 }
    let moved = false
    let goal: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null
    const defaultView = () => {
      const m = p.current.meta
      if (!m) return null
      const ins = insets(p.current.inset)
      const mw = m.w * m.res, mh = m.h * m.res
      const target = new THREE.Vector3(m.origin[0] + mw / 2, 0, -(m.origin[1] + mh / 2))
      const aw = Math.max(50, size.w - ins.left - ins.right), ah = Math.max(50, size.h - ins.top - ins.bottom)
      const tv = Math.tan((FOV_OVERHEAD * Math.PI) / 360) * (ah / size.h), th = tv * (aw / ah)
      const dist = ((0.5 * Math.hypot(mw, mh)) / Math.min(tv, th)) * 0.92
      const dir = new THREE.Vector3(0, Math.sin(0.87), Math.cos(0.87))
      return { target, pos: target.clone().add(dir.multiplyScalar(dist)) }
    }
    const applyProjection = () => {
      const ins = p.current.firstPerson ? insets() : insets(p.current.inset)
      camera.aspect = size.w / size.h
      camera.setViewOffset(size.w, size.h, -(ins.left - ins.right) / 2, -(ins.top - ins.bottom) / 2, size.w, size.h)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect()
      size = { w: Math.max(1, r.width), h: Math.max(1, r.height) }
      renderer.setSize(size.w, size.h, false)
      applyProjection()
    })
    ro.observe(host)

    const markMoved = () => { if (!moved) { moved = true; p.current.onMoved(true) } }
    const onStart = () => { goal = null; markMoved() }
    controls.addEventListener('start', onStart)

    // first person: drag to look around (offsets from the wearer's heading)
    let look = { yaw: 0, pitch: -0.12 }
    let drag: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => { if (p.current.firstPerson) drag = { x: e.clientX, y: e.clientY } }
    const onMove = (e: PointerEvent) => {
      if (!drag) return
      look.yaw -= (e.clientX - drag.x) * 0.004
      look.pitch = Math.max(-1.2, Math.min(0.9, look.pitch - (e.clientY - drag.y) * 0.004))
      drag = { x: e.clientX, y: e.clientY }
      markMoved()
    }
    const onUp = () => { drag = null }
    renderer.domElement.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)

    api.current = {
      setWalls(rects, m) {
        for (const c of [...wallGroup.children]) { wallGroup.remove(c); (c as THREE.InstancedMesh).dispose() }
        const walls = new THREE.InstancedMesh(box, wallMat, rects.length)
        const caps = new THREE.InstancedMesh(cap, capMat, rects.length)
        const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3()
        rects.forEach((r, i) => {
          const x = m.origin[0] + (r.c0 + r.w / 2) * m.res
          const y = m.origin[1] + (m.h - r.r0 - r.h / 2) * m.res
          mat.compose(v.set(x, 0, -y), q, s.set(r.w * m.res, 1, r.h * m.res))
          walls.setMatrixAt(i, mat); caps.setMatrixAt(i, mat)
        })
        wallGroup.add(walls, caps)
      },
      setFloor(canvas, m) {
        const old = floorMat.map
        const tex = new THREE.CanvasTexture(canvas)
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = 4
        floorMat.map = tex
        floorMat.needsUpdate = true
        old?.dispose()
        floor.scale.set(m.w * m.res, 1, m.h * m.res)
        floor.position.set(m.origin[0] + (m.w * m.res) / 2, 0, -(m.origin[1] + (m.h * m.res) / 2))
        floor.visible = true
      },
      setGas(cloud) {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3))
        g.setAttribute('aColor', new THREE.BufferAttribute(cloud.colors, 3))
        g.setAttribute('aAlpha', new THREE.BufferAttribute(cloud.alphas, 1))
        g.setAttribute('aPhase', new THREE.BufferAttribute(cloud.phases, 1))
        gas.geometry.dispose()
        gas.geometry = g
      },
      setSources(sources) {
        for (const c of [...sourceGroup.children]) { sourceGroup.remove(c); (c as THREE.Line).geometry.dispose() }
        for (const s of sources) {
          if (s.q < 120) continue
          const pts = Array.from({ length: 65 }, (_, i) => {
            const a = (i / 64) * Math.PI * 2
            return new THREE.Vector3(s.x + Math.cos(a) * 0.9, 0.04, -(s.y + Math.sin(a) * 0.9))
          })
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), sourceMat)
          line.computeLineDistances()
          sourceGroup.add(line)
        }
      },
      setTheme,
      recenter() {
        look = { yaw: 0, pitch: -0.12 }
        goal = defaultView()
        moved = false
        p.current.onMoved(false)
      },
    }

    let raf = 0
    let alertKey = ''
    let trailKey = ''
    let placed = false
    let wasFirst = false
    const eye = new THREE.Object3D()
    const t0 = performance.now()
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const P = p.current
      const fp = P.firstPerson
      const T = P.theme

      // wearers glide toward their latest pose; the body tilts with roll/pitch (subtly)
      const live = new Set<string>()
      for (const { id, pose } of P.poses) {
        live.add(id)
        const pr = person(id)
        paint(pr, crewColor(T.crew, T.badge, P.poses, id))
        const at = new THREE.Vector3(pose.x, 0, -pose.y)
        pr.shown = pr.shown ? pr.shown.lerp(at, 0.18) : at
        pr.heading += Math.atan2(Math.sin(pose.heading - pr.heading), Math.cos(pose.heading - pr.heading)) * 0.12
        pr.roll += ((pose.roll ?? 0) - pr.roll) * 0.15
        pr.pitch += ((pose.pitch ?? 0) - pr.pitch) * 0.15
        pr.group.position.copy(pr.shown)
        pr.group.rotation.y = pr.heading // local +x = facing direction
        pr.body.rotation.set(pr.roll, 0, pr.pitch, 'YXZ') // pitch forward = rotate about local z
        const sel = id === P.selected
        pr.group.visible = !(fp && sel)
        const s = sel ? 0.046 : 0.036
        pr.badge.scale.set(s, s, 1)
        const pulse = (performance.now() % 2200) / 2200
        pr.ring.scale.setScalar(sel ? 1 + pulse * 1.6 : 1)
        ;(pr.ring.material as THREE.MeshBasicMaterial).opacity = sel ? 1 - pulse : 0.5
      }
      for (const [id, pr] of people) if (!live.has(id)) pr.group.visible = false

      // trails, per wearer (rebuilt when they change)
      const tk = P.showTrail ? `${P.trail.length}:${P.trail.at(-1)?.ts}:${T.trail}:${P.poses.length}` : 'off'
      if (tk !== trailKey) {
        trailKey = tk
        const tEnd = Date.parse(P.trail.at(-1)?.ts ?? '0')
        const pos: number[] = [], col: number[] = []
        const last = new Map<string, { x: number; y: number }>()
        const c = new THREE.Color()
        if (P.showTrail) for (const t of P.trail) {
          if (Date.parse(t.ts) < tEnd - TRAIL_S * 1000) continue
          const id = t.wearer ?? DEFAULT_WEARER
          const prev = last.get(id)
          last.set(id, t)
          if (!prev) continue
          c.set(P.poses.length > 1 ? crewColor(T.crew, T.badge, P.poses, id)
                                    : T.trail.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, 'rgb($1,$2,$3)'))
          pos.push(prev.x, 0.03, -prev.y, t.x, 0.03, -t.y)
          col.push(c.r, c.g, c.b, c.r, c.g, c.b)
        }
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
        trail.geometry.dispose()
        trail.geometry = g
      }

      // alert markers
      const ak = P.alerts.map((a) => a.ts).join()
      if (ak !== alertKey) {
        alertKey = ak
        alertGroup.clear()
        for (const a of P.alerts) {
          const m = new THREE.Mesh(alertGeo, alertMat)
          m.position.set(a.x, 0.025, -a.y)
          alertGroup.add(m)
        }
      }
      gas.visible = P.showHeat
      sourceGroup.visible = P.showHeat

      // walls rise in first person, and the lens widens
      wallGroup.scale.y += ((fp ? WALL_FULL : WALL_OVERHEAD) - wallGroup.scale.y) * 0.08
      const fov = fp ? FOV_FIRST : FOV_OVERHEAD
      if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * 0.1; applyProjection() }

      if (fp !== wasFirst) {
        wasFirst = fp
        controls.enabled = !fp
        applyProjection()
        if (!fp) { goal = defaultView(); moved = false; P.onMoved(false) } // fly back out
        else look = { yaw: 0, pitch: -0.12 }
      }

      const me = people.get(P.selected)
      if (fp && me?.shown) {
        // eyes at head height, looking along the heading (+ drag offset); head pitch/roll follow the IMU, damped
        const yaw = me.heading + look.yaw
        const pitch = look.pitch + me.pitch * 0.6
        eye.position.set(me.shown.x, EYE_H + me.pitch * 0.5, me.shown.z)
        eye.lookAt(me.shown.x + Math.cos(yaw) * Math.cos(pitch), eye.position.y + Math.sin(pitch),
                   me.shown.z - Math.sin(yaw) * Math.cos(pitch))
        eye.rotateZ(-me.roll * 0.5)
        camera.position.lerp(eye.position, 0.15)
        camera.quaternion.slerp(eye.quaternion, 0.12)
      } else {
        // overhead: settle on the default view (until the user moves), follow, or animate a recenter
        const dv = defaultView()
        if (dv && !placed) { camera.position.copy(dv.pos); controls.target.copy(dv.target); placed = true }
        if (P.follow && me?.shown) {
          const delta = me.shown.clone().sub(controls.target).multiplyScalar(0.08)
          controls.target.add(delta); camera.position.add(delta)
        } else if (goal || (!moved && dv)) {
          const g = goal ?? dv!
          camera.position.lerp(g.pos, 0.1)
          controls.target.lerp(g.target, 0.1)
          if (goal && camera.position.distanceTo(goal.pos) < 0.02) goal = null
        }
        controls.update()
      }

      gasMat.uniforms.uTime.value = (performance.now() - t0) / 1000
      gasMat.uniforms.uScale.value = (GAS_SIZE * size.h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360))
      gasMat.uniforms.uMaxSize.value = 48 * renderer.getPixelRatio()
      gasMat.uniforms.uAlpha.value += ((fp ? 0.45 : 1) - gasMat.uniforms.uAlpha.value) * 0.1
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.removeEventListener('start', onStart)
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        mesh.geometry?.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
        for (const mt of mats) { (mt as THREE.MeshBasicMaterial).map?.dispose(); mt.dispose() }
      })
      renderer.dispose()
      host.removeChild(renderer.domElement)
      api.current = null
    }
  }, [])

  const { image, meta, theme, heat, recenter, model } = props

  // walls: from the occupancy image whenever the map changes
  const pixels = useRef<Uint8ClampedArray | null>(null)
  useEffect(() => {
    if (!image || !meta || !api.current) return
    const c = document.createElement('canvas')
    c.width = meta.w; c.height = meta.h
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(image, 0, 0)
    const data = g.getImageData(0, 0, meta.w, meta.h).data
    pixels.current = data
    api.current.setWalls(wallRects((i) => data[i * 4 + 3], meta.w, meta.h), meta)
  }, [image, meta])

  // floor + gas: the field on scanned floor; predicted gas anywhere walls don't block
  useEffect(() => {
    const data = pixels.current
    if (!meta || !data || !api.current) return
    const c = document.createElement('canvas')
    c.width = meta.w; c.height = meta.h
    const g = c.getContext('2d')!
    const img = g.createImageData(meta.w, meta.h)
    const col = new THREE.Color(theme.floor3d)
    const [fr, fg, fb] = [col.r, col.g, col.b].map((v) => Math.round(v * 255))
    for (let i = 0; i < meta.w * meta.h; i++) {
      if (data[i * 4 + 3] > 240) { img.data[i * 4] = fr; img.data[i * 4 + 1] = fg; img.data[i * 4 + 2] = fb; img.data[i * 4 + 3] = 255 }
    }
    g.putImageData(img, 0, 0)
    const top = meta.origin[1] + meta.h * meta.res
    const bounds = { x0: meta.origin[0], y0: meta.origin[1], x1: meta.origin[0] + meta.w * meta.res, y1: top }
    const pred = predict(heat, bounds, model)
    if (pred) {
      const band = bandImage(pred.grid, { prior: pred.prior, priorWeight: PRIOR_WEIGHT, predictedAlpha: 0.4 })
      g.globalCompositeOperation = 'source-atop' // only on scanned floor
      g.drawImage(band.canvas, (band.x0 - meta.origin[0]) / meta.res, (top - band.y1) / meta.res,
                  band.w / meta.res, band.h / meta.res)
      strokeIsolines(g, isolines(pred.grid, { prior: pred.prior, priorWeight: PRIOR_WEIGHT }),
                     (x) => (x - meta.origin[0]) / meta.res, (y) => (top - y) / meta.res, 1.4)
      const notWall = (x: number, y: number) => {
        const cc = Math.floor((x - meta.origin[0]) / meta.res), rr = Math.floor((top - y) / meta.res)
        if (cc < 0 || rr < 0 || cc >= meta.w || rr >= meta.h) return false
        const a = data[(rr * meta.w + cc) * 4 + 3]
        return a === 0 || a > 240 // unknown space can hold predicted gas too
      }
      api.current.setGas(gasCloud(pred, notWall))
    }
    api.current.setSources(model?.sources ?? [])
    api.current.setFloor(c, meta)
  }, [meta, theme, heat, model])

  useEffect(() => { api.current?.setTheme() }, [theme])
  useEffect(() => { if (recenter) api.current?.recenter() }, [recenter])

  return <div ref={hostRef} className="map-3d" />
}
