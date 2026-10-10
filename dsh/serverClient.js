/**
 * dsh-network host↔server client.
 *
 * Owns ONE persistent `dsh-network server` child (the only child process the
 * host spawns) and talks to it over loopback HTTP instead of spawning a
 * fresh CLI per tool call. Following dsh's lifecycle:
 *
 *   - `ensure()` spawns the server lazily on first use (or eagerly when the
 *     host wants a warm server) and learns its port from the stdout ready
 *     line `{"type":"ready","port":N}`.
 *   - `invoke(argv, env, signal)` POSTs `/invoke` and returns the same JSON
 *     envelope the single-shot CLI prints.
 *   - `dispose()` POSTs `/shutdown` (best effort) and kills the child. The
 *     host binds this to the Cordis fiber via `ctx.effect()`, so the server
 *     dies with dsh. If the host itself crashes, the child self-exits when
 *     its stdin pipe closes (parent-death detection in src/server.ts).
 *   - If the child dies unexpectedly, the next `invoke()` respawns it.
 *
 * The per-call env snapshot carries the host's LIVE config (engine order,
 * timeouts, allowlist, GitHub token, SearXNG endpoint, …). Secrets travel
 * only over the loopback socket, never to the browser, and every tool call
 * reflects the latest settings without restarting the server.
 */
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { spawnHidden } from './spawnHidden.js'

const CLI_PATH = fileURLToPath(new URL('../dist/cli.cjs', import.meta.url))
const READY_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 70_000

function httpJsonRequest(port, method, path, body, signal) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          if (text !== '') {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = null
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw: text })
        })
      },
    )
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`dsh-network server request timed out (${method} ${path})`))
    })
    req.on('error', reject)
    const onAbort = () => req.destroy(new Error('dsh-network request aborted'))
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('dsh-network request aborted'))
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
        req.on('close', () => signal.removeEventListener('abort', onAbort))
      }
    }
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/**
 * Build the per-invoke env snapshot from the host's live config. Mirrors the
 * env knobs `src/cli.ts`'s `loadConfig()` reads, so live UI edits take effect
 * on the next tool call without restarting the server.
 */
export function configToEnv(config) {
  const env = {}
  const c = config && typeof config === 'object' ? config : {}
  const engines = Array.isArray(c.searchEngines) && c.searchEngines.length > 0
    ? c.searchEngines
    : ['bing', 'duckduckgo', 'baidu']
  env.DSH_NETWORK_SEARCH_ENGINES = engines.join(',')
  if (Number.isInteger(c.fetchTimeoutMs)) env.DSH_NETWORK_FETCH_TIMEOUT_MS = String(c.fetchTimeoutMs)
  if (Number.isInteger(c.searchTimeoutMs)) env.DSH_NETWORK_SEARCH_TIMEOUT_MS = String(c.searchTimeoutMs)
  if (Number.isInteger(c.httpTimeoutMs)) env.DSH_NETWORK_HTTP_TIMEOUT_MS = String(c.httpTimeoutMs)
  if (Number.isInteger(c.maxBodyChars)) env.DSH_NETWORK_MAX_BODY_CHARS = String(c.maxBodyChars)
  if (Number.isInteger(c.maxRedirects)) env.DSH_NETWORK_MAX_REDIRECTS = String(c.maxRedirects)
  if (Number.isInteger(c.searchMaxResults)) env.DSH_NETWORK_SEARCH_MAX_RESULTS = String(c.searchMaxResults)
  if (typeof c.userAgent === 'string' && c.userAgent !== '') env.DSH_NETWORK_USER_AGENT = c.userAgent
  if (Array.isArray(c.allowlist) && c.allowlist.length > 0) env.DSH_NETWORK_ALLOWLIST = c.allowlist.join(',')
  if (typeof c.githubToken === 'string' && c.githubToken !== '') env.DSH_NETWORK_GITHUB_TOKEN = c.githubToken
  if (Array.isArray(c.githubIndexes) && c.githubIndexes.length > 0) {
    env.DSH_NETWORK_GITHUB_INDEXES = c.githubIndexes.join(',')
  }
  if (typeof c.githubSort === 'string' && c.githubSort !== '') env.DSH_NETWORK_GITHUB_SORT = c.githubSort
  const searxng = c.searchEngineConfigs && c.searchEngineConfigs.searxng
  if (searxng && typeof searxng.endpoint === 'string' && searxng.endpoint.trim() !== '') {
    env.DSH_NETWORK_SEARXNG_URL = searxng.endpoint.trim()
  }
  // ── keyed engines (Brave, …) ──────────────────────────────────────────
  // Two maps ride the snapshot. The KEYS map is the credential channel: the
  // browser collects engine API keys, `applyCardSettings` stores them on the
  // live config, and this is the hop that carries them to the CLI. Before
  // this existed the settings page happily stored keys nothing ever read —
  // every engine saw `hasApiKey: false` and no engine could authenticate.
  // The OPTIONS map is the free-form per-engine textarea (country, freshness,
  // …); engines validate their own fields.
  //
  // Secrets travel only over the loopback socket, and the browser still sees
  // nothing but `hasApiKey` (see summarize()).
  const keys = {}
  const storedKeys =
    c.searchEngineApiKeys && typeof c.searchEngineApiKeys === 'object' ? c.searchEngineApiKeys : {}
  for (const [id, value] of Object.entries(storedKeys)) {
    if (typeof value === 'string' && value.trim() !== '') keys[id] = value
  }
  // The pre-existing GitHub token joins the same channel so one code path
  // authenticates every keyed engine; DSH_NETWORK_GITHUB_TOKEN stays set
  // alongside it for CLI-side back-compat.
  if (typeof c.githubToken === 'string' && c.githubToken.trim() !== '') {
    keys.github = c.githubToken
  }
  if (Object.keys(keys).length > 0) {
    env.DSH_NETWORK_SEARCH_ENGINE_API_KEYS = JSON.stringify(keys)
  }
  const options = {}
  const configured =
    c.searchEngineConfigs && typeof c.searchEngineConfigs === 'object' ? c.searchEngineConfigs : {}
  for (const [id, entry] of Object.entries(configured)) {
    if (!entry || typeof entry !== 'object') continue
    const opts = entry.options
    if (opts && typeof opts === 'object' && !Array.isArray(opts) && Object.keys(opts).length > 0) {
      options[id] = opts
    }
  }
  if (Object.keys(options).length > 0) {
    env.DSH_NETWORK_ENGINE_OPTIONS = JSON.stringify(options)
  }
  // ── web_download ────────────────────────────────────────────────────────
  // The one path that is not a network knob: the ROOT `web_download` writes
  // into when the model asks for `dest: "workspace"`. The server child is
  // long-lived and its own cwd is wherever dsh was launched, so the host
  // resolves the real workspace once (config-summary.defaultConfig) and
  // ships it here per invoke. The CLI treats an empty value as "workspace
  // unavailable" and refuses the call — it never falls back to its own cwd.
  if (typeof c.workspaceDir === 'string' && c.workspaceDir !== '') {
    env.DSH_NETWORK_WORKSPACE_DIR = c.workspaceDir
  }
  return env
}

export function createNetworkServerClient(options = {}) {
  const cliPath = process.env.DSH_NETWORK_CLI || options.cliPath || CLI_PATH
  const logger = options.logger
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS

  let child = null
  let port = 0
  let ready = false
  let starting = null
  let disposed = false
  let currentEnv = null

  function log(...args) {
    if (typeof logger?.info === 'function') logger.info('[dsh-network]', ...args)
  }

  /**
   * Pre-flight the bundle before spawning. 
   * A missing bundle means the install is incomplete or predates the build
   * output. Name that, instead of letting the spawn fail as the opaque
   * "server exited during startup (code 1)".
   */
  function assertCliPresent() {
    if (fs.existsSync(cliPath)) return
    throw new Error(
      `dsh-network CLI bundle is missing: ${cliPath} does not exist. ` +
        'Reinstall `@naivg/dsh-network` (npm or `dsh plugin add`), or run `pnpm build` ' +
        'inside the plugin checkout.',
    )
  }

  function spawnServer() {
    if (disposed) throw new Error('dsh-network server client is disposed')
    assertCliPresent()
    log('spawning server:', cliPath)
    const base = process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
    child = spawnHidden(process.execPath, [cliPath, 'server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: base,
    })
    // The server speaks JSON on stdout only; anything on stderr is a crash
    // trace. Keep a tail of it so startup failures explain themselves.
    let stderrTail = ''
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000)
    })
    const withStderr = (message) =>
      stderrTail.trim() === '' ? message : `${message}: ${stderrTail.trim().slice(-500)}`
    child.on('exit', (code) => {
      ready = false
      port = 0
      log(`server exited (code ${code})`)
      child = null
    })
    child.on('error', (error) => {
      log(`server spawn error: ${error.message}`)
      ready = false
      child = null
    })
    // Announce readiness from the first stdout JSON line.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(withStderr(new Error('dsh-network server did not announce a port')))
      }, readyTimeoutMs)
      const onData = (chunk) => {
        const text = chunk.toString('utf8')
        const match = text.match(/\{"type":"ready","port":(\d+)\}/)
        if (match) {
          clearTimeout(timer)
          port = Number(match[1])
          ready = true
          resolve(port)
        }
      }
      child.stdout.on('data', onData)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(withStderr(new Error(`dsh-network server exited during startup (code ${code})`)))
      })
    })
  }

  /** Ensure the server is up; returns its port. */
  async function ensure() {
    if (disposed) throw new Error('dsh-network server client is disposed')
    if (ready && port > 0) return port
    if (starting) return starting
    starting = spawnServer().finally(() => {
      starting = null
    })
    return starting
  }

  /**
   * Run one job on the server. `argv` is the CLI argument list; `env` is the
   * per-call config snapshot from {@link configToEnv}. Returns the envelope.
   */
  async function invoke(argv, env, signal) {
    if (!Array.isArray(argv)) throw new Error('dsh-network invoke: argv must be an array')
    const p = await ensure()
    currentEnv = env && typeof env === 'object' ? env : null
    const res = await httpJsonRequest(p, 'POST', '/invoke', {
      argv,
      ...(currentEnv ? { env: currentEnv } : {}),
    }, signal)
    if (res.status !== 200 || res.body === null) {
      throw new Error(
        `dsh-network server invoke failed (${res.status}): ${(res.body && (res.body.error ?? '')) || res.raw.slice(0, 300)}`,
      )
    }
    return res.body
  }

  /** Readiness probe against the live server. */
  async function health() {
    const p = await ensure()
    const res = await httpJsonRequest(p, 'GET', '/health')
    return { ok: res.status === 200, body: res.body, status: res.status }
  }

  /** Tear down the server: best-effort /shutdown then kill. Idempotent. */
  async function dispose() {
    if (disposed) return
    disposed = true
    const p = port > 0 && ready ? port : 0
    if (p > 0) {
      try {
        await httpJsonRequest(p, 'POST', '/shutdown')
      } catch {
        // Server may already be gone; ignore.
      }
    }
    const c = child
    if (c) {
      c.kill('SIGTERM')
      const gone = await Promise.race([
        new Promise((resolve) => c.once('exit', () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
      ])
      if (!gone) c.kill('SIGKILL')
    }
    child = null
    ready = false
    port = 0
  }

  return {
    ensure,
    invoke,
    health,
    dispose,
    cliPath,
    get ready() { return ready },
    get port() { return port },
    get pid() { return child?.pid ?? null },
    get disposed() { return disposed },
  }
}
