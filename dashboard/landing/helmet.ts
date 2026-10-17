// 360° product shot of the helmet. Drop-in scan support:
//
//   Drop a scan at dashboard/public/models/helmet.glb (GLB, ideally < 5 MB, Y-up, metres);
//   it replaces the procedural helmet automatically. Nothing else to change.
//
// Without the file, a procedural hard hat is built from primitives: dome + brim, a LiDAR puck
// on top with a rotating slot, a Pi box on the back, a small gas-sensor box on the side.
import * as THREE from 'three'

const SCAN_URL = '/models/helmet.glb'
const FIT_RADIUS = 1.0

export class Helmet {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50)
  /** Callout anchors in model space: [lidar, pi, sensor]. */
  readonly anchors = [new THREE.Object3D(), new THREE.Object3D(), new THREE.Object3D()]
  private rig = new THREE.Group()
  private model = new THREE.Group()
  private slot: THREE.Mesh | null = null
  private disposables: { dispose(): void }[] = []
  private tmp = new THREE.Vector3()
  private tmp2 = new THREE.Vector3()

  constructor() {
    this.camera.position.set(0, 1.25, 4.4)
    this.camera.lookAt(0, -0.02, 0)
    this.scene.background = new THREE.Color(0x000000)
    const key = new THREE.DirectionalLight(0xffffff, 2.1)
    key.position.set(2.5, 4, 2.5)
    const rim = new THREE.DirectionalLight(0xffffff, 2.8)
    rim.position.set(-2, 2.2, -3)
    const fill = new THREE.HemisphereLight(0xffffff, 0x000000, 0.45)
    this.scene.add(key, rim, fill, this.rig)
    this.rig.add(this.model)
    this.rig.rotation.x = 0.08
    for (const a of this.anchors) this.model.add(a)
    this.buildProcedural()
    void this.tryLoadScan()
  }

  private track<D extends { dispose(): void }>(d: D) { this.disposables.push(d); return d }

  private buildProcedural() {
    const shell = this.track(new THREE.MeshStandardMaterial({ color: 0xd4d9e2, roughness: 0.92 }))
    const dark = this.track(new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.85 }))
    const black = this.track(new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.7, side: THREE.DoubleSide }))
    const add = (g: THREE.BufferGeometry, m: THREE.Material) => {
      const mesh = new THREE.Mesh(this.track(g), m)
      this.model.add(mesh)
      return mesh
    }
    const dome = add(new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), shell)
    dome.scale.set(1, 0.8, 1.15)
    const brim = add(new THREE.CylinderGeometry(1.16, 1.2, 0.06, 56), shell)
    brim.scale.set(1, 1, 1.25)
    brim.position.set(0, 0, 0.08)
    const ridge = add(new THREE.CapsuleGeometry(0.07, 1.3, 4, 12), shell)
    ridge.rotation.x = Math.PI / 2
    ridge.position.set(0, 0.76, 0)
    ridge.scale.set(1, 1, 0.55)
    const puck = add(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 32), dark)
    puck.position.set(0, 0.9, 0)
    this.slot = add(new THREE.CylinderGeometry(0.306, 0.306, 0.06, 32, 1, true, 0, Math.PI * 0.5), black)
    this.slot.position.copy(puck.position)
    const pi = add(new THREE.BoxGeometry(0.62, 0.16, 0.9), dark)
    pi.position.set(0, 0.36, -0.98)
    pi.rotation.x = -0.55
    const sensor = add(new THREE.BoxGeometry(0.16, 0.12, 0.22), dark)
    sensor.position.set(0.98, 0.3, 0.15)
    sensor.rotation.z = 0.35
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.46, -0.98), new THREE.Vector3(0, 0.88, -0.72), new THREE.Vector3(0, 0.98, -0.3)])
    add(new THREE.TubeGeometry(curve, 16, 0.022, 6), dark)
    this.anchors[0].position.set(0, 1.02, 0)
    this.anchors[1].position.set(0, 0.44, -1.02)
    this.anchors[2].position.set(1.04, 0.3, 0.15)
    this.fit()
  }

  /** Centre and scale whatever is in `model` so it fills the frame. */
  private fit() {
    const box = new THREE.Box3().setFromObject(this.model)
    if (box.isEmpty()) return
    const centre = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1
    const s = FIT_RADIUS / radius
    this.model.scale.setScalar(s)
    this.model.position.set(-centre.x * s, -centre.y * s, -centre.z * s)
  }

  private async tryLoadScan() {
    try {
      const head = await fetch(SCAN_URL, { method: 'HEAD' })
      const type = head.headers.get('content-type') ?? ''
      if (!head.ok || type.includes('text/html')) return
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
      const gltf = await new GLTFLoader().loadAsync(SCAN_URL)
      // swap the procedural helmet for the scan
      for (const d of this.disposables) d.dispose()
      this.disposables = []
      this.model.clear()
      this.slot = null
      const matte = this.track(new THREE.MeshStandardMaterial({ color: 0xd4d9e2, roughness: 0.9 }))
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) {
          this.track(mesh.geometry)
          mesh.material = matte
        }
      })
      this.model.add(gltf.scene)
      for (const a of this.anchors) this.model.add(a)
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const c = box.getCenter(new THREE.Vector3())
      this.anchors[0].position.set(c.x, box.max.y, c.z)
      this.anchors[1].position.set(c.x, (c.y + box.max.y) / 2, box.min.z)
      this.anchors[2].position.set(box.max.x, c.y, c.z)
      this.model.scale.setScalar(1)
      this.model.position.set(0, 0, 0)
      this.fit()
    } catch {
      // keep the procedural helmet
    }
  }

  update(angle: number, t: number) {
    this.rig.rotation.y = angle
    if (this.slot) this.slot.rotation.y = t * 3.2
  }

  /** NDC position of anchor i (x, y in -1..1). */
  project(i: number, out: THREE.Vector3) {
    this.anchors[i].getWorldPosition(out)
    return out.project(this.camera)
  }

  /** 1 when the anchor faces the camera, 0 when it is on the far side. */
  facing(i: number) {
    const w = this.anchors[i].getWorldPosition(this.tmp)
    const centre = this.rig.getWorldPosition(this.tmp2)
    const dir = w.sub(centre)
    dir.y = 0
    if (dir.lengthSq() < 1e-6) return 1
    dir.normalize()
    const toCam = this.camera.position.clone().sub(centre)
    toCam.y = 0
    toCam.normalize()
    return Math.min(1, Math.max(0, (dir.dot(toCam) - 0.1) / 0.5))
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
  }
}
