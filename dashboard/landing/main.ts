import './landing.css'
import * as THREE from 'three'
import { Helmet } from './helmet'
import { Hud } from './hud'
import { Mock } from './mock'
import { Post } from './post'
import { World } from './world'
import { createOdometer } from './odometer'
import { startTracking } from '../src/lib/track'
import { T, cellPx, clamp, isMobile, lerp, levelOf, reducedMotion, span, vocAt, win } from './util'

const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E

startTracking() // visitor → Discord (docs/visitor-tracking.md); keeps ?p / ?t below

// ?p=0.35 forces scroll progress (screenshots, debugging)
const params = new URLSearchParams(location.search)
const forcedRaw = params.get('p')
const forced = forcedRaw !== null && !Number.isNaN(parseFloat(forcedRaw)) ? clamp(parseFloat(forcedRaw)) : null
if (forced !== null) document.documentElement.classList.add('forced')
// ?t=4 seeds the animation clock (seconds), for deterministic screenshots
const forcedT = params.get('t') !== null && !Number.isNaN(parseFloat(params.get('t')!)) ? Math.max(0, parseFloat(params.get('t')!)) : null

// ---- renderer + scenes --------------------------------------------------------
const canvas = $<HTMLCanvasElement>('gl')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false })
renderer.toneMapping = THREE.NoToneMapping
const world = new World()
const helmet = new Helmet()
const hud = new Hud()
const rt = new THREE.WebGLRenderTarget(2, 2, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true })
const post = new Post(rt.texture, hud.texture)
const mock = new Mock($('laptop'))

// ---- dom --------------------------------------------------------------------
const el = {
  intro: $('intro'), product: $('product'), hud: $('hud'), hudVoc: $('hudVoc'), hudLevel: $('hudLevel'),
  hudTime: $('hudTime'), hudPos: $('hudPos'), warn: $('warn'), warnVoc: $('warnVoc'), warnLevel: $('warnLevel'), problemH: document.querySelector<HTMLElement>('.problem-h')!,
  problemS: document.querySelector<HTMLElement>('.problem-s')!, end: $('end'), laptop: $('laptop'), cta: $('cta'), foot: $('foot'),
  callouts: Array.from(document.querySelectorAll<HTMLElement>('.callout')),
  hints: Array.from(document.querySelectorAll<HTMLElement>('.hint')),
}
el.hints.forEach((h, i) => h.dataset.side = i % 2 === 0 ? 'l' : 'r')

const styleCache = new WeakMap<HTMLElement, string>()
function fx(e: HTMLElement, opacity: number, transform = '') {
  const key = `${opacity.toFixed(3)}|${transform}`
  if (styleCache.get(e) === key) return
  styleCache.set(e, key)
  e.style.opacity = opacity.toFixed(3)
  e.style.transform = transform
}
const textCache = new WeakMap<HTMLElement, string>()
function txt(e: HTMLElement, s: string) {
  if (textCache.get(e) === s) return
  textCache.set(e, s)
  e.textContent = s
}

// ---- layout -----------------------------------------------------------------
let W = 1, H = 1, dpr = 1, cell = 8, gw = 1, gh = 1, gutter = 20, mobile = false
let laptopRect = { x: 0, y: 0, w: 1, h: 1 }
let stacked = false
let ctaRect = new DOMRect()
let footRect = new DOMRect()
let calloutRects: DOMRect[] = []
/** Real size of the hat in the world (longest dimension ≈ 0.33 m) and the camera distance at
 *  which it has the same on-screen size as at the end of the spin. */
const HAT_SCALE = 0.165
let hatD0 = 0.4
let hatHero = 0.4
let hintRects: DOMRect[] = []
let problemRect = new DOMRect()
let warnRect = new DOMRect()
let introRect = new DOMRect()
let shownVoc = -1
const warnOdo = createOdometer(el.warnVoc, 4, !reducedMotion)
const shadeFrom = (v: THREE.Vector4, r: { left: number; bottom: number; width: number; height: number } | null, pad = 24) => {
  if (!r || r.width <= 0) { v.set(0, 0, 0, 0); return }
  v.set((r.left - pad) * dpr, (H - r.bottom - pad) * dpr, (r.width + 2 * pad) * dpr, (r.height + 2 * pad) * dpr)
}

function resize() {
  W = window.innerWidth; H = window.innerHeight; mobile = isMobile()
  dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1 : 1.5)
  cell = cellPx(); gw = Math.ceil(W / cell); gh = Math.ceil(H / cell)
  renderer.setPixelRatio(dpr)
  renderer.setSize(W, H, false)
  rt.setSize(gw * 2, gh * 2)
  hud.resize(gw, gh)
  world.camera.aspect = W / H
  world.camera.updateProjectionMatrix()
  world.setRtHeight(gh * 2)
  const aspect = W / H
  const k = 1 / Math.min(1, aspect / 1.15)
  helmet.camera.aspect = aspect
  helmet.camera.position.set(0, 1.25 * k, 5.1 * k)
  helmet.camera.lookAt(0, -0.02, 0)
  helmet.camera.updateProjectionMatrix()
  // the world camera is at 30° (the spin lens) at the handoff, so same distance ratio = same picture
  const spinDist = Math.hypot(1.25 * k, 5.1 * k)
  hatD0 = spinDist * HAT_SCALE
  hatHero = helmet.fitHeight / (2 * spinDist * Math.tan((helmet.camera.fov * Math.PI) / 360))
  post.uniforms.uRes.value.set(W * dpr, H * dpr)
  post.uniforms.uGrid.value.set(gw, gh)
  post.uniforms.uCell.value = cell * dpr
  gutter = clamp(0.06 * W, 20, 96)
  // ---- end scene: measured layout that works from 390 to 1920 wide
  stacked = W < 1100
  el.cta.classList.toggle('stacked', stacked)
  el.cta.style.transform = ''
  styleCache.delete(el.cta)
  ctaRect = el.cta.getBoundingClientRect()
  footRect = el.foot.getBoundingClientRect()
  const ratio = 0.625            // laptop screen aspect
  const baseExtra = 0.075        // base + table line below the screen, as a fraction of width
  let houseX: number, houseY: number, housePx: number
  if (stacked) {
    // text on top, a strip for the small house, laptop below at the width that still fits
    const zone = clamp(H * 0.2, 90, 170)
    const y = ctaRect.bottom + 20 + zone
    const maxH = H - y - 72
    const w = clamp(Math.min(W - 2 * gutter, maxH / (ratio + baseExtra)), 200, 760)
    laptopRect = { x: (W - w) / 2, y, w, h: w * ratio }
    houseX = W / 2
    houseY = ctaRect.bottom + 20 + zone / 2
    housePx = zone * 0.82
  } else {
    // text column left, laptop fills the space to its right, house small above the text
    const textRight = ctaRect.right + 48
    const availW = W - gutter - textRight
    const availH = H - 112
    const w = clamp(Math.min(availW, availH / (ratio + baseExtra), 820), 240, 820)
    laptopRect = { x: W - gutter - w, y: (H - w * ratio) / 2 + H * 0.02, w, h: w * ratio }
    const above = ctaRect.top - 40
    if (above > 150) {
      houseX = ctaRect.left + Math.min(ctaRect.width, 320) / 2
      houseY = above / 2 + 16
      housePx = clamp(above * 0.7, 90, 220)
    } else {
      // not enough room above the text: put it above the laptop instead
      houseX = laptopRect.x + laptopRect.w / 2
      houseY = laptopRect.y / 2
      housePx = clamp(laptopRect.y * 0.7, 70, 200)
    }
  }
  world.setEndFraming((houseX / W) * 2 - 1, 1 - (houseY / H) * 2, housePx, H)
  mock.layout(laptopRect.x, laptopRect.y, laptopRect.w, laptopRect.h, dpr)
  calloutRects = el.callouts.map((c) => c.getBoundingClientRect())
  hintRects = el.hints.map((h) => h.getBoundingClientRect())
  const ph = el.problemH.getBoundingClientRect(), ps = el.problemS.getBoundingClientRect()
  problemRect = new DOMRect(Math.min(ph.left, ps.left), ph.top, Math.max(ph.width, ps.width), ps.bottom - ph.top)
  warnRect = el.warn.children[1].getBoundingClientRect()
  const ti = el.intro.children[0].getBoundingClientRect(), tg = el.intro.children[1].getBoundingClientRect()
  introRect = new DOMRect(Math.min(ti.left, tg.left), ti.top, Math.max(ti.width, tg.width), tg.bottom - ti.top)
  world.setPortrait(W < H)
}

// ---- scroll -----------------------------------------------------------------
let target = forced ?? 0, cur = target, prevP = cur
function onScroll() {
  const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
  target = clamp(window.scrollY / max)
}
if (forced === null) {
  addEventListener('scroll', onScroll, { passive: true })
  onScroll()
}

// ---- frame ------------------------------------------------------------------
const ndc = new THREE.Vector3()
const hintStart: number[] = [NaN, NaN, NaN, NaN, NaN]

function render(p: number, t: number, dt: number) {
  const u = post.uniforms
  const helmetBeat = p >= T.helmet[0] && p < T.helmet[1]
  const exterior = p >= T.cut
  const lungsW = win(p, T.lungs[0], T.lungs[1], 0.03, 0.03)
  const inView = span(p, T.pov - 0.01, T.pov + 0.012) * (1 - span(p, T.lift[0], T.lift[0] + 0.01))
  const introA = 1 - span(p, T.intro[0], T.intro[1])

  // cell look
  // the hat resolves out of the night grain; the cooling scene resolves after the cut
  let block = 1
  if (helmetBeat) block = p < T.helmet[0] + 0.012 ? 3 : p < T.helmet[0] + 0.024 ? 2 : 1
  else if (exterior) block = p < T.cut + 0.018 ? 3 : p < T.cut + 0.036 ? 2 : 1
  u.uBlock.value = block
  let dim = 1
  if (helmetBeat) dim = span(p, T.helmet[0], T.helmet[0] + 0.018)
  else if (p < T.helmet[0]) dim = 1 - span(p, T.helmet[0] - 0.01, T.helmet[0])
  else if (!exterior) dim = 1 - 0.88 * lungsW
  u.uDim.value = dim
  u.uMono.value = helmetBeat ? 1 : 1 - span(p, 0.246, 0.262)
  const smokeIn = span(p, 0.37, T.lift[0]) * 0.5 + span(p, T.lift[0], T.cut) * 0.5
  u.uSmoke.value = exterior ? 1 - span(p, T.cut, T.cut + 0.06) : smokeIn * (1 - lungsW)
  u.uNoise.value = helmetBeat ? 0.03 : exterior ? 0.04 : 0.05 + 0.1 * span(p, 0.37, 0.78)
  u.uNoiseT.value = reducedMotion ? 1 : 12
  u.uHeat.value = reducedMotion ? 0 : span(p, T.door, 0.45) * 0.9 * (1 - lungsW) * (1 - span(p, 0.76, 0.8))
  const warnW = win(p, T.warn[0] - 0.004, T.warn[1] + 0.01, 0.004, 0.03)
  const pulse = reducedMotion ? 0.75 : 0.55 + 0.45 * Math.pow(Math.sin(t * 7), 2)
  u.uAlert.value = warnW * pulse
  u.uVig.value = exterior ? 0 : (helmetBeat ? 0.15 : 0.3) * (1 - span(p, T.lift[0], T.cut))
  u.uTime.value = t

  // shake grows with the fire; the warning kicks it
  if (prevP < T.warnImpulse !== p < T.warnImpulse) world.kick()
  const shakeAmp = reducedMotion ? 0 : (0.0015 * span(p, T.outside[0], T.door) + 0.008 * span(p, T.door, 0.5) * (1 - span(p, 0.77, 0.8))) * (1 - 0.7 * lungsW)

  // temperature pass
  renderer.setRenderTarget(rt)
  const angle = span(p, T.helmetSpin[0], T.helmetSpin[1]) * Math.PI * 2
  // the same helmet object: on its turntable during the spin, in the world while it lands
  const hatInWorld = p >= T.helmet[1] && p < T.pov + 0.002
  if (hatInWorld) {
    helmet.toWorld(world.scene)
    world.hat = { rig: helmet.rig, d0: hatD0, scale: HAT_SCALE, fitH: helmet.fitHeight, heroFrac: hatHero, setOpacity: (a) => helmet.setOpacity(a) }
  } else {
    helmet.toSpin()
    helmet.setOpacity(1)
    world.hat = null
    helmet.rig.visible = helmetBeat
  }
  if (helmetBeat) {
    helmet.update(angle, t)
    renderer.render(helmet.scene, helmet.camera)
  } else {
    world.update(p, t, dt, shakeAmp, exterior)
    renderer.render(world.scene, world.camera)
  }

  // cell-space hud
  hud.begin()
  const productA = helmetBeat ? span(p, T.helmet[0] + 0.01, T.helmet[0] + 0.03) * (1 - span(p, T.helmet[1] - 0.025, T.helmet[1] - 0.005)) : 0
  const calloutVis = [0, 0, 0]
  if (helmetBeat) {
    calloutVis[0] = span(angle, 0.25, 0.6) * (1 - span(angle, 1.8, 2.1))
    calloutVis[1] = helmet.facing(1)
    calloutVis[2] = helmet.facing(2)
    for (let i = 0; i < 3; i++) {
      const v = calloutVis[i] * productA
      if (v < 0.02 || !calloutRects[i]) continue
      helmet.project(i, ndc)
      if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z > 1) continue // anchor off-screen: no leader
      const sx = (ndc.x * 0.5 + 0.5) * W, sy = (1 - (ndc.y * 0.5 + 0.5)) * H
      const r = calloutRects[i]
      const fromX = i === 1 ? r.right + 10 : r.left - 10
      const fromY = r.top + r.height / 2
      hud.leader(fromX / cell, fromY / cell, sx / cell, sy / cell, v)
    }
  }
  const gutterCells = gutter / cell
  let shadeK = 0
  shadeFrom(u.uShade1.value, null)
  shadeFrom(u.uShade2.value, null)
  for (let i = 0; i < 5; i++) {
    const [a, b] = T.hints[i]
    const al = win(p, a, b, 0.012, 0.012)
    if (al <= 0.01) { hintStart[i] = NaN; continue }
    if (Number.isNaN(hintStart[i])) hintStart[i] = forcedT !== null ? 0 : t
    const s = mobile ? 0.8 : Math.min(1.25, gw / 150)
    const artRight = i % 2 === 0
    const bx = mobile ? gw - 2 - 34 * s : artRight ? gw - gutterCells - 34 * s : gutterCells
    const by = mobile ? 15 : gh / 2 - 11 * s
    hud.hint(i, bx, by, s, al, t - hintStart[i], reducedMotion)
    shadeK = al
    shadeFrom(u.uShade1.value, hintRects[i])
    shadeFrom(u.uShade2.value, { left: bx * cell, bottom: (by + 22 * s) * cell, width: 34 * s * cell, height: 22 * s * cell }, 16)
  }
  if (warnW > 0.01) { shadeK = warnW * 0.7; shadeFrom(u.uShade1.value, warnRect, 40) }
  if (lungsW > 0.01) { shadeK = Math.max(shadeK, lungsW); shadeFrom(u.uShade1.value, problemRect) }
  if (exterior) { shadeK = 1; shadeFrom(u.uShade1.value, ctaRect, 28); shadeFrom(u.uShade2.value, footRect, 16) }
  if (introA > 0.01 && !helmetBeat) { shadeK = 0.85 * introA; shadeFrom(u.uShade1.value, introRect, 28) }
  u.uShadeK.value = shadeK
  hud.warnRing(warnW, t, reducedMotion)
  const lungsA = win(p, T.lungs[0], T.lungs[1], 0.02, 0.02)
  if (lungsA > 0) {
    const q = (p - T.lungs[0]) / (T.lungs[1] - T.lungs[0])
    hud.lungs(mobile ? gw * 0.5 : gw * 0.6, mobile ? gh * 0.36 : gh * 0.47, mobile ? gh * 0.5 : gh * 0.72, q, lungsA, t, reducedMotion)
  }
  if (exterior) {
    const d = span(p, T.laptop[0], T.laptop[0] + 0.035)
    hud.laptop(laptopRect.x / cell, laptopRect.y / cell, laptopRect.w / cell, laptopRect.h / cell, d, 1)
  }
  hud.end()
  post.render(renderer)

  // ---- dom
  fx(el.intro, introA, `translateY(${(-(1 - introA) * 30).toFixed(1)}px)`)
  fx(el.product, productA)
  el.callouts.forEach((c, i) => fx(c, calloutVis[i] * productA, `translateY(${((1 - calloutVis[i]) * 8).toFixed(1)}px)`))
  const hudA = inView * (1 - 0.6 * lungsW)
  fx(el.hud, hudA)
  // the reading eases toward the scroll target (never jumps); the warning rolls it like an odometer
  shownVoc = shownVoc < 0 || reducedMotion ? vocAt(p) : shownVoc + (vocAt(p) - shownVoc) * (1 - Math.exp(-dt * 2.5))
  const noise = reducedMotion ? 0 : Math.round(2 * Math.sin(Math.floor(t * 4) * 2.3)) // HUD only: a live sensor
  const live = Math.max(0, Math.round(shownVoc) + noise)
  if (warnW > 0.01) {
    const [wname, wcolor] = levelOf(Math.round(shownVoc))
    warnOdo(shownVoc, dt)
    txt(el.warnLevel, wname)
    el.warnLevel.style.setProperty('color', wcolor)
  }
  if (hudA > 0) {
    const v = live
    const [name, color] = levelOf(v)
    txt(el.hudVoc, String(v))
    txt(el.hudLevel, name)
    el.hudLevel.style.setProperty('--level', color)
    const secs = Math.max(0, Math.round(((p - T.outside[0]) / (T.lift[0] - T.outside[0])) * 420))
    txt(el.hudTime, `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`)
    const walked = clamp((p - T.door) / (T.lift[0] - T.door)) * 15
    txt(el.hudPos, `${walked.toFixed(1)} m`)
  }
  fx(el.warn, warnW, `scale(${(1 + 0.04 * (1 - span(p, T.warn[0], T.warn[0] + 0.01))).toFixed(3)})`)
  const ph = win(p, T.lungs[0] + 0.03, T.lungs[1] - 0.004, 0.02, 0.015)
  const ps = win(p, T.lungs[0] + 0.042, T.lungs[1] - 0.004, 0.02, 0.015)
  fx(el.problemH, ph, `translateY(${((1 - ph) * 10).toFixed(1)}px)`)
  fx(el.problemS, ps, `translateY(${((1 - ps) * 10).toFixed(1)}px)`)
  el.hints.forEach((h, i) => {
    const [a, b] = T.hints[i]
    const al = win(p, a, b, 0.012, 0.012)
    const dir = i % 2 === 0 ? -1 : 1
    const tx = dir * ((1 - span(p, a, a + 0.012)) * 24 + span(p, b - 0.012, b) * 12)
    fx(h, al, `translate(${tx.toFixed(1)}px, ${mobile ? '0' : '-50%'})`)
  })
  el.end.style.visibility = exterior ? 'visible' : 'hidden'
  fx(el.end, exterior ? 1 : 0)
  const la = span(p, T.laptop[0] + 0.03, T.laptop[1])
  fx(el.laptop, la, `scale(${lerp(0.985, 1, la).toFixed(4)})`)
  const ca = span(p, T.cta[0], T.cta[1])
  const rise = ((1 - ca) * 24).toFixed(1)
  fx(el.cta, ca, stacked ? `translateY(${rise}px)` : `translateY(calc(-50% + ${rise}px))`)
  fx(el.foot, ca)
  if (la > 0) mock.update(t, reducedMotion)
  prevP = p
}

// ---- loop -------------------------------------------------------------------
let last = performance.now(), time = forcedT ?? 0, running = false, raf = 0
function frame() {
  if (!running) return
  const now = performance.now()
  const dt = clamp((now - last) / 1000, 0, 0.05)
  last = now
  time += dt
  if (forced !== null) cur = forced
  else {
    cur += (target - cur) * (1 - Math.exp(-dt * 6))
    if (Math.abs(target - cur) < 1e-5) cur = target
  }
  render(cur, time, dt)
  if (forced !== null) document.documentElement.dataset.t = time.toFixed(2)
  raf = requestAnimationFrame(frame)
}
function start() {
  if (running) return
  running = true
  last = performance.now()
  raf = requestAnimationFrame(frame)
}
function stop() {
  running = false
  cancelAnimationFrame(raf)
}
document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()))
addEventListener('resize', resize)
addEventListener('pagehide', () => {
  world.dispose(); helmet.dispose(); post.dispose(); rt.dispose(); hud.texture.dispose(); renderer.dispose()
})
resize()
start()
document.fonts?.ready.then(resize)
