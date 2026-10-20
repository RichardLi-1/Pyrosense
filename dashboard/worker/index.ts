// Cloudflare Worker for `npx wrangler deploy`:
//   /api/track  visitor tracking → Discord (ported from hi-sg's app/api/track/route.ts)
//   /api/*, /ws/*  proxied to the backend on the Vultr VM (paths unchanged; the VM's nginx
//               maps /api/<route> → FastAPI /<route>); WebSocket upgrades pass through
//   pages       AI assistants fetching a page are logged, and "a person asked" fetches go
//               to Discord (hi-sg's middleware.ts + lib/ai-fetch-reporter.ts)
//   the rest    static files from dist/ (dashboard, landing page, tech-stack page)
//
// BACKEND must be a hostname, not a bare IP (Cloudflare refuses fetches to raw IPs). The
// proxy also keeps the HTTPS page from calling the plain-HTTP VM, which browsers block.
// DISCORD_WEBHOOK_URL is a secret: `npx wrangler secret put DISCORD_WEBHOOK_URL`. Unset =
// tracking silently does nothing. DISCORD_REFERRAL_WEBHOOK_URL (optional, also a secret) gets
// everything from visitors who arrived through a referral; unset = they use the main one.
// See docs/visitor-tracking.md.
import { matchAiFetcher } from '../src/lib/track/ai-assistants'
import { scoreVisit, type HumanSignals } from '../src/lib/track/human-score'

type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> }
  BACKEND: string
  DISCORD_WEBHOOK_URL?: string
  DISCORD_REFERRAL_WEBHOOK_URL?: string
}
type Ctx = { waitUntil(p: Promise<unknown>): void }
/** The geo fields Cloudflare attaches to every request (request.cf). */
type Geo = { country?: string; region?: string; city?: string; latitude?: string; longitude?: string; postalCode?: string; timezone?: string }

const DISCORD_MAX = 2000 // Discord rejects longer messages

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/track' && request.method === 'POST') return track(request, env, ctx)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return proxy(request, url, env)
    if (isPage(url.pathname)) reportAiFetch(request, url, env, ctx)
    return env.ASSETS.fetch(request)
  },
}

async function proxy(request: Request, url: URL, env: Env) {
  try {
    return await fetch(new Request(new URL(url.pathname + url.search, env.BACKEND), request))
  } catch (e) {
    return Response.json({ ok: false, error: `backend unreachable: ${e}` }, { status: 502 })
  }
}

/** A page, not a file: no extension (so /landing/architecture.html counts, /assets/x.js doesn't). */
const isPage = (path: string) => !/\.[a-z0-9]+$/i.test(path) || path.endsWith('.html')

function post(webhook: string, content: string) {
  const body = content.length > DISCORD_MAX ? `${content.slice(0, DISCORD_MAX - 1)}…` : content
  return fetch(webhook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: body }),
  }).then(() => undefined, (err: unknown) => console.error('Discord webhook failed:', err))
}

// POST /api/track  { event, meta?, humanSignals?, channel? }  →  one Discord message
async function track(request: Request, env: Env, ctx: Ctx) {
  let body: { event?: unknown; meta?: unknown; humanSignals?: unknown; channel?: unknown }
  try { body = await request.json() } catch { return new Response(null, { status: 400 }) }
  if (typeof body.event !== 'string' || !body.event) return new Response(null, { status: 400 })
  // referral visitors → their own channel when it's configured, else the main one
  const webhook = (body.channel === 'referral' && env.DISCORD_REFERRAL_WEBHOOK_URL) || env.DISCORD_WEBHOOK_URL
  if (!webhook) return new Response(null, { status: 204 })
  const meta = body.meta && typeof body.meta === 'object' ? body.meta as Record<string, string> : {}

  const geo = ((request as unknown as { cf?: Geo }).cf) ?? {}
  // Human-likelihood score from the browser's signals + this request's own headers
  // (src/lib/track/human-score.ts has every rule and weight).
  const human = body.humanSignals && typeof body.humanSignals === 'object'
    ? scoreVisit(body.humanSignals as Partial<HumanSignals>, request.headers, geo.timezone) : null
  const ip = request.headers.get('cf-connecting-ip')
  const fields: Record<string, string> = {
    ...(human ? {
      [human.label === 'likely bot' ? '🤖 Human likelihood' : '🧍 Human likelihood']: `**${human.score}/100** (${human.label})`,
      '🧾 Why': human.reasons.join(', ') || 'no signals either way',
    } : {}),
    ...meta,
    ...(ip ? { '🌐 IP': ip } : {}),
    ...(geo.country ? { '🌍 Country': geo.country } : {}),
    ...(geo.region ? { '🗺️ Region': geo.region } : {}),
    ...(geo.city ? { '🏙️ City': geo.city } : {}),
    ...(geo.latitude && geo.longitude ? { '📍 Coordinates': `${geo.latitude}, ${geo.longitude}` } : {}),
    ...(geo.postalCode ? { '📮 Postal': geo.postalCode } : {}),
    ...(geo.timezone ? { '🕒 Timezone': geo.timezone } : {}),
  }
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
  ctx.waitUntil(post(webhook, [`🔔 ${body.event}`, ...lines].join('\n')))
  return new Response(null, { status: 204 })
}

// AI assistants that fetch pages themselves never run our JavaScript, so only the Worker
// sees them. Every hit → one JSON log line ("ai_fetch", see `wrangler tail` / Observability);
// "user" fetches (a person asked the assistant just now) also → Discord.
function reportAiFetch(request: Request, url: URL, env: Env, ctx: Ctx) {
  const fetcher = matchAiFetcher(request.headers.get('user-agent'))
  if (!fetcher) return
  const page = url.pathname + url.search
  console.log(JSON.stringify({ type: 'ai_fetch', vendor: fetcher.vendor, bot: fetcher.token, kind: fetcher.kind, page }))
  if (fetcher.kind !== 'user' || !env.DISCORD_WEBHOOK_URL) return
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return // production only
  ctx.waitUntil(post(env.DISCORD_WEBHOOK_URL, [
    `🔔 🔎 **${fetcher.token}** read ${url.pathname} for someone`,
    `🤖 Assistant: ${fetcher.vendor}`,
    `📄 Page: ${page}`,
    `🕒 Time: ${new Date().toISOString()}`,
  ].join('\n')))
}
