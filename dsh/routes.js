/**
 * dsh-network — loopback HTTP routes (host side).
 *
 * The three browser-reachable routes on ctx.webServer:
 * /dsh-network/config (settings bridge with optimistic concurrency),
 * /dsh-network/health (persistent server probe), /dsh-network/search
 * (sidebar panel backend). All fenced by isTrustedRequest. Split out of
 * index.js.
 */
import { savePersistedConfig, PERSIST_FILE } from './persist.js'
import { getNetworkClient, runCli } from './cli-runner.js'
import { summarize, applyCardSettings, isTrustedRequest } from './config-summary.js'

// ─────────────────────────────── settings bridge ────────────────────────────
// A loopback HTTP route the browser half reads/writes. Lives on the host
// (host has ctx.webServer) so we don't need a separate bundle, and the
// browser never sees an API key — only whether one is stored.
//
// Response shape is `{ value, revision }`: `value` is the JSON-safe view of
// the live config (without API keys), and `revision` is a monotonically
// increasing counter the browser echoes back as `If-Match` on PUTs for
// optimistic concurrency. The counter lives on a small holder object
// because `config` itself is the data plane — mixing control-plane state
// into it would leak into `summarize()` and back to the browser.
function registerConfigRoute(ctx, config) {
  if (typeof ctx.inject !== 'function') return
  const revision = { value: 1 }
  ctx.inject(['webServer'], (scope) => {
    try {
      scope.webServer.register({
        name: 'dsh-network-config',
        kind: 'exact',
        path: '/dsh-network/config',
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(body))
          }
          if (!isTrustedRequest(req)) {
            send(403, { error: 'request refused: this route answers same-origin loopback only' })
            return
          }
          if (req.method === 'GET') {
            send(200, { value: summarize(config), revision: revision.value })
            return
          }
          if (req.method !== 'POST' && req.method !== 'PUT') {
            res.writeHead(405).end()
            return
          }
          try {
            const chunks = []
            let total = 0
            for await (const chunk of req) {
              total += chunk.length
              if (total > 64 * 1024) {
                send(413, { error: 'config payload too large' })
                req.destroy()
                return
              }
              chunks.push(chunk)
            }
            const patch = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            // Optimistic concurrency: if the browser sent If-Match, the value
            // must equal the current revision or the change is rejected. A
            // browser without a recorded revision (header missing) gets the
            // last-write-wins fallback so first-time loads still save.
            const ifMatch = req.headers?.['if-match']
            if (typeof ifMatch === 'string' && ifMatch !== '') {
              const expected = Number(ifMatch)
              if (!Number.isInteger(expected) || expected !== revision.value) {
                send(412, { error: `revision mismatch: expected ${revision.value}, got ${ifMatch}` })
                return
              }
            }
            const ok = applyCardSettings(config, patch)
            if (!ok) {
              send(400, ok.error)
              return
            }
            // Durability: snapshot the live config to the persist file so the
            // edit survives a host restart. A failed write keeps the
            // in-memory change (this session keeps working) but is logged;
            // the response carries `persisted: false` for surfaces that want
            // to surface the gap.
            let persisted = true
            try {
              savePersistedConfig(config)
            } catch (error) {
              persisted = false
              ctx.logger?.warn?.(
                '[dsh-network] config change NOT persisted to %s: %s',
                PERSIST_FILE,
                error.message ?? String(error),
              )
            }
            revision.value += 1
            send(200, { value: summarize(config), revision: revision.value, persisted })
          } catch (error) {
            send(400, { error: String(error && error.message ? error.message : error) })
          }
        },
      })
    } catch (error) {
      // A headless profile or older host lacks webServer; stay quiet.
      ctx.logger?.warn?.('[dsh-network] settings card route skipped:', error?.message ?? error)
    }
  })
}

/** Expose a browser-reachable health probe for the persistent loopback server. */
function registerHealthRoute(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    try {
      scope.webServer.register({
        name: 'dsh-network-health',
        kind: 'exact',
        path: '/dsh-network/health',
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(body))
          }
          if (!isTrustedRequest(req)) {
            send(403, { error: 'request refused: this route answers same-origin loopback only' })
            return
          }
          if (req.method !== 'GET') {
            res.writeHead(405).end()
            return
          }
          try {
            const client = getNetworkClient()
            const result = await client.health()
            if (result.ok) {
              send(200, result.body && typeof result.body === 'object' ? result.body : { ok: true })
              return
            }
            send(503, {
              ok: false,
              error: (result.body && typeof result.body === 'object' && result.body.error)
                ? result.body.error
                : 'dsh-network loopback server health check failed',
            })
          } catch (error) {
            send(503, { ok: false, error: error?.message ?? String(error) })
          }
        },
      })
    } catch (error) {
      // A headless profile or older host lacks webServer; stay quiet.
      ctx.logger?.warn?.('[dsh-network] health route skipped:', error?.message ?? error)
    }
  })
}

/**
 * Browser-reachable search endpoint backing the sidebar "网络搜索" panel
 * (dsh/client.js). The panel POSTs `{ query, count, engine }` (GET `?q=` is
 * also accepted for shareable links) and this route runs the same CLI search
 * path the web_search tool uses — one job on the persistent loopback server
 * with the LIVE config (engine chain, SearXNG endpoint, timeouts), so UI
 * edits take effect on the next search without a plugin reload.
 *
 * Fenced exactly like `/dsh-network/config`: loopback Host header +
 * same-origin (Origin == Host, `sec-fetch-site: cross-site` rejected).
 * The gate is dynamic: with the web_search tool disabled
 * (`config.webSearchTool === false`) the route answers 403, so the
 * settings kill-switch also removes the panel's backend in real time.
 */
function registerSearchRoute(ctx, config) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    try {
      scope.webServer.register({
        name: 'dsh-network-search',
        kind: 'exact',
        path: '/dsh-network/search',
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(body))
          }
          if (!isTrustedRequest(req)) {
            send(403, { error: 'request refused: this route answers same-origin loopback only' })
            return
          }
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405).end()
            return
          }
          if (config.webSearchTool === false) {
            send(403, { error: 'web_search tool is disabled (网络 → 工具)' })
            return
          }
          let query = ''
          let rawCount
          let engine = ''
          try {
            if (req.method === 'GET') {
              const url = new URL(req.url ?? '/dsh-network/search', 'http://loopback.invalid')
              query = String(url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim()
              rawCount = url.searchParams.get('count')
              engine = String(url.searchParams.get('engine') ?? '').trim()
            } else {
              // POST carries the query as JSON so long CJK queries never hit
              // URL length limits. 16 KB is generous for a search string.
              const chunks = []
              let total = 0
              for await (const chunk of req) {
                total += chunk.length
                if (total > 16 * 1024) {
                  send(413, { error: 'search payload too large' })
                  req.destroy()
                  return
                }
                chunks.push(chunk)
              }
              const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
              if (!body || typeof body !== 'object') throw new Error('body must be a JSON object')
              query = String(body.query ?? body.q ?? '').trim()
              rawCount = body.count
              engine = typeof body.engine === 'string' ? body.engine.trim() : ''
            }
          } catch (error) {
            send(400, { error: 'invalid search request: ' + String(error && error.message ? error.message : error) })
            return
          }
          if (query === '') {
            send(400, { error: 'missing search query (?q= or {"query": …})' })
            return
          }
          const count = rawCount === undefined || rawCount === null || rawCount === '' ? 10 : Number(rawCount)
          if (!Number.isInteger(count) || count < 1 || count > 20) {
            send(400, { error: 'count must be an integer in [1, 20]' })
            return
          }
          const cliArgs = ['search', '-q', query, '--max-results', String(count), '-t', '55000']
          if (engine !== '') cliArgs.push('--engine', engine.toLowerCase())
          const startedAt = Date.now()
          try {
            // The engine chain itself is bounded by -t 55000; the outer
            // signal only guards against a wedged server client.
            const entry = await runCli(cliArgs, AbortSignal.timeout(70_000), config)
            send(200, {
              query,
              status: entry.status,
              engine: entry.engine,
              summary: entry.summary,
              items: Array.isArray(entry.items) ? entry.items : [],
              uncertainty: Array.isArray(entry.uncertainty) ? entry.uncertainty : [],
              warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
              attempts: Array.isArray(entry.attempts) ? entry.attempts : [],
              elapsedMs: Date.now() - startedAt,
            })
          } catch (error) {
            send(502, {
              query,
              error: String(error && error.message ? error.message : error),
              elapsedMs: Date.now() - startedAt,
            })
          }
        },
      })
    } catch (error) {
      // A headless profile or older host lacks webServer; stay quiet.
      ctx.logger?.warn?.('[dsh-network] search route skipped:', error?.message ?? error)
    }
  })
}

export { registerConfigRoute, registerHealthRoute, registerSearchRoute }
