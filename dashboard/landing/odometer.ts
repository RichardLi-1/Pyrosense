// Slot-machine / odometer number: each digit is a vertical strip that rolls, and a
// vertical-only motion blur (SVG filter) scales with how fast that digit is spinning.
// The ones digit rolls continuously; higher digits only roll while the one below wraps 9 → 0.

const SVG = 'http://www.w3.org/2000/svg'
let uid = 0

export function createOdometer(host: HTMLElement, digits = 3, blur = true) {
  host.textContent = ''
  host.classList.add('odo')
  const sr = document.createElement('span')
  sr.className = 'sr-only'

  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true')
  svg.style.position = 'absolute'

  const cols = Array.from({ length: digits }, () => {
    const col = document.createElement('span')
    col.className = 'odo-col'
    col.setAttribute('aria-hidden', 'true')
    const strip = document.createElement('span')
    strip.className = 'odo-strip'
    for (const d of '01234567890') {
      const s = document.createElement('span')
      s.textContent = d
      strip.appendChild(s)
    }
    col.appendChild(strip)
    host.appendChild(col)

    const id = `odo-blur-${uid++}`
    const filter = document.createElementNS(SVG, 'filter')
    filter.setAttribute('id', id)
    filter.setAttribute('x', '-10%'); filter.setAttribute('width', '120%')
    filter.setAttribute('y', '-50%'); filter.setAttribute('height', '200%')
    const g = document.createElementNS(SVG, 'feGaussianBlur')
    g.setAttribute('stdDeviation', '0 0')
    filter.appendChild(g)
    svg.appendChild(filter)
    return { col, strip, g, id, pos: -1, blur: -1 }
  })
  host.appendChild(svg)
  host.appendChild(sr)

  let prev: number | null = null
  let shownText = ''

  /** v: the (fractional) value to show; dt: seconds since last call. */
  return function set(v: number, dt: number) {
    v = Math.max(0, v)
    const rate = prev == null || dt <= 0 ? 0 : Math.abs(v - prev) / dt // units per second
    prev = v
    const em = parseFloat(getComputedStyle(host).fontSize) || 100
    const lead = Math.max(1, String(Math.floor(v)).length) // hide leading zeros
    cols.forEach((c, k) => {
      const i = digits - 1 - k // place: 0 = ones
      const p10 = 10 ** i
      const base = Math.floor(v / p10) % 10
      const below = v % p10
      const frac = i === 0 ? v % 1 : Math.max(0, below - (p10 - 1)) // roll only while the lower digits wrap
      const pos = base + frac
      if (Math.abs(pos - c.pos) > 1e-3) {
        c.strip.style.transform = `translateY(${((-pos * 100) / 11).toFixed(3)}%)`
        c.pos = pos
      }
      c.col.style.display = i < lead ? '' : 'none'
      // vertical blur grows with this digit's spin speed (digits per second), capped
      const spin = rate / p10
      const b = blur ? Math.min(0.06, spin * 0.004) * em : 0
      if (Math.abs(b - c.blur) > 0.15) {
        c.g.setAttribute('stdDeviation', `0 ${b.toFixed(2)}`)
        c.strip.style.filter = b > 0.2 ? `url(#${c.id})` : ''
        c.blur = b
      }
    })
    const text = String(Math.round(v))
    if (text !== shownText) { sr.textContent = text; shownText = text }
  }
}
