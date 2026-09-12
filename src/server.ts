/**
 * dsh-network persistent loopback server.
 *
 * The dsh host spawns ONE long-lived `dsh-network server` child (following
 * dsh's lifecycle: started at `apply()`, killed at fiber dispose) and talks
 * to it over HTTP on 127.0.0.1 instead of spawning a fresh CLI per tool
 * call. The win over the old spawn-per-call model:
 *
 *   - No cold start per call: undici, the engine registry and the sitemap
 *     table load once.
 *   - Server-side cache: a large fetch/http body stays in the server's
 *     memory (see `cache.ts`); the host↔server channel only carries an
 *     inline preview + `cacheId`, and the model pages through the rest with
 *     `--cache-id`/`--offset`/`--limit`. This avoids the Windows
 *     child-stdout truncation failure mode AND the model-facing "huge single
 *     tool result" problem.
 *   - The server follows dsh's lifecycle: it exits when its stdin closes
 *     (the host died), and the host also sends `POST /shutdown` on dispose.
 *
 * Wire protocol (all JSON, all loopback-only):
 *
 *   - `POST /invoke`  body `{ argv: string[], env?: Record<string,string> }`
 *                     → the same envelope the single-shot CLI prints.
 *   - `GET  /content?c=<cacheId>&offset=<n>&limit=<n>`
 *                     → `{ body, slice }` page through a cached body.
 *   - `GET  /health`  → `{ ok, pid, uptimeMs, cache: { size, totalChars, hits } }`
 *   - `POST /shutdown`→ 200, then graceful close + process exit.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { runOnce, type Envelope, type RunContext } from './cli.ts'
import { ResultCache } from './cache.ts'

export interface ServerHandle {
  port: number
  /** Gracefully stop the HTTP server (does not force-exit the process). */
  close: () => Promise<void>
  cache: ResultCache
}

export interface StartServerOptions {
  /** Fixed loopback port; default 0 = ephemeral. */
  port?: number
  /** Listen host; loopback by default. */
  host?: string
  /** When true, exit when stdin closes (parent-death detection). */
  stdinWatch?: boolean
}

const MAX_INVOKE_BODY_BYTES = 4 * 1024 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseInvoke(body: string): { argv: string[]; env?: Record<string, string> } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('expected a JSON object body')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object body')
  }
  const argv = Array.isArray((parsed as { argv?: unknown }).argv)
    ? ((parsed as { argv: unknown[] }).argv.filter((a): a is string => typeof a === 'string'))
    : []
  const rawEnv = (parsed as { env?: unknown }).env
  const env: Record<string, string> | undefined =
    rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
      ? Object.fromEntries(
          Object.entries(rawEnv).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined
  return { argv, env }
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Start the loopback server. Resolves once the socket is listening.
 *
 * When `stdinWatch` is true the process watches its stdin: the host keeps a
 * pipe open for the server's lifetime and closes it on death, so `'end'` is
 * a cross-platform parent-death signal — a crash never leaves an orphan.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  const cache = new ResultCache()
  const started = Date.now()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:1`)
    try {
      if (req.method === 'POST' && url.pathname === '/invoke') {
        const body = await readBody(req, MAX_INVOKE_BODY_BYTES)
        const { argv, env } = parseInvoke(body)
        const runCtx: RunContext = { cache, env }
        let envelope: Envelope
        try {
          envelope = await runOnce(argv, runCtx)
        } catch (error) {
          envelope = {
            ok: false,
            results: [
              {
                kind: 'search',
                engine: 'cli',
                status: 'unavailable',
                summary: (error as Error).message ?? 'unknown error',
                items: [],
                uncertainty: [],
                warnings: [],
                attempts: [{ engine: 'cli', error: (error as Error).message ?? String(error) }],
              } as never,
            ],
            elapsedMs: Date.now() - started,
          }
        }
        sendJson(res, 200, envelope)
        return
      }

      if (req.method === 'GET' && url.pathname === '/content') {
        const c = url.searchParams.get('c')
        if (!c) {
          sendJson(res, 400, { error: 'missing ?c=<cacheId>' })
          return
        }
        const sliced = cache.slice(c, parseNumber(url.searchParams.get('offset') ?? undefined), parseNumber(url.searchParams.get('limit') ?? undefined))
        if (!sliced) {
          sendJson(res, 404, { error: `unknown cacheId "${c}"` })
          return
        }
        sendJson(res, 200, { body: sliced.body, slice: sliced.slice })
        return
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          uptimeMs: Date.now() - started,
          cache: { size: cache.size, totalChars: cache.totalChars, hits: cache.hits },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/shutdown') {
        sendJson(res, 200, { ok: true })
        // Respond first, then close; the host can stop reading once it gets 200.
        await new Promise((resolve) => setTimeout(resolve, 10))
        void shutdown()
        return
      }

      sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
    } catch (error) {
      sendJson(res, 400, { error: (error as Error).message ?? String(error) })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => resolve())
  })

  const address = server.address()
  const port =
    address && typeof address === 'object' ? address.port : typeof address === 'number' ? address : 0

  let shuttingDown = false
  async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    cache.clear()
    // Windows + Node >= 24: hard-exiting while the undici fetch machinery
    // (or any other handle) is tearing down races uv_close against a
    // mid-CLOSING uv_async_t → "Assertion failed: !(handle->flags &
    // UV_HANDLE_CLOSING), file src\win\async.c" → __fastfail → 0xC0000409
    // (nodejs/node#64322, libuv#5079). So never call process.exit() from
    // here: unref every blocking handle and let the event loop drain to a
    // natural exit. The host's dispose path already falls back to
    // SIGTERM → SIGKILL if the server were to hang (it never should — every
    // handle below is unref'd).
    process.stdin.unref()
    server.closeAllConnections()
    server.close()
    server.unref()
  }

  if (opts.stdinWatch) {
    process.stdin.on('end', () => shutdown())
    process.stdin.on('error', () => shutdown())
  }

  // Announce the port so the host can learn it without a fixed-port race.
  process.stdout.write(`${JSON.stringify({ type: 'ready', port })}\n`)

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        if (shuttingDown) {
          resolve()
          return
        }
        shuttingDown = true
        server.close(() => resolve())
      }),
    cache,
  }
}
