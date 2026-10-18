// The burning house, outside and in, as a "temperature" scene: grayscale materials,
// warm point lights at the fires, noise flames, embers. Rendered tiny, then cell-ised.
import * as THREE from 'three'
import { EMBER_F, EMBER_V, FIRE_F, QUAD_V, SMOKE_F } from './shaders'
import { T, lerp, reducedMotion, span, win } from './util'

type Fire = { mat: THREE.ShaderMaterial; base: number; zone: 'out' | 'in'; seed: number }
type Lamp = { light: THREE.PointLight; base: number; zone: 'out' | 'in'; seed: number }
type Key = { p: number; pos: THREE.Vector3; look: THREE.Vector3 }

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

// Opening shot on the house, pan up to the sky for the helmet beat, pan back down, walk in.
const PATH: Key[] = [
  // opening: the house framed in the lower half (title above), then tilt up into the sky
  { p: 0.0, pos: V(2.6, 1.7, 6.5), look: V(0, 12.8, -20) },
  { p: 0.03, pos: V(2.6, 1.7, 6.5), look: V(0, 12.8, -20) },
  { p: 0.075, pos: V(2.6, 1.7, 6.5), look: V(0, 34, -16) },
  { p: 0.225, pos: V(2.6, 1.7, 6.5), look: V(0, 34, -16) },
  // pan down onto the firefighter, hold while the hat sets, push in through the head to POV
  { p: 0.262, pos: V(1.1, 1.6, -6.2), look: V(0.3, 1.3, -9) },
  { p: 0.276, pos: V(1.1, 1.6, -6.2), look: V(0.3, 1.32, -9) },
  { p: 0.315, pos: V(0.3, 1.62, -9), look: V(0, 1.5, -16) },
  { p: 0.335, pos: V(0.25, 1.55, -13.6), look: V(0, 1.5, -26) },
  { p: 0.4, pos: V(0, 1.55, -17.5), look: V(0, 1.5, -28) },
  { p: 0.49, pos: V(0, 1.55, -22.5), look: V(0, 1.45, -34) },
  { p: 0.61, pos: V(0, 1.55, -24), look: V(0, 1.45, -34) },
  { p: 0.782, pos: V(0, 1.55, -30), look: V(0, 1.45, -38) },
  { p: 0.818, pos: V(0, 1.55, -29.2), look: V(0, 1.45, -38) },
]

/** Monotone cubic Hermite through the keys (per component): eases, never overshoots. */
function interp(keys: Key[], p: number, which: 'pos' | 'look', out: THREE.Vector3) {
  let i = 0
  while (i < keys.length - 2 && p >= keys[i + 1].p) i++
  const dp = keys[i + 1].p - keys[i].p
  const t = Math.min(1, Math.max(0, (p - keys[i].p) / dp))
  const comps = ['x', 'y', 'z'] as const
  for (const c of comps) {
    const v = (k: number) => keys[Math.min(keys.length - 1, Math.max(0, k))][which][c]
    const dq = (k: number) => (v(k + 1) - v(k)) / (keys[Math.min(keys.length - 1, k + 1)].p - keys[Math.max(0, k)].p || 1)
    const slope = (k: number) => {
      if (k <= 0) return dq(0)
      if (k >= keys.length - 1) return dq(keys.length - 2)
      const a = dq(k - 1), b = dq(k)
      return a * b <= 0 ? 0 : 2 / (1 / a + 1 / b)
    }
    const m0 = slope(i) * dp, m1 = slope(i + 1) * dp
    const t2 = t * t, t3 = t2 * t
    out[c] = (2 * t3 - 3 * t2 + 1) * v(i) + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v(i + 1) + (t3 - t2) * m1
  }
  return out
}

export class World {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.05, 220)
  impulse = 0
  /** Final shot: where the house should land on screen (NDC) and the camera z. */
  private endAim = new THREE.Vector2(-0.5, 0.5)
  private endCamZ = 16
  private impulseAge = 0
  private fires: Fire[] = []
  private lamps: Lamp[] = []
  private smokes: THREE.Mesh[] = []
  private fog = new THREE.FogExp2(0x000000, 0.02)
  private fogD = { value: 0.02 }
  private time = { value: 0 }
  private emberScale = { value: 60 }
  private embersOut: THREE.Points
  private embersIn: THREE.Points
  private figure = new THREE.Group()
  private figureMats: THREE.Material[] = []
  /** The real helmet (from the spin beat) while it travels down onto the figure. */
  hat: { rig: THREE.Object3D; d0: number; scale: number; fitH: number; heroFrac: number; setOpacity(a: number): void } | null = null
  private local = new THREE.Vector3()
  private probe = new THREE.PerspectiveCamera()
  private qRel = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.32, 0, 0))
  private qEnd = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0))
  private q0 = new THREE.Quaternion()
  private tmpA = new THREE.Vector3()
  private tmpB = new THREE.Vector3()
  private tmpPos = new THREE.Vector3()
  private tmpLook = new THREE.Vector3()
  private disposables: { dispose(): void }[] = []

  constructor() {
    const s = this.scene
    s.fog = this.fog
    s.background = new THREE.Color(0x000000)

    const wallOut = this.mat(new THREE.MeshStandardMaterial({ color: 0x7a7a7a, roughness: 1 }))
    const roofM = this.mat(new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 1 }))
    const ground = this.mat(new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 1 }))
    const wallIn = this.mat(new THREE.MeshStandardMaterial({ color: 0x6e6a64, roughness: 1, side: THREE.DoubleSide }))
    const hole = this.mat(new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide }))

    s.add(new THREE.AmbientLight(0xffffff, 0.6))

    // ground
    const g = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(320, 320)), ground)
    g.rotation.x = -Math.PI / 2
    s.add(g)

    // house shell (no front face: the front wall is built around the door)
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
      const mesh = new THREE.Mesh(this.geo(new THREE.BoxGeometry(w, h, d)), m)
      mesh.position.set(x, y, z)
      s.add(mesh)
      return mesh
    }
    const plane = (w: number, h: number, x: number, y: number, z: number, ry: number, m: THREE.Material, rx = 0) => {
      const mesh = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(w, h)), m)
      mesh.position.set(x, y, z)
      mesh.rotation.set(rx, ry, 0)
      s.add(mesh)
      return mesh
    }
    plane(18.2, 6, -5, 3, -24.1, Math.PI / 2, wallOut)
    plane(18.2, 6, 5, 3, -24.1, -Math.PI / 2, wallOut)
    plane(10, 6, 0, 3, -33.2, 0, wallOut)
    box(4.35, 6, 0.3, -2.825, 3, -15, wallOut)
    box(4.35, 6, 0.3, 2.825, 3, -15, wallOut)
    box(1.3, 3.7, 0.3, 0, 4.15, -15, wallOut)
    // roof
    const tri = new THREE.Shape([new THREE.Vector2(-5.7, 5.9), new THREE.Vector2(5.7, 5.9), new THREE.Vector2(0, 8.7)])
    const roof = new THREE.Mesh(this.geo(new THREE.ExtrudeGeometry(tri, { depth: 19.4, bevelEnabled: false })), roofM)
    roof.position.z = -33.8
    s.add(roof)
    box(0.8, 2.4, 0.8, 3.2, 8.4, -23, wallOut)
    // step in front of the door
    box(2.4, 0.18, 1.2, 0, 0.09, -14.3, wallOut)

    // windows on the front wall: fire + heat on the wall around it
    const windows: [number, number, number, number][] = [
      [-3.2, 1.7, 1.2, 1.5], [3.2, 1.7, 1.2, 1.5], [-3.2, 4.4, 1.0, 1.3], [3.2, 4.4, 1.0, 1.3], [0, 4.7, 0.9, 1.0],
    ]
    windows.forEach(([x, y, w, h], i) => {
      this.fire(w, h, x, y, -14.84, 0, 'out', 1.05, i * 1.7)
      this.lamp(x, y, -14.4, 5, 3.6, 'out', 0.9, i * 2.1)
    })
    // door: open, glowing
    this.fire(1.3, 2.3, 0, 1.15, -15.4, 0, 'out', 0.55, 9)
    this.lamp(0, 1.4, -14.2, 10, 7, 'out', 1, 4.4)

    // hallway
    plane(2.6, 18, 0, 0.01, -24, 0, wallIn, -Math.PI / 2)
    plane(2.6, 18, 0, 2.8, -24, 0, wallIn, Math.PI / 2)
    plane(18, 2.8, -1.3, 1.4, -24, Math.PI / 2, wallIn)
    plane(18, 2.8, 1.3, 1.4, -24, -Math.PI / 2, wallIn)
    plane(2.6, 2.8, 0, 1.4, -33, 0, wallIn)
    const doorways: [number, number][] = [[-1, -19], [1, -22.5], [-1, -26.5], [1, -30]]
    doorways.forEach(([side, z], i) => {
      const ry = side < 0 ? Math.PI / 2 : -Math.PI / 2
      plane(1.0, 2.1, side * 1.29, 1.05, z, ry, hole)
      this.fire(1.0, 2.1, side * 1.27, 1.05, z, ry, 'in', 1.15, 20 + i * 3.3)
      this.lamp(side * 0.85, 1.3, z, 14, 6.5, 'in', 1, 30 + i * 1.9)
    })
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const z = -18 - k * 6
        const ry = side < 0 ? Math.PI / 2 : -Math.PI / 2
        this.fire(5.5, 1.3, side * 1.26, 0.65, z, ry, 'in', 0.9, 40 + k * 2 + side)
      }
    }
    this.fire(2.6, 2.8, 0, 1.4, -32.95, 0, 'in', 1.25, 55)
    this.lamp(0, 1.4, -32, 22, 9, 'in', 1, 61)
    const beam = box(3, 0.18, 0.18, 0, 2.45, -25.5, wallOut)
    beam.rotation.z = 0.18

    // the firefighter, back to us, facing the house; stripes read hot in the thermal image
    // unlit: a warm body reads as a steady mid temperature, the reflective stripes as hot
    const body = this.mat(new THREE.MeshBasicMaterial({ color: 0x949494, transparent: true }))
    const stripe = this.mat(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }))
    this.figureMats.push(body, stripe)
    const part = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent = this.figure) => {
      const mesh = new THREE.Mesh(this.geo(g), m)
      mesh.position.set(x, y, z)
      parent.add(mesh)
      return mesh
    }
    part(new THREE.SphereGeometry(0.13, 16, 12), body, 0, 1.6, 0)
    part(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10), body, 0, 1.47, 0)
    part(new THREE.BoxGeometry(0.62, 0.12, 0.3), body, 0, 1.4, 0)
    part(new THREE.BoxGeometry(0.52, 0.72, 0.3), body, 0, 1.07, 0)
    for (const sx of [-1, 1]) {
      part(new THREE.BoxGeometry(0.13, 0.62, 0.16), body, sx * 0.34, 1.08, 0)
      part(new THREE.BoxGeometry(0.15, 0.04, 0.18), stripe, sx * 0.34, 0.92, 0)
      part(new THREE.BoxGeometry(0.17, 0.72, 0.2), body, sx * 0.12, 0.36, 0)
    }
    part(new THREE.BoxGeometry(0.54, 0.05, 0.32), stripe, 0, 1.28, 0)
    part(new THREE.BoxGeometry(0.54, 0.05, 0.32), stripe, 0, 0.84, 0)
    this.figure.position.set(0.3, 0, -9)
    s.add(this.figure)

    // embers, outside and in
    this.embersOut = this.embers(320, V(0, 6, -22), V(13, 8, 15), 10)
    this.embersIn = this.embers(260, V(0, 0.9, -24), V(2.4, 1.6, 18), 2.4)
    s.add(this.embersOut, this.embersIn)

    // smoke above the roof
    for (let i = 0; i < 5; i++) {
      const m = this.mat(new THREE.ShaderMaterial({
        vertexShader: QUAD_V, fragmentShader: SMOKE_F, transparent: true, depthWrite: false,
        uniforms: { uTime: this.time, uSeed: { value: i * 3.7 }, uAlpha: { value: 0.55 }, uFogD: this.fogD },
      }))
      const mesh = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(7, 7)), m)
      mesh.position.set(-4 + i * 2.1, 9.5 + (i % 2) * 1.6, -26 + i * 1.8)
      this.smokes.push(mesh)
      s.add(mesh)
    }
  }

  private geo<G extends THREE.BufferGeometry>(g: G) { this.disposables.push(g); return g }
  private mat<M extends THREE.Material>(m: M) { this.disposables.push(m); return m }

  private fire(w: number, h: number, x: number, y: number, z: number, ry: number, zone: 'out' | 'in', base: number, seed: number) {
    const mat = this.mat(new THREE.ShaderMaterial({
      vertexShader: QUAD_V, fragmentShader: FIRE_F, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: {
        uTime: this.time, uIntensity: { value: base }, uSeed: { value: seed }, uFogD: this.fogD,
        uStretch: { value: w / h },
      },
    }))
    const mesh = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(w, h)), mat)
    mesh.position.set(x, y, z)
    mesh.rotation.y = ry
    this.scene.add(mesh)
    this.fires.push({ mat, base, zone, seed })
  }

  private lamp(x: number, y: number, z: number, intensity: number, distance: number, zone: 'out' | 'in', base: number, seed: number) {
    const light = new THREE.PointLight(0xffffff, intensity, distance, 2)
    light.position.set(x, y, z)
    this.scene.add(light)
    this.lamps.push({ light, base: intensity * base, zone, seed })
  }

  private embers(count: number, centre: THREE.Vector3, ext: THREE.Vector3, height: number) {
    const pos = new Float32Array(count * 3), rnd = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = centre.x + (Math.random() - 0.5) * ext.x
      pos[i * 3 + 1] = centre.y - ext.y / 2 + Math.random() * ext.y
      pos[i * 3 + 2] = centre.z + (Math.random() - 0.5) * ext.z
      rnd[i * 3] = Math.random(); rnd[i * 3 + 1] = Math.random(); rnd[i * 3 + 2] = Math.random()
    }
    const g = this.geo(new THREE.BufferGeometry())
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 3))
    const m = this.mat(new THREE.ShaderMaterial({
      vertexShader: EMBER_V, fragmentShader: EMBER_F, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.time, uScale: this.emberScale, uHeight: { value: height } },
    }))
    const pts = new THREE.Points(g, m)
    pts.frustumCulled = false
    return pts
  }

  setRtHeight(h: number) { this.emberScale.value = h * 0.07 }

  /**
   * Frame the final exterior shot so the house lands at screen point (nx, ny) in NDC
   * (-1..1, y up) and is about `housePx` tall on a viewport `viewH` CSS px tall.
   */
  setEndFraming(nx: number, ny: number, housePx: number, viewH: number) {
    this.endAim.set(nx, ny)
    const fov = (this.camera.fov * Math.PI) / 180
    const dist = (9 * viewH) / (Math.max(40, housePx) * 2 * Math.tan(fov / 2))
    this.endCamZ = -20 + dist
  }

  /** Portrait screens start further back so the whole facade fits. */
  setPortrait(portrait: boolean) {
    for (let i = 0; i < 4; i++) PATH[i].pos.z = portrait ? 9 : 6.5
    for (const i of [4, 5]) { PATH[i].pos.z = portrait ? -5.0 : -6.2; PATH[i].pos.x = portrait ? 0.9 : 1.1 }
  }

  /**
   * The helmet from the spin beat: starts on the camera's forward ray at the distance that
   * reproduces its on-screen size, flies (at real size, so it shrinks with distance) to a
   * hover above the head, then eases down with a small set bob. Orientation slerps from the
   * spin pose to brim-forward, matching the figure.
   */
  private placeHat(p: number, figA: number) {
    const hat = this.hat!
    const cam = this.camera
    cam.updateMatrixWorld()
    const tanH = Math.tan((cam.fov * Math.PI) / 360)
    const hero = span(p, T.helmet[1], T.hatLand[0]) // hero phase: the anchor drifts up a little
    const s = span(p, T.hatLand[0], T.hatLand[1]) // descent: anchor -> head, size -> true size, in one ease
    let bob = 0
    if (!reducedMotion) bob = -0.025 * Math.sin(Math.min(1, Math.max(0, (p - T.hatLand[1]) / 0.014)) * Math.PI)
    this.tmpB.set(0.3, 1.7 + bob + 0.3 * (1 - s) * (1 - s), -9)
    // the head in camera space -> its NDC anchor and depth
    const headCam = cam.worldToLocal(this.tmpA.copy(this.tmpB))
    const dHead = Math.max(0.1, -headCam.z)
    const headNx = headCam.x / (dHead * tanH * cam.aspect), headNy = headCam.y / (dHead * tanH)
    const ax = lerp(0, headNx, s), ay = lerp(0.12 * hero, headNy, s)
    const d = lerp(hat.d0, dHead, s)
    const frac = lerp(hat.heroFrac, (hat.fitH * hat.scale) / (2 * dHead * tanH), s)
    const scale = (frac * 2 * d * tanH) / hat.fitH
    this.local.set(ax * d * tanH * cam.aspect, ay * d * tanH, -d)
    hat.rig.position.copy(cam.localToWorld(this.local))
    hat.rig.scale.setScalar(scale)
    // orientation: carried over from the spin camera, then upright facing the house
    interp(PATH, T.helmet[1], 'pos', this.probe.position)
    interp(PATH, T.helmet[1], 'look', this.tmpA)
    this.probe.lookAt(this.tmpA)
    this.q0.copy(this.probe.quaternion).multiply(this.qRel)
    hat.rig.quaternion.slerpQuaternions(this.q0, this.qEnd, span(p, 0.246, 0.268))
    hat.setOpacity(figA)
  }

  /** A short, stronger, damped shake (the warning). */
  kick() {
    this.impulse = 1
    this.impulseAge = 0
  }

  /** Place the camera and animate the fire for progress p. `exterior` = the final table shot. */
  update(p: number, t: number, dt: number, shakeAmp: number, exterior: boolean) {
    this.time.value = reducedMotion ? t * 0.35 : t
    const cam = this.camera
    const inside = span(p, 0.33, 0.35) * (1 - span(p, T.cut - 0.001, T.cut))

    if (exterior) {
      if (cam.fov !== 58) { cam.fov = 58; cam.updateProjectionMatrix() }
      const push = span(p, T.cut, T.cut + 0.1)
      cam.position.set(-0.6, 1.5, this.endCamZ + lerp(0.8, 0, push))
      cam.position.x += Math.sin(t * 0.3) * 0.03
      cam.lookAt(0, 4.2, -20)
      const half = Math.tan((cam.fov * Math.PI) / 360)
      cam.rotateY(Math.atan(this.endAim.x * half * cam.aspect))
      cam.rotateX(-Math.atan(this.endAim.y * half))
    } else {
      // reduced motion: hold on the firefighter, then a short push-in
      let pp = p
      if (reducedMotion && p > 0.276 && p < T.pov) pp = p < 0.3 ? 0.276 : 0.276 + ((p - 0.3) / 0.015) * (T.pov - 0.276)
      interp(PATH, pp, 'pos', this.tmpPos)
      interp(PATH, pp, 'look', this.tmpLook)
      if (!reducedMotion) {
        this.tmpPos.y += Math.sin(-this.tmpPos.z * 2.4) * 0.02 * inside
        this.tmpPos.x += Math.sin(-this.tmpPos.z * 1.3) * 0.03 * inside
      }
      cam.position.copy(this.tmpPos)
      cam.lookAt(this.tmpLook)
      const fov = this.hat ? lerp(30, 58, span(p, T.helmet[1], 0.262)) : 58
      if (Math.abs(fov - cam.fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix() }
    }

    // shake: layered sines plus a damped impulse for the warning
    let imp = 0
    if (this.impulse > 0) {
      this.impulseAge += dt
      imp = this.impulse * Math.exp(-this.impulseAge * 3.4) * Math.sin(this.impulseAge * 26)
      if (this.impulseAge > 2.5) this.impulse = 0
    }
    if (shakeAmp > 0 || imp !== 0) {
      const n1 = Math.sin(t * 12.7) * 0.5 + Math.sin(t * 19.3 + 1.3) * 0.3 + Math.sin(t * 7.1 + 2) * 0.2
      const n2 = Math.sin(t * 11.1 + 0.5) * 0.5 + Math.sin(t * 17.9 + 2.1) * 0.3 + Math.sin(t * 5.7 + 1) * 0.2
      cam.rotateX(shakeAmp * n1 + imp * 0.045)
      cam.rotateY(shakeAmp * n2 * 0.8 + imp * 0.03)
      cam.rotateZ(shakeAmp * n2 * 0.3)
    }

    // the firefighter fades as we pass through the head
    const figA = exterior ? 0 : 1 - span(p, 0.298, T.pov)
    this.figure.visible = figA > 0.01
    for (const m of this.figureMats) m.opacity = figA
    if (this.hat) this.placeHat(p, figA)

    // fog: night air outside, thickening smoke inside
    const smokeIn = span(p, 0.37, 0.78)
    const fogIn = exterior ? 0 : inside
    this.fogD.value = lerp(0.018, 0.035 + 0.13 * smokeIn, fogIn)
    this.fog.density = this.fogD.value
    this.fog.color.setScalar(lerp(0, 0.3, fogIn))

    // fire grows as you go deeper; flicker unless reduced motion
    const grow = 0.55 + 0.6 * span(p, 0.35, 0.65)
    const flick = (seed: number) =>
      reducedMotion ? 1 : 0.86 + 0.14 * Math.sin(t * 7.3 + seed) * Math.sin(t * 3.1 + seed * 1.7) + 0.05 * Math.sin(t * 13 + seed)
    for (const f of this.fires) {
      const scale = f.zone === 'in' ? grow : 1
      f.mat.uniforms.uIntensity.value = f.base * scale * flick(f.seed)
    }
    for (const l of this.lamps) {
      const scale = l.zone === 'in' ? grow : 1
      l.light.intensity = l.base * scale * flick(l.seed + 0.5)
    }
    const lungs = win(p, T.lungs[0], T.lungs[1], 0.03, 0.03)
    this.embersIn.visible = inside > 0 && lungs < 0.98
    this.embersOut.visible = !this.embersIn.visible || exterior
    for (const m of this.smokes) {
      m.visible = this.embersOut.visible
      m.quaternion.copy(cam.quaternion)
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
  }
}
