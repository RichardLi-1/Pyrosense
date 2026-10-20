# Visitor tracking

Who visited the site, where they came from, and what they looked at, posted to a Discord channel.
Ported from hi-sg (`VISITOR_TRACKING.md` there), so the same referral links work on both sites.

**Sources:** `dashboard/src/lib/track/` (browser), `dashboard/worker/index.ts` (server, Cloudflare Worker).

## Flow

```
Human visit (dashboard, landing page, tech-stack page)
  browser ── startTracking() ── POST /api/track ── Worker adds IP, geo, human score ── Discord

AI assistant fetching a page (runs no JavaScript)
  request ── Worker ── console.log "ai_fetch" (every AI bot)
                   └─ Discord ("user" kind only: a person asked the assistant just now)
```

The webhook URL is a Worker secret; the browser only ever calls `/api/track` on our own origin.

**Two channels.** Visitors with a referral source (any of the sources below, including return visits that
remember one) go to `DISCORD_REFERRAL_WEBHOOK_URL`: their visits, bounces and clicks, so one person's journey
stays in one place. Everything else, and every AI-fetch report, goes to `DISCORD_WEBHOOK_URL`. If the referral
webhook isn't set, everything goes to the main one.

## What gets sent

- **Visit**, once per page load, 5 s after load (or when the page closes, whichever is first), so the
  human score has some input to judge: source, device, page trail (`/landing/ → /`), raw params, IP,
  country / region / city / coordinates / timezone (from Cloudflare), and a 0–100 human likelihood with
  the reasons behind it.
- **Quick bounce**: the visitor saw one page and left within 10 s. Clicking through to another of our
  pages doesn't count.
- **Clicks** on anything with `data-track="label"` (the landing page's two buttons and its tech-stack link).
- **AI fetches**: `ChatGPT-User`, `Claude-User`, `Perplexity-User` go to Discord; search and training
  crawlers (`GPTBot`, `ClaudeBot`, …) are logged only (`npx wrangler tail`, or Observability in the dashboard).

## Where a visit came from

Checked in order:

1. **Short params**: `?l` LinkedIn, `?r` / `?z` Resume, `?t` Twitter/X, `?e` Email, `?g` GitHub, `?c` Cover Letter.
2. **Known `utm_source`**: `?utm_source=resume_rl` → **Resume**. Add more in `UTM_SOURCES`.
3. **AI assistant**: `utm_source=chatgpt.com` (or a bare AI referrer) → ChatGPT, Perplexity, Claude, …
4. **Stored source**: what this device first arrived from (`localStorage.referral_source`), so later pages and
   return visits keep it.

Any other params show as **CUSTOM REFERRAL**, and the raw query string is always included as `🔗 Params`.

After reading them, the tracker removes tracking params from the address bar. The pages' own options
(`source`, `design`, `view`, `crew`, `speed`, `review`, `debug`, `p`, `t`) stay, but only with a value: landing's
`?t=4` is a clock setting, a bare `?t` is the Twitter/X key.

Links to `richardli.dev` sites get `utm_source` / `utm_campaign` / `utm_content` (and `?m` for opted-out
visitors), the same scheme as hi-sg.

## When tracking is skipped

- `localhost` and `127.0.0.1`.
- Any device that opened a URL with `?m` (remembered as `skip_tracking` in `localStorage`).
- Holding `/` while the page loads.
- The Vultr-hosted copy: nginx answers `/api/track` with 204. Tracking only works on the Cloudflare deploy.

## Setup

```bash
cd dashboard
npx wrangler secret put DISCORD_WEBHOOK_URL            # production
npx wrangler secret put DISCORD_REFERRAL_WEBHOOK_URL   # optional, the referral channel
cp .dev.vars.example .dev.vars                         # local `npm run dev:cf`
```

Unset main webhook = tracking silently does nothing (unless the referral one is set, which still gets referral visitors).

## Common changes

- **New referral link:** a short key in `REFERRAL_SOURCES`, or a `utm_source` value in `UTM_SOURCES`
  (`src/lib/track/referral-sources.ts`).
- **New AI assistant or bot:** `src/lib/track/ai-assistants.ts` only.
- **Score weights:** `src/lib/track/human-score.ts`.

## Privacy

Discord receives the visitor's IP, approximate location and referrer URL.
