// Visitor tracking → Discord, ported from hi-sg (hooks/use-page-view-tracker.ts,
// hooks/use-preserve-m.ts, lib/track.ts, lib/outbound-links.ts). Plain functions rather
// than React hooks, because three different pages use it: the dashboard (React), the
// landing page and the tech-stack page (plain TS). See docs/visitor-tracking.md.
//
// The browser only ever POSTs to /api/track on our own origin; the Cloudflare Worker
// (worker/index.ts) adds geo + the human score and forwards to the Discord webhook,
// whose URL never reaches the browser.
import { aiAssistantFromHost } from './ai-assistants'
import { startHumanSignals } from './human-score'
import { REFERRAL_SOURCES, UTM_SOURCES } from './referral-sources'

const SKIP_KEY = 'skip_tracking' // localStorage: ?m was seen on this device
const REFERRAL_KEY = 'referral_source' // localStorage: where this visitor first came from
const LANDING_SOURCE_KEY = 'landing_source' // sessionStorage: how this tab's visit arrived (for outbound links)
const NAV_KEY = 'nav_path' // sessionStorage: pages this tab has seen, in order
const BOUNCE_THRESHOLD_MS = 10_000 // under 10 s on a single page = a quick bounce
const VISIT_DELAY_MS = 5_000 // give the human score a few seconds of input before sending
const INTERNAL_NAV_KEY = 'internal_nav' // sessionStorage: the visitor clicked through to another of our pages

// Params the pages themselves read (App.tsx, demo.ts, MapStage.tsx, useDashboard.ts,
// landing/main.ts). They survive the URL clean-up, but only with a value: landing's
// ?t=4 is a clock setting, while a bare ?t is the Twitter/X referral key.
const FUNCTIONAL_PARAMS = new Set(['source', 'design', 'view', 'crew', 'speed', 'review', 'debug', 'p', 't'])

const store = {
  get: (s: Storage, k: string) => { try { return s.getItem(k) } catch { return null } },
  set: (s: Storage, k: string, v: string) => { try { s.setItem(k, v) } catch { /* storage blocked */ } },
}

/** Tracking is off on localhost and on devices that opened any URL with ?m. (Crawlers still
 *  get one "Bot/crawler" visit message, like hi-sg, but never a bounce.) */
function trackingOff(): boolean {
  const host = location.hostname
  return host === 'localhost' || host === '127.0.0.1' || !!store.get(localStorage, SKIP_KEY)
}

/** Visitors who came from a referral (Resume, LinkedIn, an AI assistant, …) go to the referral
 *  channel (DISCORD_REFERRAL_WEBHOOK_URL), for every visit, bounce and click, so one person's
 *  journey stays in one place. Everyone else goes to the main channel. */
const channelOf = (referral: string | null) => (referral ? 'referral' : undefined)

/** Fire-and-forget named event (button clicks etc.). Never throws, never blocks. */
export function trackEvent(event: string, meta?: Record<string, string>) {
  if (trackingOff()) return
  const channel = channelOf(store.get(localStorage, REFERRAL_KEY))
  fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, meta, channel }) })
    .catch(() => { /* tracking must never break the page */ })
}

function beacon(body: unknown) {
  // sendBeacon survives the page unloading; a normal fetch would be cancelled
  navigator.sendBeacon('/api/track', new Blob([JSON.stringify(body)], { type: 'application/json' }))
}

const pathOf = () => location.pathname.replace(/\.html$/, '') || '/'

/** Where this visit came from: ?l / ?r / … first, then a known utm_source. */
function referralFromParams(params: URLSearchParams): string | null {
  for (const key of params.keys()) if (REFERRAL_SOURCES[key]) return REFERRAL_SOURCES[key]
  const utm = params.get('utm_source')
  return utm ? UTM_SOURCES[utm.toLowerCase()] ?? null : null
}

let started = false

/**
 * Call once per page load, as early as possible (before anything else reads or rewrites
 * the URL is fine: the functional params survive). Records where the visit came from,
 * strips tracking params from the URL, sends one visit message (and a bounce message if
 * the visitor leaves within 10 s), tags links to Richard's other sites, and turns any
 * element with data-track="label" into a tracked click.
 */
export function startTracking() {
  if (started) return
  started = true
  // Read the URL now, synchronously, before it is cleaned below.
  const landingParams = new URLSearchParams(location.search)
  const rawParams = landingParams.toString()
  recordLandingSource(landingParams)
  if (landingParams.has('m')) store.set(localStorage, SKIP_KEY, '1') // ?m = "don't track me", remembered
  cleanUrl(landingParams)
  tagOutboundLinks()
  trackClicks()
  if (trackingOff()) return

  // Holding "/" while the page loads suppresses tracking (testing on the real site).
  let slashHeld = false
  const onKey = (e: KeyboardEvent) => { if (e.key === '/') slashHeld = e.type === 'keydown' }
  addEventListener('keydown', onKey)
  addEventListener('keyup', onKey)

  // ─── AI-assistant detection (fresh landing only) ───────────────────────────
  // The first page this tab tracks. document.referrer would otherwise make every later
  // page look like a new ChatGPT arrival.
  const fresh = !store.get(sessionStorage, NAV_KEY)
  const referrerUrl = fresh ? document.referrer : ''
  let referrerHost: string | null = null
  try { referrerHost = referrerUrl ? new URL(referrerUrl).hostname : null } catch { referrerHost = null }
  if (referrerHost === location.hostname) referrerHost = null // our own pages linking to each other
  const aiAssistant = fresh ? aiAssistantFromHost(landingParams.get('utm_source')) ?? aiAssistantFromHost(referrerHost) : null
  const aiMeta: Record<string, string> = {
    ...(referrerUrl && referrerHost ? { '↩️ Referrer': referrerUrl } : {}),
    ...(aiAssistant ? { '🤖 AI assistant': aiAssistantFromHost(referrerHost) ? `${aiAssistant} (web, referrer sent)` : `${aiAssistant} (no referrer, often the mobile app)` } : {}),
  }

  const humanSignals = startHumanSignals()
  const enteredAt = Date.now()
  const isBot = /bot|crawler|spider/i.test(navigator.userAgent)

  // ─── Page trail, shared by the visit and bounce messages ───────────────────
  const navRaw = store.get(sessionStorage, NAV_KEY)
  const pages: string[] = navRaw ? JSON.parse(navRaw) : []
  if (pages.at(-1) !== pathOf()) pages.push(pathOf())
  store.set(sessionStorage, NAV_KEY, JSON.stringify(pages))

  // ─── Referral source: a fresh param wins, else what this device came from before ─
  let referral = store.get(localStorage, REFERRAL_KEY)
  const fromParams = referralFromParams(landingParams)
  if (fromParams) { referral = fromParams; store.set(localStorage, REFERRAL_KEY, fromParams) }
  // No ?l / ?r / known utm_source? An AI assistant can be the source instead: a utm_source
  // that names one, or a bare AI referrer when the URL had no params at all.
  const aiIsSource = !fromParams && aiAssistant !== null && (aiAssistantFromHost(landingParams.get('utm_source')) !== null || !rawParams)
  if (aiIsSource) { referral = aiAssistant; store.set(localStorage, REFERRAL_KEY, aiAssistant!) }

  // ─── Bounce: only this page, gone within 10 s ──────────────────────────────
  const onBounce = () => {
    if (slashHeld || isBot || store.get(sessionStorage, 'bounce_sent')) return
    // Each page here is a full page load (unlike hi-sg's client-side navigation), so clicking
    // through to another of our pages also fires pagehide. That's a visitor staying, not leaving.
    if (store.get(sessionStorage, INTERNAL_NAV_KEY)) return
    const trail: string[] = JSON.parse(store.get(sessionStorage, NAV_KEY) ?? '[]')
    const elapsed = Date.now() - enteredAt
    if (trail.length > 1 || elapsed > BOUNCE_THRESHOLD_MS) return
    store.set(sessionStorage, 'bounce_sent', '1')
    beacon({
      event: aiAssistant ? `🤖 Quick bounce from **${aiAssistant}** (AI assistant) on ${pathOf()}`
        : referral ? `👋 Quick bounce from **${referral}** on ${pathOf()}` : `👋 Quick bounce on ${pathOf()}`,
      meta: {
        '🛤️ Path': trail.join(' → ') || pathOf(),
        '⏱️ Time on page': `${Math.round(elapsed / 1000)}s`,
        '🕒 Time': new Date().toLocaleString(),
        ...(rawParams ? { '🔗 Params': `?${rawParams}` } : {}),
        ...aiMeta,
      },
      humanSignals: humanSignals.snapshot(),
      channel: channelOf(referral),
    })
  }
  addEventListener('pagehide', onBounce)

  // ─── Visit: sent after 5 s, or when the page goes away, whichever is first ─
  const ua = navigator.userAgent
  const device = /Mobi|Android|iPhone|iPad/i.test(ua) ? '📱 Mobile' : '🖥️ Desktop'
  const platform = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(navigator.platform) ? 'macOS'
    : /Win/.test(navigator.platform) ? 'Windows' : /Linux/.test(navigator.platform) ? 'Linux' : 'Unknown'
  const visit = {
    event: isBot ? `🤖 Bot/crawler on ${pathOf()}`
      : aiIsSource ? `🤖 New visitor from **${aiAssistant}** (AI assistant) on ${pathOf()}`
      : referral ? `👀 New visitor from **${referral}** on ${pathOf()}`
      : rawParams ? `👀 New visitor — CUSTOM REFERRAL on ${pathOf()}`
      : `👀 New visitor on ${pathOf()}`,
    meta: {
      '🖥️ Device': `${device} · ${platform}`,
      '🛤️ Path': pages.join(' → '),
      '🕒 Time': new Date().toLocaleString(),
      // always kept, so the real landing URL is visible next to the label
      ...(rawParams ? { '🔗 Params': `?${rawParams}` } : {}),
      ...aiMeta,
      ...(isBot ? { '🔍 UA': ua } : {}),
    },
  }
  let visitSent = false
  const flushVisit = () => {
    if (visitSent || slashHeld) return
    visitSent = true
    beacon({ ...visit, humanSignals: humanSignals.snapshot(), channel: channelOf(referral) })
    humanSignals.stop()
  }
  addEventListener('pagehide', flushVisit)
  setTimeout(flushVisit, VISIT_DELAY_MS)
}

/** Removes everything but the pages' own (valued) params from the address bar. */
function cleanUrl(params: URLSearchParams) {
  const keep = new URLSearchParams()
  for (const [k, v] of params) if (FUNCTIONAL_PARAMS.has(k) && v !== '') keep.append(k, v)
  if (keep.toString() === params.toString()) return
  const q = keep.toString()
  history.replaceState(history.state, '', location.pathname + (q ? `?${q}` : '') + location.hash)
}

// ─── Links to Richard's other sites carry where the visitor came from ────────
// Same scheme as hi-sg's lib/outbound-links.ts: utm_source = this site, utm_campaign =
// the page, utm_content = how the visitor reached us, and ?m for opted-out visitors.
function recordLandingSource(params: URLSearchParams) {
  const source = params.get('utm_source') ?? referralFromParams(params)
  if (source) { store.set(sessionStorage, LANDING_SOURCE_KEY, source); return }
  if (store.get(sessionStorage, LANDING_SOURCE_KEY) || !document.referrer) return
  try {
    const host = new URL(document.referrer).hostname
    if (host && host !== location.hostname) store.set(sessionStorage, LANDING_SOURCE_KEY, host.replace(/^www\./, ''))
  } catch { /* odd referrer */ }
}

function isOwnOtherSite(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.origin === location.origin) return false
  const host = url.hostname.replace(/^www\./, '')
  return host === 'richardli.dev' || host.endsWith('.richardli.dev')
}

export function withOutboundParams(href: string): string {
  let url: URL
  try { url = new URL(href, location.href) } catch { return href }
  if (!isOwnOtherSite(url)) return href
  if (!url.searchParams.has('utm_source')) {
    url.searchParams.set('utm_source', location.hostname.replace(/^www\./, ''))
    url.searchParams.set('utm_medium', 'referral')
    url.searchParams.set('utm_campaign', location.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '-').replace(/\.html$/, '') || 'home')
    const origin = store.get(sessionStorage, LANDING_SOURCE_KEY)
    if (origin) url.searchParams.set('utm_content', origin)
  }
  if (store.get(localStorage, SKIP_KEY) && !url.searchParams.has('m')) url.search = url.search ? `${url.search}&m` : '?m'
  return url.toString()
}

function tagOutboundLinks() {
  // Rewrite a link's href just before it is followed (pointerdown also covers middle-click
  // and "open in new tab"; click covers Enter). Capture phase, so it runs first.
  const tag = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    try { if (new URL(a.href).origin === location.origin) store.set(sessionStorage, INTERNAL_NAV_KEY, '1') } catch { /* odd href */ }
    const next = withOutboundParams(a.href)
    if (next !== a.href) a.href = next
  }
  document.addEventListener('pointerdown', tag, true)
  document.addEventListener('click', tag, true)
}

/** <a data-track="Opened dashboard from landing"> → one Discord event per click. */
function trackClicks() {
  document.addEventListener('click', (e) => {
    const el = (e.target as Element | null)?.closest?.('[data-track]') as HTMLElement | null
    if (!el) return
    const href = (el as HTMLAnchorElement).href
    trackEvent(`🖱️ ${el.dataset.track}`, { '📄 Page': pathOf(), ...(href ? { '🔗 Link': href } : {}) })
  }, true)
}
