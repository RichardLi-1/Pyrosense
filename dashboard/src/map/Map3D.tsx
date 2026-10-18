// 3D view built from the 2D data: walls extruded from the occupancy grid, the floor
// painted with the measured VOC field, and a drifting live cloud of blooms and particles
// from the readings taken so far.
// Two cameras: overhead orbit, and first person at the selected wearer's eyes.
// World axes: map x -> x, map y -> -z, height -> y.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { bandImage, isolines, kernelGrid, layerGrid, strokeIsolines } from '../lib/heatImage'
import { DisplayField } from '../lib/diffuse'
import { SCALE, rampColor, rampT } from '../lib/colors'
import { drawMark, markKind, type Mark } from '../lib/marks'
import { Plume } from '../lib/plume'
import Compass from '../ui/Compass'
import { uncertaintyImage } from '../lib/uncertainty'
import { DEFAULT_WEARER, type MapMeta } from '../lib/types'
import { drawHardHat } from './theme'
import { TRAIL_S, crewColor, growBox, insets, type RendererProps, knownBounds, type Box } from './types'

const WALL_OVERHEAD = 0.9 // m: cut-away height so rooms stay visible from above
const WALL_FULL = 2.6 // m: in first person
const EYE_H = 1.6
const FOV_OVERHEAD = 32
const FOV_FIRST = 72
const HAZE_SIZE = 1.8 // m, haze billboard diameter: large, faint, overlapping, so they merge into one cloud

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
  setFloorBase: (canvas: HTMLCanvasElement | null, meta: MapMeta | null) => void
  setField: (...args: Parameters<DisplayField['setTarget']> | [null]) => void
  setPlumeMask: (m: { data: Uint8Array; meta: MapMeta }) => void
  setMarks: (marks: Mark[]) => void
  setTheme: () => void
  recenter: () => void
}

export default function Map3D(props: RendererProps & { firstPerson: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const p = useRef(props)
  const known = useRef<Box | null>(null) // what has been mapped so far, for the default view
  p.current = props
  const api = useRef<Api | null>(null)
  const [ghostOn, setGhostOn] = useState(false)
  const compassRef = useRef<SVGSVGElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)

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
    floor.visible = false // until the first floor texture arrives (a bare MeshBasicMaterial would render white)
    floor.visible = false
    scene.add(floor)

    // gas: particle cloud, drifting
    const gasMat = new THREE.ShaderMaterial({
      vertexShader: GAS_VERT, fragmentShader: GAS_FRAG, transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uMaxSize: { value: 220 }, uAlpha: { value: 1 } },
    })
    // live cloud: the blooms and particles the 2D map shows, as puffs around sensor height
    const liveMat = gasMat.clone()
    liveMat.blending = THREE.AdditiveBlending
    const liveGas = new THREE.Points(new THREE.BufferGeometry(), liveMat)
    liveGas.frustumCulled = false
    liveGas.renderOrder = 3
    liveGas.visible = false // per-particle points read as opaque discs in 3D: never shown
    scene.add(liveGas)
    // the haze: large, faint billboards above elevated cells of the draped field, merging into one cloud
    const hazeMat = gasMat.clone()
    hazeMat.blending = THREE.AdditiveBlending
    const haze = new THREE.Points(new THREE.BufferGeometry(), hazeMat)
    haze.frustumCulled = false
    haze.renderOrder = 3
    scene.add(haze)
    const plume = new Plume()
    let plumeAt = 0
    // the floor picture is composed here, a few times a second: granite base (+ fog), the
    // diffusing field as band fill + contours, and the bloom splats, exactly as the 2D map draws them
    const display = new DisplayField()
    let floorBase: { canvas: HTMLCanvasElement; meta: MapMeta } | null = null
    const floorCanvas = document.createElement('canvas')
    const floorCtx = floorCanvas.getContext('2d')!
    const bloomCanvas = document.createElement('canvas')
    const bloomCtx = bloomCanvas.getContext('2d')!


    // commander's annotations: always-on-top pins, constant screen size
    const markGroup = new THREE.Group()
    scene.add(markGroup)
    const markTex = new Map<string, THREE.CanvasTexture>()
    const markTexture = (m: Mark) => {
      let t = markTex.get(m.kind)
      if (t) return t
      const c = document.createElement('canvas')
      c.width = 160; c.height = 112
      const g = c.getContext('2d')!
      g.scale(2, 2)
      drawMark(g, m, 40, 16, 13, markKind(m.kind).label)
      t = new THREE.CanvasTexture(c)
      t.colorSpace = THREE.SRGBColorSpace
      markTex.set(m.kind, t)
      return t
    }

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
      const arrow = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0.9, 0), new THREE.Vector2(0.35, 0.16), new THREE.Vector2(0.35, -0.16)]))
                                     .rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false }))
      arrow.position.y = 0.03
      arrow.name = 'arrow'
      ring.add(arrow)
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
      gasMat.blending = T.glow3d === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending
      gasMat.needsUpdate = true
      liveMat.needsUpdate = true; hazeMat.needsUpdate = true
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
      const b = growBox(known.current ?? { x0: m.origin[0], y0: m.origin[1], x1: m.origin[0] + m.w * m.res, y1: m.origin[1] + m.h * m.res },
                        p.current.poses.map(({ pose }) => pose))
      const mw = Math.max(1, b.x1 - b.x0), mh = Math.max(1, b.y1 - b.y0)
      const target = new THREE.Vector3((b.x0 + b.x1) / 2, 0, -(b.y0 + b.y1) / 2)
      const aw = Math.max(50, size.w - ins.left - ins.right), ah = Math.max(50, size.h - ins.top - ins.bottom)
      const tv = Math.tan((FOV_OVERHEAD * Math.PI) / 360) * (ah / size.h), th = tv * (aw / ah)
      const dist = ((0.5 * Math.hypot(mw, mh)) / Math.min(tv, th)) * 0.9
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

    // a click (not a drag) while placing an annotation: where it hits the floor
    let press: { x: number; y: number } | null = null
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), hit = new THREE.Vector3()
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const onPress = (e: PointerEvent) => { press = { x: e.clientX, y: e.clientY } }
    const onRelease = (e: PointerEvent) => {
      const pick = p.current.onPick
      if (!press || !pick || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) { press = null; return }
      press = null
      const r = renderer.domElement.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      if (ray.ray.intersectPlane(ground, hit)) pick(hit.x, -hit.z)
    }
    renderer.domElement.addEventListener('pointerdown', onPress)
    renderer.domElement.addEventListener('pointerup', onRelease)

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
      setField(...args) { if (args[0] == null) display.clear(); else display.setTarget(...(args as Parameters<DisplayField['setTarget']>)) },
      setFloorBase(canvas, m) { floorBase = canvas && m ? { canvas, meta: m } : null; plumeAt = 0 },
      setFloor(canvas, m) {
        const old = floorMat.map
        const tex = new THREE.CanvasTexture(canvas)
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = 4
        floorMat.map = tex
        floorMat.needsUpdate = true
        floor.visible = true
        old?.dispose()
        floor.scale.set(m.w * m.res, 1, m.h * m.res)
        floor.position.set(m.origin[0] + (m.w * m.res) / 2, 0, -(m.origin[1] + (m.h * m.res) / 2))
        floor.visible = true
      },
      setMarks(marks) {
        for (const c of [...markGroup.children]) { markGroup.remove(c); ((c as THREE.Sprite).material as THREE.SpriteMaterial).dispose() }
        for (const m of marks) {
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: markTexture(m), depthTest: false, sizeAttenuation: false }))
          sp.center.set(0.5, 0) // the pin's foot sits on the point
          sp.position.set(m.x, 0.05, -m.y)
          sp.renderOrder = 11
          sp.userData.markSprite = true
          markGroup.add(sp)
        }
      },
      setPlumeMask(m) { plume.setMask(m) },
      setTheme,
      recenter() {
        look = { yaw: 0, pitch: -0.12 }
        if (ghost) { ghost = null; setGhostOn(false) }
        goal = defaultView()
        moved = false
        p.current.onMoved(false)
      },
    }

    // ghost: a free camera in first person. WASD (B = back) moves, drag looks, C returns to the wearer.
    let ghost: { pos: THREE.Vector3; yaw: number } | null = null
    const keys = new Set<string>()
    const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) }
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (['w', 'a', 's', 'd', 'b', 'q', 'e', 'shift', ' '].includes(k)) { keys.add(k); if (k === ' ') e.preventDefault() }
    }
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase())
    const onBlur = () => keys.clear()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    const passable = (x: number, y: number) => {
      const m = p.current.meta, data = pixels.current
      if (!m || !data) return true
      const top = m.origin[1] + m.h * m.res
      const cc = Math.floor((x - m.origin[0]) / m.res), rr = Math.floor((top - y) / m.res)
      if (cc < 0 || rr < 0 || cc >= m.w || rr >= m.h) return false
      const a = data[(rr * m.w + cc) * 4 + 3]
      return a === 0 || a > 240
    }
    let lastTick = performance.now()

    let raf = 0
    let alertKey = ''
    let trailKey = ''
    let placed = false
    let wasFirst = false
    const eye = new THREE.PerspectiveCamera() // a camera, so lookAt() faces the target along -Z like the real one (an Object3D would face away)
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
        const dim = P.only != null && id !== P.only
        pr.badge.material.opacity = dim ? 0.3 : 1
        pr.badge.material.transparent = true
        pr.group.visible = !(fp && sel)
        const s = sel ? 0.046 : 0.036
        pr.badge.scale.set(s, s, 1)
        const pulse = (performance.now() % 2200) / 2200
        pr.ring.scale.setScalar(sel ? 1 + pulse * 1.6 : 1)
      const arrow = pr.ring.getObjectByName('arrow') as THREE.Mesh | undefined
      if (arrow) { arrow.rotation.y = pr.heading; arrow.scale.setScalar((sel ? 1.25 : 1) / pr.ring.scale.x); (arrow.material as THREE.MeshBasicMaterial).color.set(pr.color || '#fff'); (arrow.material as THREE.MeshBasicMaterial).opacity = dim ? 0.25 : 0.95 }
        ;(pr.ring.material as THREE.MeshBasicMaterial).opacity = dim ? 0.15 : sel ? 1 - pulse : 0.5
      }
      for (const [id, pr] of people) if (!live.has(id)) pr.group.visible = false

      // trails, per wearer (rebuilt when they change)
      const tk = P.layers.paths ? `${P.trail.length}:${P.trail.at(-1)?.ts}:${T.trail}:${P.poses.length}:${P.only}` : 'off'
      if (tk !== trailKey) {
        trailKey = tk
        const tEnd = Date.parse(P.trail.at(-1)?.ts ?? '0')
        const pos: number[] = [], col: number[] = []
        const last = new Map<string, { x: number; y: number }>()
        const c = new THREE.Color()
        if (P.layers.paths) for (const t of P.trail) {
          if (Date.parse(t.ts) < tEnd - TRAIL_S * 1000) continue
          const id = t.wearer ?? DEFAULT_WEARER
          if (P.only && id !== P.only) continue
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
      const shownAlerts = P.layers.alerts ? P.alerts.filter((a) => !P.only || !a.wearer || a.wearer === P.only) : []
      const ak = shownAlerts.map((a) => a.ts).join()
      if (ak !== alertKey) {
        alertKey = ak
        alertGroup.clear()
        for (const a of shownAlerts) {
          const m = new THREE.Mesh(alertGeo, alertMat)
          m.position.set(a.x, 0.025, -a.y)
          alertGroup.add(m)
        }
      }
      markGroup.visible = P.layers.marks
      {
        const sm = (0.16 * 2) / size.h * 80 // ~80 px tall whatever the viewport
        for (const c of markGroup.children) (c as THREE.Sprite).scale.set(sm * (160 / 112), sm, 1)
      }

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

      const tnow = performance.now()
      const dt = Math.min(0.1, (tnow - lastTick) / 1000)
      lastTick = tnow

      const me = people.get(P.selected)
      // ghost: the first key press detaches the camera from the wearer
      if (fp && !ghost && me?.shown && ['w', 'a', 's', 'd', 'b'].some((k) => keys.has(k))) {
        ghost = { pos: new THREE.Vector3(me.shown.x, 1.2, me.shown.z), yaw: me.heading + look.yaw }
        look = { yaw: 0, pitch: look.pitch }
        setGhostOn(true)
      }
      if (!fp && ghost) { ghost = null; setGhostOn(false) }
      if (fp && ghost) {
        const yaw = ghost.yaw + look.yaw
        const fwd = (keys.has('w') ? 1 : 0) - (keys.has('s') || keys.has('b') ? 1 : 0)
        const side = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0)
        const up = (keys.has('e') || keys.has(' ') ? 1 : 0) - (keys.has('q') || keys.has('shift') ? 1 : 0)
        const v = 1.5 * dt
        // world: x east, z = -north; forward along yaw, right is yaw - 90°
        const dx = (Math.cos(yaw) * fwd + Math.sin(yaw) * side) * v
        const dzn = (Math.sin(yaw) * fwd - Math.cos(yaw) * side) * v // in map y (north)
        const gx = ghost.pos.x, gy = -ghost.pos.z
        if (passable(gx + dx, gy + dzn)) { ghost.pos.x += dx; ghost.pos.z -= dzn }
        else if (passable(gx + dx, gy)) ghost.pos.x += dx
        else if (passable(gx, gy + dzn)) ghost.pos.z -= dzn
        ghost.pos.y = Math.max(0.4, Math.min(2.4, ghost.pos.y + up * v))
        const pitch = look.pitch
        eye.position.copy(ghost.pos)
        eye.lookAt(ghost.pos.x + Math.cos(yaw) * Math.cos(pitch), ghost.pos.y + Math.sin(pitch), ghost.pos.z - Math.sin(yaw) * Math.cos(pitch))
        camera.position.lerp(eye.position, 0.3)
        camera.quaternion.slerp(eye.quaternion, 0.2)
      } else if (fp && me?.shown) {
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

      // the floor picture: diffusing field + contours + blooms draped on the floor, a soft haze above elevated spots
      if (floorBase && P.meta) {
        const wall = Date.now()
        const live = P.until == null
        plume.sync(P.trail, P.until ?? wall)
        if (live) plume.step(dt, null, wall)
        const moved = display.tick(tnow, live)
        if (moved || tnow - plumeAt > 400) try {
          plumeAt = tnow
          const m = floorBase.meta, top = m.origin[1] + m.h * m.res
          if (floorCanvas.width !== m.w || floorCanvas.height !== m.h) { floorCanvas.width = m.w; floorCanvas.height = m.h; bloomCanvas.width = m.w; bloomCanvas.height = m.h }
          floorCtx.globalCompositeOperation = 'source-over'
          floorCtx.clearRect(0, 0, m.w, m.h)
          floorCtx.drawImage(floorBase.canvas, 0, 0)
          const px = (x: number) => (x - m.origin[0]) / m.res, py = (y: number) => (top - y) / m.res
          const dg = P.layers.gas ? display.grid() : null
          const hz: number[] = [], hc: number[] = [], ha: number[] = [], hp: number[] = []
          if (dg) {
            const band = bandImage(dg, { prior: dg.prior, priorWeight: 1, alphaBy: dg.alphaBy, skipThin: true })
            floorCtx.globalCompositeOperation = 'source-atop' // only on scanned floor
            floorCtx.imageSmoothingEnabled = true
            floorCtx.drawImage(band.canvas, px(band.x0), py(band.y1), band.w / m.res, band.h / m.res)
            strokeIsolines(floorCtx, isolines(dg, { prior: dg.prior, priorWeight: 1 }), px, py, 1.4, P.theme.ink)
            // haze: large, faint, overlapping billboards over cells at or above the moderate band
            const a0 = SCALE.bands[0]
            let seed = 3
            const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
            for (let r = 0; r < dg.rows; r++) for (let c = 0; c < dg.cols; c++) {
              const i = r * dg.cols + c
              if (!dg.den[i] || dg.num[i] < a0) continue
              const v = dg.num[i], t = rampT(v), [cr, cg, cb] = rampColor(t)
              const x = dg.x0 + (c + 0.5) * dg.res, y = dg.y0 + (r + 0.5) * dg.res
              const n = v >= SCALE.bands[2] ? 3 : v >= SCALE.bands[1] ? 2 : 1
              for (let k = 0; k < n; k++) {
                hz.push(x + (rnd() - 0.5) * 0.3, 0.7 + rnd() * 0.9 + k * 0.25, -(y + (rnd() - 0.5) * 0.3))
                hc.push(cr / 255, cg / 255, cb / 255)
                ha.push(0.035 * Math.min(1.6, 0.6 + t)) // density comes from overlap, not from any one billboard
                hp.push(rnd() * Math.PI * 2)
              }
            }
          }
          // bloom splats, clipped to the scanned floor
          bloomCtx.globalCompositeOperation = 'source-over'
          bloomCtx.clearRect(0, 0, m.w, m.h)
          plume.draw(bloomCtx, px, py, 1 / m.res, P.until ?? wall, { particles: false }) // splats only: no per-particle dots in 3D
          floorCtx.globalCompositeOperation = 'source-atop'
          floorCtx.drawImage(bloomCanvas, 0, 0)
          floorCtx.globalCompositeOperation = 'source-over'
          api.current?.setFloor(floorCanvas, m)
          const g = new THREE.BufferGeometry()
          g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(hz), 3))
          g.setAttribute('aColor', new THREE.BufferAttribute(Float32Array.from(hc), 3))
          g.setAttribute('aAlpha', new THREE.BufferAttribute(Float32Array.from(ha), 1))
          g.setAttribute('aPhase', new THREE.BufferAttribute(Float32Array.from(hp), 1))
          haze.geometry.dispose(); haze.geometry = g
        } catch (err) {
          console.warn('floor compose failed; keeping the base floor', err)
          api.current?.setFloor(floorBase.canvas, floorBase.meta)
        }
        haze.visible = P.layers.gas
      } else haze.visible = false
      liveGas.visible = false // the particle Points stay hidden in 3D, whatever the layer toggle
      hazeMat.uniforms.uTime.value = (performance.now() - t0) / 1000
      hazeMat.uniforms.uScale.value = (HAZE_SIZE * size.h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360))
      hazeMat.uniforms.uMaxSize.value = 140 * renderer.getPixelRatio()
      hazeMat.uniforms.uAlpha.value = fp ? 0.7 : 1

      // orientation: the rose turns with the camera; in first person a heading strip shows degrees and the nearest points
      {
        const dir = new THREE.Vector3(); camera.getWorldDirection(dir)
        const camYaw = Math.atan2(-dir.z, dir.x) // map frame: 0 = east, counter-clockwise
        const north = ((Math.PI / 2 - camYaw) * 180) / Math.PI // screen rotation that keeps N pointing north
        if (compassRef.current) compassRef.current.style.transform = `rotate(${-north}deg)`
        if (stripRef.current) {
          const hdg = ((90 - (camYaw * 180) / Math.PI) % 360 + 360) % 360 // compass heading, 0 = N clockwise
          const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
          const left = names[(Math.round(hdg / 45) + 7) % 8], right = names[(Math.round(hdg / 45) + 1) % 8]
          stripRef.current.textContent = `${left}   ·   ${Math.round(hdg)}°   ·   ${right}`
          stripRef.current.style.display = fp ? '' : 'none'
        }
      }
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur)
      ro.disconnect()
      controls.removeEventListener('start', onStart)
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerdown', onPress)
      renderer.domElement.removeEventListener('pointerup', onRelease)
      for (const t of markTex.values()) t.dispose()
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

  const { image, meta, theme, heat, recenter, layers, marks } = props
  const field = props.gas?.field ?? null

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
    known.current = knownBounds((i) => data[i * 4 + 3], meta)
    const lookup = new Uint8Array(meta.w * meta.h)
    for (let i = 0; i < lookup.length; i++) if (data[i * 4 + 3] > 240) lookup[i] = 1
    api.current.setPlumeMask({ data: lookup, meta })
    api.current.setWalls(wallRects((i) => data[i * 4 + 3], meta.w, meta.h), meta)
  }, [image, meta])

  // floor + gas: the measured field on scanned floor
  useEffect(() => {
    const data = pixels.current
    if (!meta || !data || !api.current) return
    const c = document.createElement('canvas')
    c.width = meta.w; c.height = meta.h
    const g = c.getContext('2d')!
    const img = g.createImageData(meta.w, meta.h)
    const col = new THREE.Color(theme.floor3d)
    const [fr, fg, fb] = [col.r, col.g, col.b].map((v) => Math.round(v * 255))
    // the backend's PNG encodes free/occupied/unknown in alpha; an image without any transparent
    // pixel carries no such layout, so the whole plan is treated as floor rather than left white
    let anyUnknown = false
    for (let i = 3; i < data.length; i += 4) if (data[i] === 0) { anyUnknown = true; break }
    for (let i = 0; i < meta.w * meta.h; i++) {
      if (!anyUnknown || data[i * 4 + 3] > 240) { img.data[i * 4] = fr; img.data[i * 4 + 1] = fg; img.data[i * 4 + 2] = fb; img.data[i * 4 + 3] = 255 }
    }
    g.putImageData(img, 0, 0)
    const top = meta.origin[1] + meta.h * meta.res
    const fog = layers.uncertainty && field ? uncertaintyImage(field) : null
    if (fog) {
      g.globalCompositeOperation = 'source-atop'
      g.imageSmoothingEnabled = true
      g.drawImage(fog.canvas, (fog.x0 - meta.origin[0]) / meta.res, (top - fog.y1) / meta.res, fog.w / meta.res, fog.h / meta.res)
    }
    // the field itself goes through the diffusing display (same as the 2D map); the tick composes it onto this base
    const isFree = (x: number, y: number) => {
      const cc = Math.floor((x - meta.origin[0]) / meta.res), rr = Math.floor((top - y) / meta.res)
      return cc >= 0 && rr >= 0 && cc < meta.w && rr < meta.h && data[(rr * meta.w + cc) * 4 + 3] > 240
    }
    if (field) {
      const fg0 = layerGrid(field, field.mean, field.conf, 0.1)
      api.current.setField(fg0, (i) => fg0.num[i], (i) => fg0.conf[i] > 0, (i) => 0.2 + 0.8 * fg0.conf[i], isFree, field.base)
    } else {
      const kg = kernelGrid(heat, 0.3, 0.05)
      if (kg) api.current.setField(kg, (i) => (kg.den[i] > 0 ? kg.num[i] / kg.den[i] : NaN), (i) => kg.den[i] >= 0.3, (i) => Math.min(1, kg.den[i] / 0.9), isFree, 0.2 * SCALE.bands[0])
      else api.current.setField(null)
    }
    api.current.setFloor(c, meta) // granite (and fog) right away; the tick overlays the field and splats
    api.current.setFloorBase(c, meta)
  }, [meta, theme, heat, layers.gas, layers.uncertainty, field])

  useEffect(() => { api.current?.setMarks(marks) }, [marks])
  useEffect(() => { api.current?.setTheme() }, [theme])
  useEffect(() => { if (recenter) api.current?.recenter() }, [recenter])

  return (
    <>
      <div ref={hostRef} className={`map-3d${props.onPick ? ' picking' : ''}`} />
      <Compass ref={compassRef} className="compass-3d" />
      <div ref={stripRef} className="heading-strip mono" style={{ display: 'none' }} />
      {ghostOn && <div className="ghost-hint">Ghost · W A S D to move · press C to return</div>}
    </>
  )
}
