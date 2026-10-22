// Estimates how likely a page visit came from a real person, as a 0–100 score.
//
// How it works: start at 50 ("no idea"), then add points for evidence of a
// human (mouse moved, scrolled, touched…) and subtract points for evidence of
// automation (webdriver flag, headless browser, missing headers…). Every
// adjustment is kept as a short reason so the Discord message shows WHY a
// visit got its score, which makes the weights easy to tune by eye.
//
// Why points instead of a "real" probability model? There's no labelled data
// to train one on, and hand-picked points stay readable and tweakable.
//
// The browser half (startHumanSignals) only COLLECTS raw signals. The scoring
// runs in the Cloudflare Worker's /api/track (worker/index.ts), so all the weights
// live in one place and the request headers (which only the server can see) feed
// the same score. Ported from hi-sg (lib/human-score.ts).

// ─── Types ──────────────────────────────────────────────────────────────────

// Raw facts the browser reports. Nothing here is a judgement; that's scoreVisit's job.
export type HumanSignals = {
  // Fingerprint: read once, available instantly
  userAgent: string
  webdriver: boolean // true when Selenium / Puppeteer / Playwright drive the browser
  languagesCount: number
  screenWidth: number
  screenHeight: number
  outerWidth: number // 0 in many headless browsers (no real window around the page)
  outerHeight: number
  pluginsCount: number
  isMobile: boolean
  timeZone: string // e.g. "America/Toronto", compared with the IP's timezone on the server
  // Behaviour: counted while the visitor is on the page
  pointerMoves: number
  touches: number
  scrolls: number
  keyPresses: number
  wasVisible: boolean // was the tab ever on screen?
  interactedEarlier: boolean // showed human input on an earlier page this tab session
  msObserved: number // how long we watched before sending
}

export type HumanScore = {
  score: number // 0–100
  label: string // "likely human" / "unsure" / "likely bot"
  reasons: string[] // e.g. ["+25 mouse moved", "-15 no browser languages"]
}

// Minimal shape of request headers, so this file works with the standard Headers
// class (the Worker's request.headers) or a plain test stub.
type HeaderReader = { get(name: string): string | null }

const BASELINE = 50
const QUIET_PENALTY_AFTER_MS = 5_000 // only call "no interaction" suspicious after watching this long
const HUMAN_SEEN_KEY = "human_seen" // sessionStorage flag: this tab already showed human input

// ─── Browser: collect signals ───────────────────────────────────────────────

// Starts counting real input events. Call once when the page mounts; call
// snapshot() when you're ready to send, and stop() on cleanup.
export function startHumanSignals() {
  const startedAt = Date.now()
  const counts = { pointerMoves: 0, touches: 0, scrolls: 0, keyPresses: 0 }
  let wasVisible = document.visibilityState === "visible"

  // sessionStorage can throw (private mode, blocked storage), so guard it.
  let interactedEarlier = false
  try {
    interactedEarlier = sessionStorage.getItem(HUMAN_SEEN_KEY) === "1"
  } catch {}

  const rememberHuman = () => {
    try {
      sessionStorage.setItem(HUMAN_SEEN_KEY, "1")
    } catch {}
  }

  // Only count events with isTrusted === true: the browser sets that for real
  // input and sets it false for events a script fakes with dispatchEvent().
  // (Tools like Puppeteer that drive the browser over DevTools CAN produce
  // trusted events, which is why behaviour is only part of the score.)
  // 📖 Learn: Event.isTrusted — https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted
  const onMouseMove = (e: MouseEvent) => {
    if (!e.isTrusted) return
    counts.pointerMoves++
    if (counts.pointerMoves >= 5) rememberHuman() // a single stray event isn't enough
  }
  const onTouchStart = (e: TouchEvent) => {
    if (!e.isTrusted) return
    counts.touches++
    rememberHuman()
  }
  // "wheel" (trackpad/mouse wheel) and "touchmove" (finger drag) instead of
  // "scroll": the browser fires "scroll" for ANY scroll, including ones a
  // script or scroll-restoration triggers, so it says nothing about a person.
  const onScrollIntent = (e: Event) => {
    if (!e.isTrusted) return
    counts.scrolls++
    rememberHuman()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.isTrusted) return
    counts.keyPresses++
    rememberHuman()
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") wasVisible = true
  }

  // passive: true promises we never call preventDefault(), so the browser can
  // keep scrolling smooth instead of waiting on our handler.
  // 📖 Learn: passive event listeners — https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener#passive
  const passive = { passive: true }
  window.addEventListener("mousemove", onMouseMove, passive)
  window.addEventListener("touchstart", onTouchStart, passive)
  window.addEventListener("wheel", onScrollIntent, passive)
  window.addEventListener("touchmove", onScrollIntent, passive)
  window.addEventListener("keydown", onKeyDown)
  document.addEventListener("visibilitychange", onVisibilityChange)

  const snapshot = (): HumanSignals => ({
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver === true,
    languagesCount: navigator.languages?.length ?? 0,
    screenWidth: window.screen?.width ?? 0,
    screenHeight: window.screen?.height ?? 0,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    pluginsCount: navigator.plugins?.length ?? 0,
    isMobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
    ...counts,
    wasVisible,
    interactedEarlier,
    msObserved: Date.now() - startedAt,
  })

  const stop = () => {
    window.removeEventListener("mousemove", onMouseMove)
    window.removeEventListener("touchstart", onTouchStart)
    window.removeEventListener("wheel", onScrollIntent)
    window.removeEventListener("touchmove", onScrollIntent)
    window.removeEventListener("keydown", onKeyDown)
    document.removeEventListener("visibilitychange", onVisibilityChange)
  }

  return { snapshot, stop }
}

// ─── Scoring (pure functions, safe to run anywhere) ─────────────────────────

// A running tally: each add() changes the points and records why.
function makeTally() {
  let points = 0
  const reasons: string[] = []
  const add = (delta: number, why: string) => {
    points += delta
    reasons.push(`${delta > 0 ? "+" : ""}${delta} ${why}`)
  }
  return { add, getPoints: () => points, reasons }
}

// Points from what the browser reported (fingerprint + behaviour).
export function scoreClientSignals(s: Partial<HumanSignals>) {
  const { add, getPoints, reasons } = makeTally()
  const ua = s.userAgent ?? ""

  // Fingerprint: traces that automation tools leave behind
  if (/bot|crawler|spider/i.test(ua)) add(-60, "bot user-agent")
  if (/HeadlessChrome|PhantomJS|Lighthouse/i.test(ua)) add(-50, "headless browser user-agent")
  if (s.webdriver) add(-50, "webdriver flag (automated browser)")
  if (s.languagesCount === 0) add(-15, "no browser languages")
  if (s.screenWidth === 0 || s.screenHeight === 0) add(-20, "0px screen")
  if (s.outerWidth === 0 && s.outerHeight === 0) add(-15, "no window frame")
  // Desktop Chrome/Edge/Firefox/Safari all report built-in PDF viewer plugins now.
  if (!s.isMobile && s.pluginsCount === 0) add(-10, "no plugins on desktop")

  // Behaviour: real people almost always move, scroll, or touch something
  const moves = s.pointerMoves ?? 0
  if (moves >= 5) add(25, "mouse moved")
  else if (moves > 0) add(10, "slight mouse movement")
  if ((s.touches ?? 0) > 0) add(25, "touched screen")
  if ((s.scrolls ?? 0) > 0) add(15, "scrolled")
  if ((s.keyPresses ?? 0) > 0) add(10, "pressed keys")
  if (s.interactedEarlier) add(20, "interacted on an earlier page")

  const didAnything = moves > 0 || (s.touches ?? 0) > 0 || (s.scrolls ?? 0) > 0 || (s.keyPresses ?? 0) > 0
  // Small penalty only: someone reading a page without touching anything is
  // still possible, so silence alone shouldn't brand a visit as a bot.
  if (!didAnything && !s.interactedEarlier && (s.msObserved ?? 0) >= QUIET_PENALTY_AFTER_MS) {
    add(-10, `no input in ${Math.round((s.msObserved ?? 0) / 1000)}s`)
  }
  // A tab opened in the background (Cmd+click) is also never visible at first,
  // so this is a mild hint, not proof.
  if (s.wasVisible === false) add(-10, "tab never visible")

  return { points: getPoints(), reasons }
}

// Points from the HTTP headers of the /api/track request. Real browsers send
// these automatically; simple scripts that POST straight to /api/track, and
// some headless setups, leave them out.
// ipTimeZone: where the visitor's IP is, from Cloudflare's request.cf.timezone.
export function scoreRequestHeaders(headers: HeaderReader, clientTimeZone?: string, ipTimeZone?: string | null) {
  const { add, getPoints, reasons } = makeTally()
  const ua = headers.get("user-agent") ?? ""
  const secChUa = headers.get("sec-ch-ua")

  if (!headers.get("accept-language")) add(-20, "no Accept-Language header")

  // sec-ch-ua is a "Client Hint" every Chromium browser (Chrome, Edge, Brave…)
  // sends over HTTPS. Firefox and Safari don't, so only expect it when the
  // user-agent claims to be Chrome.
  // 📖 Learn: User-Agent Client Hints — https://developer.mozilla.org/en-US/docs/Web/HTTP/Client_hints#user-agent_client_hints
  if (/HeadlessChrome/i.test(secChUa ?? "")) add(-50, "headless Chrome in sec-ch-ua")
  else if (/Chrome\/\d/.test(ua) && !secChUa) add(-15, "claims Chrome but no sec-ch-ua")

  // Sec-Fetch-* headers are added by all current browsers on every request.
  // 📖 Learn: Fetch metadata headers — https://developer.mozilla.org/en-US/docs/Glossary/Fetch_metadata_request_header
  if (!headers.get("sec-fetch-site")) add(-10, "no Sec-Fetch headers")

  // Compare the browser's clock timezone with where its IP says it is. Bots in
  // data centres often run on UTC while their IP geolocates elsewhere. We
  // compare UTC OFFSETS, not names, because "America/Toronto" and
  // "America/New_York" are different names for the same clock. VPN users
  // trigger this too, so the penalty is small.
  if (clientTimeZone && ipTimeZone) {
    const clientOffset = utcOffsetMinutes(clientTimeZone)
    const ipOffset = utcOffsetMinutes(ipTimeZone)
    if (clientOffset !== null && ipOffset !== null && clientOffset !== ipOffset) {
      add(-10, `browser timezone ${clientTimeZone} ≠ IP timezone ${ipTimeZone}`)
    }
  }

  return { points: getPoints(), reasons }
}

// The final number: baseline + browser points + header points, kept within 0–100.
export function scoreVisit(signals: Partial<HumanSignals>, headers: HeaderReader, ipTimeZone?: string | null): HumanScore {
  const client = scoreClientSignals(signals)
  const server = scoreRequestHeaders(headers, signals.timeZone, ipTimeZone)
  const raw = BASELINE + client.points + server.points
  const score = Math.max(0, Math.min(100, raw))
  return {
    score,
    label: score >= 70 ? "likely human" : score >= 40 ? "unsure" : "likely bot",
    reasons: [`${BASELINE} baseline`, ...client.reasons, ...server.reasons],
  }
}

// Minutes ahead of (+) or behind (-) UTC for a timezone name, right now.
// Returns null for an unknown name. Uses Intl's "longOffset" format, which
// prints e.g. "GMT-04:00" (or just "GMT" for UTC itself).
// 📖 Learn: Intl.DateTimeFormat timeZoneName — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat#timezonename
export function utcOffsetMinutes(timeZone: string, at: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at)
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? ""
    if (name === "GMT") return 0
    const match = name.match(/^GMT([+-])(\d{2}):(\d{2})$/)
    if (!match) return null
    const minutes = Number(match[2]) * 60 + Number(match[3])
    return match[1] === "-" ? -minutes : minutes
  } catch {
    return null // Intl throws a RangeError for an invalid timezone name
  }
}
