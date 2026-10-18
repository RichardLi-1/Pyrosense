// GLSL for the landing page. Everything is cheap: value noise, a few octaves at most.

export const NOISE = /* glsl */ `
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
`

/** Shared vertex shader for world quads: passes uv and view depth (for fog). */
export const QUAD_V = /* glsl */ `
varying vec2 vUv; varying float vDepth;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`

/** Flame: value-noise fire shaped by a vertical gradient. Outputs "temperature" (grayscale), additive. */
export const FIRE_F = /* glsl */ `
uniform float uTime, uIntensity, uSeed, uFogD, uStretch;
varying vec2 vUv; varying float vDepth;
${NOISE}
void main() {
  vec2 uv = vUv;
  float t = uTime * 0.8 + uSeed * 10.0;
  vec2 q = vec2(uv.x * uStretch + uSeed * 3.0, uv.y * 1.6 - t);
  float n = fbm(q * 2.6);
  float n2 = fbm(q * 5.0 + n * 1.2 - vec2(0.0, t * 0.5));
  float edge = 1.0 - pow(abs(uv.x * 2.0 - 1.0), 2.0);
  float f = (1.0 - uv.y) * edge * 1.7 - uv.y * 0.6 + (n * 0.7 + n2 * 0.5) * 0.95 - 0.42;
  f = clamp(f * uIntensity, 0.0, 1.0);
  float v = smoothstep(0.0, 0.5, f) * 0.7 + smoothstep(0.45, 1.0, f) * 0.6;
  float fog = exp(-uFogD * uFogD * vDepth * vDepth);
  gl_FragColor = vec4(vec3(v * fog), 1.0);
}
`

/** Rising embers / sparks as hot points. */
export const EMBER_V = /* glsl */ `
attribute vec3 aRand;
uniform float uTime, uScale, uHeight;
varying float vA;
void main() {
  float life = fract(aRand.x + uTime * (0.04 + aRand.y * 0.06));
  vec3 p = position;
  p.y += life * uHeight;
  p.x += sin(uTime * 1.1 + aRand.z * 40.0) * 0.4 * life;
  p.z += cos(uTime * 0.8 + aRand.x * 30.0) * 0.4 * life;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vA = (1.0 - life) * smoothstep(0.0, 0.08, life);
  gl_PointSize = clamp((1.5 + aRand.y * 2.0) * uScale / -mv.z, 1.0, 5.0);
  gl_Position = projectionMatrix * mv;
}
`
export const EMBER_F = /* glsl */ `
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.3, d) * vA;
  gl_FragColor = vec4(vec3(a), 1.0);
}
`

/** Soft smoke billboard: warm-ish grey haze in the thermal image. */
export const SMOKE_F = /* glsl */ `
uniform float uTime, uSeed, uAlpha, uFogD;
varying vec2 vUv; varying float vDepth;
${NOISE}
void main() {
  vec2 uv = vUv - 0.5;
  float m = smoothstep(1.0, 0.25, length(uv) * 2.0);
  float n = fbm(vUv * 3.0 + vec2(uSeed, -uTime * 0.08));
  float a = m * smoothstep(0.35, 0.75, n) * uAlpha * exp(-uFogD * uFogD * vDepth * vDepth);
  gl_FragColor = vec4(vec3(0.42), a);
}
`

/** The cell pass: turns the low-res temperature image into a grid of dots. */
export const POST_V = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`
export const POST_F = /* glsl */ `
precision highp float;
uniform sampler2D tScene, tHud;
uniform vec2 uRes, uGrid;
uniform float uCell, uTime, uBlock, uSmoke, uNoise, uNoiseT, uHeat, uAlert, uVig, uDim, uMono;
uniform vec4 uShade1, uShade2;
uniform float uShadeK;
uniform vec3 uBg;
varying vec2 vUv;
${NOISE}
float shade(vec4 r, vec2 px) {
  if (r.z <= 0.0) return 0.0;
  vec2 d = max(r.xy - px, px - (r.xy + r.zw));
  return 1.0 - smoothstep(-12.0, 48.0, max(d.x, d.y));
}
vec3 palette(float t) {
  vec3 grey = vec3(0.933, 0.945, 0.965);
  vec3 c = grey * smoothstep(0.0, 0.55, t) * 0.78;
  vec3 hot = mix(c, vec3(1.0, 0.549, 0.259), smoothstep(0.5, 0.72, t));
  hot = mix(hot, vec3(1.0, 0.82, 0.4), smoothstep(0.72, 0.9, t));
  hot = mix(hot, vec3(1.0, 0.97, 0.9), smoothstep(0.9, 1.0, t));
  vec3 mono = grey * smoothstep(0.0, 0.9, t);
  return mix(hot, mono, uMono);
}
void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 cellF = px / uCell;
  vec2 cellId = floor(cellF);
  vec2 local = fract(cellF) - 0.5;
  vec2 sampleId = floor(cellId / uBlock) * uBlock + (uBlock - 1.0) * 0.5;
  vec2 suv = (sampleId + 0.5) / uGrid;
  // heat shimmer: whole cells swap with neighbours
  float sh = noise(vec2(cellId.x * 0.35, cellId.y * 0.35 - uTime * 2.0));
  suv.y += (sh - 0.5) * uHeat * 3.0 / uGrid.y;
  suv.x += (noise(vec2(cellId.y * 0.3 + 7.0, uTime * 1.7)) - 0.5) * uHeat * 2.0 / uGrid.x;
  vec3 sc = texture2D(tScene, suv).rgb;
  float lum = dot(sc, vec3(0.3, 0.59, 0.11));
  float temp = pow(clamp(lum * 1.1, 0.0, 1.0), 0.65);
  // sensor grain
  float n = hash(cellId + floor(uTime * uNoiseT) * vec2(13.0, 7.0));
  temp += (n - 0.5) * uNoise;
  // smoke: contrast collapses to a grainy warm grey
  float sm = 0.4 + (hash(cellId * 1.7 + floor(uTime * uNoiseT * 0.7)) - 0.5) * 0.3;
  temp = mix(temp, sm, uSmoke);
  temp *= 1.0 - 0.82 * uShadeK * max(shade(uShade1, px), shade(uShade2, px));
  temp *= uDim;
  vec2 nd = (px / uRes - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  temp *= 1.0 - uVig * smoothstep(0.5, 1.05, length(nd));

  vec4 h = texture2D(tHud, (cellId + 0.5) / uGrid);
  float aa = 0.9 / uCell;
  vec3 col = palette(temp);
  float r = mix(0.1, 0.46, smoothstep(0.03, 0.75, temp));
  float sq = smoothstep(0.7, 1.0, temp) * (1.0 - uMono);
  float dd = mix(length(local), max(abs(local.x), abs(local.y)), sq);
  float a = (1.0 - smoothstep(r - aa, r + aa, dd)) * step(0.045, temp);
  // hud cells (lungs, glyphs, leaders)
  float rh = mix(0.2, 0.46, h.a);
  float ah = (1.0 - smoothstep(rh - aa, rh + aa, length(local))) * step(0.03, h.a);
  col = mix(col, h.rgb, ah);
  a = max(a, ah * min(1.0, h.a * 1.6));
  // alert: the edge of the view turns red
  float edge = smoothstep(0.45, 1.0, length(nd));
  float ar = (1.0 - smoothstep(0.3 - aa, 0.3 + aa, length(local))) * edge * uAlert;
  col = mix(col, vec3(0.937, 0.137, 0.235), ar);
  a = max(a, ar);
  gl_FragColor = vec4(mix(uBg, col, clamp(a, 0.0, 1.0)), 1.0);
}
`
