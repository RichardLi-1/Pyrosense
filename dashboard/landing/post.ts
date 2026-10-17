// Full-screen cell pass: samples the tiny temperature render and the HUD canvas per cell.
import * as THREE from 'three'
import { POST_F, POST_V } from './shaders'

export class Post {
  readonly uniforms = {
    tScene: { value: null as THREE.Texture | null },
    tHud: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uGrid: { value: new THREE.Vector2(1, 1) },
    uCell: { value: 8 },
    uTime: { value: 0 },
    uBlock: { value: 1 },
    uSmoke: { value: 0 },
    uNoise: { value: 0.05 },
    uNoiseT: { value: 12 },
    uHeat: { value: 0 },
    uAlert: { value: 0 },
    uVig: { value: 0 },
    uDim: { value: 1 },
    uMono: { value: 0 },
    uLensOn: { value: 0 },
    uLens: { value: new THREE.Vector4(0, 0, 1, 0) },
    uShade1: { value: new THREE.Vector4(0, 0, 0, 0) },
    uShade2: { value: new THREE.Vector4(0, 0, 0, 0) },
    uShadeK: { value: 0 },
    uLensGap: { value: 0.5 },
    uBg: { value: new THREE.Color(0x07090d) },
  }
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private material: THREE.ShaderMaterial
  private geometry = new THREE.PlaneGeometry(2, 2)

  constructor(sceneTex: THREE.Texture, hudTex: THREE.Texture) {
    this.uniforms.tScene.value = sceneTex
    this.uniforms.tHud.value = hudTex
    this.material = new THREE.ShaderMaterial({
      vertexShader: POST_V, fragmentShader: POST_F, uniforms: this.uniforms, depthTest: false, depthWrite: false,
    })
    this.material.toneMapped = false
    this.scene.add(new THREE.Mesh(this.geometry, this.material))
  }

  render(renderer: THREE.WebGLRenderer) {
    renderer.setRenderTarget(null)
    renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.material.dispose()
    this.geometry.dispose()
  }
}
