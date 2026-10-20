// Cloudflare Worker for `npx wrangler deploy`: serves the built dashboard + landing page
// (dist/, via the ASSETS binding) and forwards /api/* and /ws/* to the backend on the Vultr VM.
// The VM's nginx already maps /api/<route> -> FastAPI /<route> and /ws/* -> FastAPI /ws/*,
// so paths are passed through unchanged. WebSocket upgrades are proxied the same way.
//
// BACKEND (wrangler.jsonc vars) must be a hostname, not a bare IP: Cloudflare refuses
// fetches to raw IP addresses. The proxy also means the HTTPS page never calls the
// plain-HTTP VM directly, so browsers don't block it as mixed content.

export default {
  /** @param {Request} request @param {{ ASSETS: { fetch(r: Request): Promise<Response> }, BACKEND: string }} env */
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
      const target = new URL(url.pathname + url.search, env.BACKEND)
      try {
        return await fetch(new Request(target, request))
      } catch (e) {
        return Response.json({ ok: false, error: `backend unreachable: ${e}` }, { status: 502 })
      }
    }
    return env.ASSETS.fetch(request)
  },
}
