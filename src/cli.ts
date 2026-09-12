#!/usr/bin/env node
/**
 * dsh-network CLI — the binary the dsh host plugin spawns.
 *
 * One process per call. Reads its arguments from argv (positional + flags),
 * runs exactly one of three jobs:
 *   - `-q <query>`           — Bing → DuckDuckGo → Baidu scrape-search
 *   - `-u <url>`            — undici-direct page fetch, Markdown body
 *   - `-X <method> <url>`   — undici-direct low-level HTTP request
 *
 * Outputs ONE structured JSON envelope on stdout (regardless of outcome):
 *
 *   {
 *     "ok": true | false,
 *     "results": [
 *       {
 *         "kind": "search" | "fetch" | "http",
 *         "engine": "bing" | "duckduckgo" | "baidu" | "undici",
 *         "status": "ok" | "degraded" | "unavailable",
 *         "summary": "...",
 *         "items":  [ ... ]            // search: citeable sources
 *         "content": "..."             // fetch: cleaned body
 *         "links":  [ { text, url } ]  // fetch: outgoing links
 *         "uncertainty": [ "..." ],    // epistemic flags
 *         "warnings":    [ "..." ],    // operational warnings
 *         "body":        "..."         // http: raw response body
 *         "headers":     [ ... ],      // http: response headers
 *         "statusCode":  200,          // fetch / http
 *         "finalUrl":    "...",        // fetch / http
 *         "contentType": "...",        // fetch / http
 *         "attempts":    [ ... ]       // for "unavailable" trace
 *       }
 *     ],
 *     "elapsedMs": 123
 *   }
 *
 * The host spawns this with `subprocess.spawnHidden` and reads stdout once.
 * Stderr is reserved for diagnostics and never carries the payload.
 */
import { runClientFetch } from './client.ts'
import { fetchPage } from './fetch.ts'
import { runHttpRequest } from './http_request.ts'
import { isPrivateHost, parseHttpUrl } from './network.ts'
import {
  applyCacheToFetch,
  applyCacheToHttp,
  serveCachedEntry,
  sliceInfo,
  type CacheSlice,
  type ResultCache,
} from './cache.ts'
import {
  defaultRegistry,
  registerDefaultEngines,
  type EngineBody,
  type SearchEngine,
  type SearchSource,
} from './engines/index.ts'
import {
  WEB_SITEMAP,
  categoriesInUse,
  findByDomain,
  listByCategory,
  renderPromptDigest,
  searchSitemap,
  summarize,
  buildSearchUrl,
  type WebSitemapCategory,
  type WebSitemapEntry,
  type WebSitemapEntrySummary,
} from './sitemap.js'

// Populate the process-wide registry exactly once per CLI invocation.
// `registerDefaultEngines` is idempotent: re-registering the same id
// replaces the existing engine, so a duplicate call is safe.
registerDefaultEngines(defaultRegistry)

interface SearchEntry {
  kind: 'search'
  engine: string
  status: 'ok' | 'degraded' | 'unavailable'
  summary: string
  items: SearchSource[]
  uncertainty: string[]
  warnings: string[]
  attempts: Array<{ engine: string; error?: string }>
}

interface FetchEntry {
  kind: 'fetch'
  engine: 'undici'
  status: 'ok' | 'unavailable'
  summary: string
  content: string
  links: Array<{ text: string; url: string }>
  uncertainty: string[]
  warnings: string[]
  statusCode: number
  finalUrl: string
  contentType: string
  attempts: Array<{ stage: string; error: string }>
  /** Present when the body was degraded to an inline preview (server mode). */
  cacheId?: string
  /** Full body length (present alongside cacheId). */
  contentLength?: number
  /** Present when the envelope is one paged slice of a cached body. */
  cacheSlice?: CacheSlice
}

interface HttpEntry {
  kind: 'http'
  engine: 'undici-direct'
  status: 'ok' | 'unavailable'
  summary: string
  body: string
  headers: Array<{ name: string; value: string }>
  statusCode: number
  statusText: string
  contentType: string
  finalUrl: string
  attempts: Array<{ stage: string; error: string }>
  /** Present when the body was degraded to an inline preview (server mode). */
  cacheId?: string
  /** Full body length (present alongside cacheId). */
  contentLength?: number
  /** Present when the envelope is one paged slice of a cached body. */
  cacheSlice?: CacheSlice
}

/**
 * web_sitemap lookup. Returns zero or more entries plus optional URL
 * resolutions — the LLM uses this to pick the right authoritative site
 * instead of generic search engines.
 */
interface SitemapEntry {
  kind: 'sitemap'
  engine: 'web_sitemap'
  status: 'ok' | 'unavailable'
  summary: string
  /** The matching entries (always present, possibly length 0). */
  entries: WebSitemapEntrySummary[]
  /** Optional resolved search URLs when `-d <domain> -q <query>` is used. */
  resolved: Array<{ domain: string; query: string; url: string }>
  /** The optional Markdown digest (only when `--digest` is set). */
  digest?: string
  uncertainty: string[]
  warnings: string[]
  attempts: Array<{ stage: string; error?: string }>
}

type Entry = SearchEntry | FetchEntry | HttpEntry | SitemapEntry
interface Envelope {
  ok: boolean
  results: Entry[]
  elapsedMs: number
  /** Only for help requests: the help text (server /invoke path). */
  help?: string
}

interface CliFlags {
  mode: 'search' | 'fetch' | 'http' | 'sitemap' | 'help' | 'doctor' | 'server' | 'unknown'
  query?: string
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
  contentType?: string
  timeoutMs: number
  maxResults: number
  format: 'markdown' | 'raw'
  allowPrivate: boolean
  redirectProtection: boolean
  protocolLock: boolean
  followRedirects: boolean
  engine?: string
  jsonSchema?: unknown
  /** Sitemap-only: filter by category. */
  sitemapCategory?: WebSitemapCategory
  /** Sitemap-only: minimum priority threshold. */
  sitemapMinPriority?: number
  /** Sitemap-only: when true, include the Markdown digest in the response. */
  sitemapDigest?: boolean
  /** Sitemap-only: resolve a single entry by domain. */
  sitemapDomain?: string
  /** Server mode: persistent loopback HTTP server. */
  server?: boolean
  /** Server mode: fixed loopback port (default: ephemeral). */
  serverPort?: number
  /** Fetch/http paging: read one cached body slice instead of fetching. */
  cacheId?: string
  /** Fetch/http paging: starting character offset into the cached body. */
  offset?: number
  /** Fetch/http paging: slice length (also the sitemap entry cap). */
  limit?: number
  showHelp: boolean
}

const DEFAULT_TIMEOUT_MS = 25_000
const DEFAULT_MAX_RESULTS = 10

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    mode: 'unknown',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResults: DEFAULT_MAX_RESULTS,
    format: 'markdown',
    allowPrivate: false,
    redirectProtection: true,
    protocolLock: true,
    followRedirects: true,
    showHelp: false,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '-q' || arg === '--query') {
      flags.query = argv[++i] ?? ''
    } else if (arg === '-u' || arg === '--url') {
      flags.url = argv[++i] ?? ''
    } else if (arg === '-X' || arg === '--method') {
      flags.mode = 'http'
      flags.method = argv[++i] ?? 'GET'
    } else if (arg === '--timeout' || arg === '-t') {
      flags.timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS
    } else if (arg === '--max-results' || arg === '--count') {
      flags.maxResults = Number(argv[++i]) || DEFAULT_MAX_RESULTS
    } else if (arg === '--format') {
      const v = argv[++i] ?? 'markdown'
      if (v === 'raw') flags.format = 'raw'
    } else if (arg === '--allow-private-network') {
      flags.allowPrivate = true
    } else if (arg === '--no-redirect-protection') {
      flags.redirectProtection = false
    } else if (arg === '--no-protocol-lock') {
      flags.protocolLock = false
    } else if (arg === '--no-follow') {
      flags.followRedirects = false
    } else if (arg === '--engine') {
      const v = argv[++i]
      if (typeof v === 'string' && v.trim() !== '') flags.engine = v.trim().toLowerCase()
    } else if (arg === '--headers') {
      const raw = argv[++i]
      if (raw) try { flags.headers = JSON.parse(raw) } catch {}
    } else if (arg === '--body' || arg === '-d') {
      flags.body = argv[++i]
    } else if (arg === '--content-type') {
      flags.contentType = argv[++i]
    } else if (arg === '--json-schema') {
      try { flags.jsonSchema = JSON.parse(argv[++i] ?? '{}') } catch {}
    } else if (arg === '--category' || arg === '-c') {
      const v = argv[++i]
      if (typeof v === 'string' && v.trim() !== '') flags.sitemapCategory = v.trim().toLowerCase() as WebSitemapCategory
    } else if (arg === '--min-priority' || arg === '-p') {
      const v = Number(argv[++i])
      if (Number.isInteger(v) && v >= 1 && v <= 10) flags.sitemapMinPriority = v
    } else if (arg === '--digest') {
      flags.sitemapDigest = true
    } else if (arg === '--domain' || arg === '--sitemap-domain') {
      // Sitemap-only: avoid the bare `-d` short flag because it collides
      // with `--body` in http_request mode.
      const v = argv[++i]
      if (typeof v === 'string' && v.trim() !== '') flags.sitemapDomain = v.trim()
    } else if (arg === '--limit') {
      const v = Number(argv[++i])
      if (Number.isInteger(v) && v > 0) {
        flags.maxResults = v
        flags.limit = v
      }
    } else if (arg === '--offset') {
      const v = Number(argv[++i])
      if (Number.isInteger(v) && v >= 0) flags.offset = v
    } else if (arg === '--cache-id') {
      const v = argv[++i]
      if (typeof v === 'string' && v.trim() !== '') flags.cacheId = v.trim()
    } else if (arg === '--port') {
      const v = Number(argv[++i])
      if (Number.isInteger(v) && v > 0 && v <= 65535) flags.serverPort = v
    } else if (arg === 'server') {
      flags.mode = 'server'
      flags.server = true
    } else if (arg === 'search') {
      flags.mode = 'search'
    } else if (arg === 'fetch') {
      flags.mode = 'fetch'
    } else if (arg === 'http') {
      flags.mode = 'http'
    } else if (arg === 'sitemap' || arg === 'web_sitemap') {
      flags.mode = 'sitemap'
    } else if (arg === 'doctor') {
      flags.mode = 'doctor'
    } else if (arg === '-h' || arg === '--help') {
      flags.showHelp = true
    } else if (arg.startsWith('-')) {
      // Unknown; ignored for forward compatibility.
    } else {
      positional.push(arg)
    }
  }
  if (flags.mode === 'http' && flags.url === undefined) {
    // `-X <method>` may be followed by URL as a positional arg.
    flags.url = positional.shift()
  }
  if (flags.mode === 'unknown') {
    if (positional[0] === 'server') flags.mode = 'server'
    else if (positional[0] === 'search') flags.mode = 'search'
    else if (positional[0] === 'fetch') flags.mode = 'fetch'
    else if (positional[0] === 'http') flags.mode = 'http'
    else if (positional[0] === 'sitemap' || positional[0] === 'web_sitemap') flags.mode = 'sitemap'
    else if (positional[0] === 'doctor') flags.mode = 'doctor'
    else if (typeof flags.cacheId === 'string') flags.mode = 'http'
    // Bare `--cache-id` paging: the only producer in practice is the host's
    // http_request handler (web_fetch prefixes the `fetch` subcommand), and
    // that handler consumes the http-shaped entry's `body` field — so route
    // it to the http paging path rather than let it fall through to showHelp
    // (which returned an empty help envelope). Defect history: this used to
    // default to the fetch path, whose entry carries the slice in `content`;
    // the http host handler read `body`, so every paged read rendered an
    // empty body ("showing 0 of N chars").
    else if (typeof flags.url === 'string') flags.mode = 'fetch'
    else if (typeof flags.query === 'string') flags.mode = 'search'
  }
  if (flags.mode === 'unknown') flags.showHelp = true
  return flags
}

function helpText(): string {
  return [
    'dsh-network CLI',
    '',
    'Usage:',
    '  dsh-network search -q <query>            [options]   Free Bing→DDG→Baidu search',
    '  dsh-network fetch  -u <url>             [options]   Fetch URL → Markdown (or raw)',
    '  dsh-network http | dsh-network -X <METHOD> <url>   Low-level HTTP request / cache paging',
    '  dsh-network sitemap                      [options]   Look up the curated portals table (web_sitemap)',
    '  dsh-network doctor                                   Readiness report (no network)',
    '  dsh-network server                       [options]   Persistent loopback HTTP server (host uses this)',
    '',
    'Options:',
    '  -q, --query        string     Search query (-q "rust vs go benchmarks")',
    '  --engine           string     Force one search engine by id (search mode); default: chain fallback',
    '  -u, --url          string     Target URL',
    '  -X, --method       string     HTTP method for http_request mode',
    '  -t, --timeout      int        Per-call timeout in milliseconds',
    '  --max-results, --count int    Cap on search results (search mode)',
    '  --format           raw|markdown  Fetch output format (fetch mode; default markdown)',
    '  --allow-private-network        Allow loopback / private / reserved targets (off by default)',
    '  --no-redirect-protection       Allow redirects to cross domains (same-domain redirects only by default)',
    '  --no-protocol-lock             Allow redirects to switch between http and https (locked by default)',
    '  --no-follow                   http_request: do not follow redirects',
    '  --headers          JSON       Request headers (JSON object)',
    '  -d, --body         string     Request body (text)',
    '  --content-type     string     Content-Type for the body',
    '  --json-schema      JSON       Optional JSON-Schema constraint for the engine',
    '  --cache-id         string     Fetch/http paging: read a cached body slice by id',
    '  --offset           int        Fetch/http paging: starting character offset (default 0)',
    '  --limit            int        Fetch/http paging: slice length (1-20000, default 4000)',
    '',
    'Sitemap options (web_sitemap subcommand):',
    '  -d, --domain       string     Resolve one entry by domain (e.g. github.com)',
    '  -c, --category     string     Filter by category (code-repos, qna, docs, ai-platforms, …)',
    '  -p, --min-priority int        Drop entries whose priority is below N (1..10)',
    '  --digest                       Also include a Markdown digest the model can paste into context',
    '  --limit           int        Cap on returned entries (default 10)',
    '  -h, --help                     This help',
    '',
    'Server options (server subcommand):',
    '  --port            int        Loopback port to listen on (default: ephemeral, printed on stdout)',
    '',
    'Engine choices for search: bing, duckduckgo, baidu, github, searxng. Default chain is the order given above.',
    'GitHub engine: hybrid REST search (repositories/code/issues/users). Code search needs',
    '  DSH_NETWORK_GITHUB_TOKEN; anonymous search is limited to 10 req/min per IP.',
    'SearXNG engine: self-hosted metasearch JSON API (docs.searxng.org/dev/search_api.html). Endpoint:',
    '  DSH_NETWORK_SEARXNG_URL, default http://127.0.0.1:8888 (loopback/private endpoints are reached',
    '  automatically for this engine only — SSRF guards stay on for everything else). The instance must',
    '  enable `json` under `search.formats` in its settings.yml, or every request gets a 403.',
    'web_sitemap: curated table of authoritative portals (domain, description, category, priority,',
    '  searchUrl template). Helps the model skip generic search for known sources.',
  ].join('\n')
}

interface ParsedConfig {
  fetchTimeoutMs: number
  searchTimeoutMs: number
  httpTimeoutMs: number
  maxBodyChars: number
  maxRedirects: number
  searchEngines: string[]
  searchMaxResults: number
  userAgent: string
  allowlist: string[]
  /** Optional GitHub token; enables the code index and raises search quota. */
  githubToken: string
  /** Explicit GitHub index selection (empty = automatic intent routing). */
  githubIndexes: string[]
  /** GitHub repositories sort: '' (best match) | 'stars' | 'updated'. */
  githubSort: string
}

function readEnvInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name]
  if (!v) return fallback
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function readEnvString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return env[name] ?? fallback
}

function readEnvList(env: NodeJS.ProcessEnv, name: string): string[] {
  const v = env[name]
  if (!v) return []
  return v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

/**
 * Resolve the CLI-side runtime config from an env snapshot.
 *
 * The single-shot CLI reads `process.env` directly. The persistent server
 * passes a per-invoke env snapshot (the host's live config) so live UI
 * edits take effect on the next tool call without restarting the server.
 */
function loadConfig(env: NodeJS.ProcessEnv = process.env): ParsedConfig {
  // The configured engine list comes from the env var; we accept any id
  // the registry knows about (case-insensitive). Unknown ids are dropped
  // here and the chain falls back to the registry's `fallback()`.
  const enginesRaw = (env.DSH_NETWORK_SEARCH_ENGINES ?? 'bing,duckduckgo,baidu')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
  return {
    fetchTimeoutMs: readEnvInt(env, 'DSH_NETWORK_FETCH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    searchTimeoutMs: readEnvInt(env, 'DSH_NETWORK_SEARCH_TIMEOUT_MS', 15_000),
    httpTimeoutMs: readEnvInt(env, 'DSH_NETWORK_HTTP_TIMEOUT_MS', 25_000),
    maxBodyChars: readEnvInt(env, 'DSH_NETWORK_MAX_BODY_CHARS', 3_000_000),
    maxRedirects: readEnvInt(env, 'DSH_NETWORK_MAX_REDIRECTS', 3),
    searchEngines: enginesRaw,
    searchMaxResults: readEnvInt(env, 'DSH_NETWORK_SEARCH_MAX_RESULTS', 10),
    userAgent: readEnvString(env, 'DSH_NETWORK_USER_AGENT', ''),
    githubToken: readEnvString(env, 'DSH_NETWORK_GITHUB_TOKEN', ''),
    githubIndexes: readEnvList(env, 'DSH_NETWORK_GITHUB_INDEXES'),
    githubSort: readEnvString(env, 'DSH_NETWORK_GITHUB_SORT', ''),
    allowlist: readEnvList(env, 'DSH_NETWORK_ALLOWLIST'),
  }
}

/**
 * The SearXNG engine targets a user-configured self-hosted instance whose
 * default endpoint is loopback (`http://127.0.0.1:8888`). Reaching that
 * instance IS the feature, so when the engine's own configured endpoint is
 * a private/loopback target we grant private-network access to THIS
 * engine's requests only. Every hop stays SSRF-validated + IP-pinned, and
 * no other engine or web_fetch path is affected. Public SearXNG instances
 * need no allowance (returns false → normal SSRF rules apply).
 */
function engineAllowsPrivate(engine: SearchEngine): boolean {
  if (engine.id !== 'searxng') return false
  try {
    return isPrivateHost(parseHttpUrl(engine.endpoint).host)
  } catch {
    return false
  }
}

/**
 * Run the search chain: iterate engines in configured order, fetching
 * each engine's URL and parsing the body until one yields ≥1 results.
 *
 * Each engine owns its URL shape and parser; this loop only handles
 * the fetch / telemetry / chain-fallthrough bookkeeping.
 */
async function runSearch(flags: CliFlags, config: ParsedConfig): Promise<SearchEntry> {
  const query = String(flags.query ?? '').trim()
  if (!query) {
    return {
      kind: 'search',
      engine: 'chain',
      status: 'unavailable',
      summary: 'missing -q <query>',
      items: [],
      uncertainty: [],
      warnings: [],
      attempts: [{ engine: 'chain', error: 'empty query' }],
    }
  }
  const max = flags.maxResults || config.searchMaxResults
  const override = typeof flags.engine === 'string' && flags.engine !== ''
    ? defaultRegistry.get(flags.engine)
    : undefined
  if (typeof flags.engine === 'string' && flags.engine !== '' && !override) {
    return {
      kind: 'search',
      engine: flags.engine,
      status: 'unavailable',
      summary: `unknown search engine "${flags.engine}"; available: ${defaultRegistry.all().map((e) => e.id).join(', ')}`,
      items: [],
      uncertainty: [],
      warnings: [],
      attempts: [{ engine: flags.engine, error: 'unknown engine id' }],
    }
  }
  const chain: readonly SearchEngine[] = override ? [override] : defaultRegistry.resolve(config.searchEngines)
  const attempts: Array<{ engine: string; error?: string }> = []
  for (const engine of chain) {
    try {
      // Hybrid engines (e.g. GitHub) fan out into several parallel
      // requests and fuse the bodies themselves; classic engines stay
      // on the single-request path.
      const requests = engine.buildRequests?.(query, {
        hasToken: config.githubToken !== '',
        perPage: max,
        indexes: config.githubIndexes,
        sort: config.githubSort,
      })
      if (requests && requests.length > 0 && engine.parseMany) {
        const bodies = await Promise.all(
          requests.map(async (req): Promise<EngineBody> => {
            // A token-gated request with no token configured never hits
            // the network; the engine classifies the synthetic 401 on
            // the same code path as a real one.
            if (req.requiresToken && config.githubToken === '') {
              return { key: req.key, body: '', status: 401, headers: {} }
            }
            try {
              const fetched = await runClientFetch({
                url: req.url,
                timeoutMs: config.searchTimeoutMs,
                maxBytes: config.maxBodyChars,
                maxChars: config.maxBodyChars,
                maxRedirects: config.maxRedirects,
                userAgent: config.userAgent || undefined,
                allowlist: config.allowlist,
                allowPrivateNetwork: flags.allowPrivate || engineAllowsPrivate(engine),
                redirectProtection: flags.redirectProtection,
                protocolLock: flags.protocolLock,
                headers: {
                  ...engine.defaultHeaders,
                  ...(req.headers ?? {}),
                  // Engine values go in first so caller overrides win.
                  ...(config.githubToken !== '' ? { authorization: `Bearer ${config.githubToken}` } : {}),
                  ...(flags.headers ?? {}),
                },
              })
              return { key: req.key, body: fetched.body, status: fetched.status, headers: fetched.headers }
            } catch (error) {
              return { key: req.key, body: '', status: 0, headers: {}, error: (error as Error).message }
            }
          }),
        )
        const result = engine.parseMany(bodies, max)
        if (result.items.length > 0) {
          return {
            kind: 'search',
            engine: engine.id,
            status: 'ok',
            summary: `${result.items.length} sources from ${engine.id}`,
            items: result.items,
            uncertainty: result.uncertainty ?? [],
            warnings: result.warnings ?? [],
            attempts,
          }
        }
        const why = [...(result.warnings ?? []), ...(result.uncertainty ?? [])].join('; ')
        attempts.push({ engine: engine.id, error: why || 'no results in bodies' })
        continue
      }
      const url = engine.buildUrl(query)
      // Search engines need the RAW HTML to run their own parsers, so they
      // talk to the transport layer (`runClientFetch`) directly — never the
      // web_fetch formatting layer.
      const fetched = await runClientFetch({
        url,
        timeoutMs: config.searchTimeoutMs,
        maxBytes: config.maxBodyChars,
        maxChars: config.maxBodyChars,
        maxRedirects: config.maxRedirects,
        userAgent: config.userAgent || undefined,
        allowlist: config.allowlist,
        allowPrivateNetwork: flags.allowPrivate || engineAllowsPrivate(engine),
        redirectProtection: flags.redirectProtection,
        protocolLock: flags.protocolLock,
        // Engine's profile + caller overrides. Engine values go in
        // first so caller overrides win (e.g. user-supplied UA).
        headers: { ...engine.defaultHeaders, ...(flags.headers ?? {}) },
      })
      const sources = engine.parse(fetched.body, max)
      if (sources.length > 0) {
        return {
          kind: 'search',
          engine: engine.id,
          status: 'ok',
          summary: `${sources.length} sources from ${engine.id}`,
          items: sources,
          uncertainty: [],
          warnings: [],
          attempts,
        }
      }
      attempts.push({ engine: engine.id, error: 'no results in body' })
    } catch (error) {
      attempts.push({ engine: engine.id, error: (error as Error).message })
    }
  }
  return {
    kind: 'search',
    engine: 'chain',
    status: 'unavailable',
    summary: `All search engines failed: ${attempts.map((a) => `${a.engine}: ${a.error}`).join('; ')}`,
    items: [],
    uncertainty: [],
    warnings: [],
    attempts,
  }
}

async function runFetch_(flags: CliFlags, config: ParsedConfig, cache?: ResultCache): Promise<FetchEntry> {
  // Paging path: `--cache-id` serves one slice of a previously stored body.
  // No network, no URL required — the cache holds the full body.
  if (typeof flags.cacheId === 'string' && flags.cacheId !== '') {
    const sliced = cache ? cache.slice(flags.cacheId, flags.offset, flags.limit) : null
    if (!sliced) {
      return {
        kind: 'fetch',
        engine: 'undici',
        status: 'unavailable',
        summary: `unknown cacheId "${flags.cacheId}" (server mode only; cache may have been evicted)`,
        content: '',
        links: [],
        uncertainty: [],
        warnings: [],
        statusCode: 0,
        finalUrl: '',
        contentType: '',
        attempts: [{ stage: 'cache', error: 'unknown cacheId' }],
      }
    }
    return {
      kind: 'fetch',
      engine: 'undici',
      status: 'ok',
      summary: `cached content slice [${sliced.slice.start}-${sliced.slice.end}/${sliced.slice.total}] (cacheId ${flags.cacheId})`,
      content: sliced.body,
      links: [],
      uncertainty: [],
      warnings: sliced.slice.more
        ? [`More content: offset ${sliced.slice.end} (limit ${sliced.slice.limit}).`]
        : [],
      statusCode: 200,
      finalUrl: '',
      contentType: '',
      attempts: [],
      cacheId: flags.cacheId,
      contentLength: sliced.slice.total,
      cacheSlice: sliceInfo(sliced.slice),
    }
  }
  const url = String(flags.url ?? '').trim()
  if (!url || !/^https?:\/\//i.test(url)) {
    return {
      kind: 'fetch',
      engine: 'undici',
      status: 'unavailable',
      summary: 'missing or non-http(s) URL',
      content: '',
      links: [],
      uncertainty: [],
      warnings: [],
      statusCode: 0,
      finalUrl: '',
      contentType: '',
      attempts: [{ stage: 'input', error: 'bad URL' }],
    }
  }
  try {
    const r = await fetchPage({
      url,
      format: flags.format,
      timeoutMs: flags.timeoutMs || config.fetchTimeoutMs,
      maxBytes: config.maxBodyChars,
      maxChars: config.maxBodyChars,
      maxRedirects: config.maxRedirects,
      userAgent: config.userAgent || undefined,
      allowlist: config.allowlist,
      allowPrivateNetwork: flags.allowPrivate,
      redirectProtection: flags.redirectProtection,
      protocolLock: flags.protocolLock,
      headers: flags.headers,
    })
    const warnings: string[] = [...r.warnings]
    if (r.truncated) warnings.push(`Content truncated at ${config.maxBodyChars} characters.`)
    if (r.redirectChain.length > 0) warnings.push(`Followed ${r.redirectChain.length} redirect(s) to ${r.finalUrl}.`)
    if (flags.allowPrivate) warnings.push('Private network protection was disabled for this fetch.')
    if (!flags.redirectProtection) warnings.push('Redirect protection was disabled for this fetch (cross-domain hops allowed).')
    if (!flags.protocolLock) warnings.push('Protocol lock was disabled for this fetch (http/https switches allowed).')
    const uncertainty: string[] = []
    if (r.content.length < 200) uncertainty.push('Very little text came back. The page is probably JS-rendered; this fetch did not run JavaScript.')
    // Dedup: a warm cache hit for the same URL+format skips the network.
    const dedupKey = `fetch|${flags.format}|${r.finalUrl}`
    const cached = cache ? cache.getByKey(dedupKey) : undefined
    if (cached) {
      const hitWarnings = [...warnings]
      // Over-cap hits must keep the degrade shape (preview + cacheId) —
      // returning cached.content verbatim reinstated the full body.
      const served = serveCachedEntry(cached, hitWarnings)
      return {
        kind: 'fetch',
        engine: 'undici',
        status: 'ok',
        summary: `${r.title ?? r.finalUrl} (cached, HTTP ${r.statusCode} ${r.statusText})`,
        content: served.content,
        links: r.links,
        uncertainty,
        warnings: hitWarnings,
        statusCode: r.statusCode,
        finalUrl: r.finalUrl,
        contentType: r.contentType,
        attempts: [],
        cacheId: cached.id,
        contentLength: served.contentLength,
      }
    }
    const degraded = applyCacheToFetch(
      {
        content: r.content,
        contentType: r.contentType,
        finalUrl: r.finalUrl,
        warnings,
      },
      cache,
      dedupKey,
    )
    return {
      kind: 'fetch',
      engine: 'undici',
      status: 'ok',
      summary: `${r.title ?? r.finalUrl} (undici fetch, HTTP ${r.statusCode} ${r.statusText})`,
      content: degraded.content,
      links: r.links,
      uncertainty,
      warnings,
      statusCode: r.statusCode,
      finalUrl: r.finalUrl,
      contentType: r.contentType,
      attempts: [],
      cacheId: degraded.cacheId,
      contentLength: degraded.contentLength,
    }
  } catch (error) {
    return {
      kind: 'fetch',
      engine: 'undici',
      status: 'unavailable',
      summary: (error as Error).message,
      content: '',
      links: [],
      uncertainty: [],
      warnings: [],
      statusCode: 0,
      finalUrl: '',
      contentType: '',
      attempts: [{ stage: 'fetch', error: (error as Error).message }],
    }
  }
}

async function runHttp(flags: CliFlags, config: ParsedConfig, cache?: ResultCache): Promise<HttpEntry> {
  // Paging path: `--cache-id` serves one slice of a previously stored body.
  if (typeof flags.cacheId === 'string' && flags.cacheId !== '') {
    const sliced = cache ? cache.slice(flags.cacheId, flags.offset, flags.limit) : null
    if (!sliced) {
      return {
        kind: 'http',
        engine: 'undici-direct',
        status: 'unavailable',
        summary: `unknown cacheId "${flags.cacheId}" (server mode only; cache may have been evicted)`,
        body: '',
        headers: [],
        statusCode: 0,
        statusText: '',
        contentType: '',
        finalUrl: '',
        attempts: [{ stage: 'cache', error: 'unknown cacheId' }],
      }
    }
    return {
      kind: 'http',
      engine: 'undici-direct',
      status: 'ok',
      summary: `cached body slice [${sliced.slice.start}-${sliced.slice.end}/${sliced.slice.total}] (cacheId ${flags.cacheId})`,
      body: sliced.body,
      headers: [],
      statusCode: 200,
      statusText: 'OK',
      contentType: '',
      finalUrl: '',
      attempts: [],
      cacheId: flags.cacheId,
      contentLength: sliced.slice.total,
      cacheSlice: sliceInfo(sliced.slice),
    }
  }
  const url = String(flags.url ?? '').trim()
  const method = String(flags.method ?? 'GET').toUpperCase()
  if (!url) {
    return {
      kind: 'http',
      engine: 'undici-direct',
      status: 'unavailable',
      summary: 'missing URL',
      body: '',
      headers: [],
      statusCode: 0,
      statusText: '',
      contentType: '',
      finalUrl: '',
      attempts: [{ stage: 'input', error: 'missing URL' }],
    }
  }
  try {
    const r = await runHttpRequest({
      url,
      method,
      headers: flags.headers,
      body: flags.body,
      contentType: flags.contentType,
      timeoutMs: flags.timeoutMs || config.httpTimeoutMs,
      followRedirects: flags.followRedirects,
      maxBytes: config.maxBodyChars,
      maxChars: config.maxBodyChars,
      userAgent: config.userAgent || undefined,
      allowlist: config.allowlist,
      allowPrivateNetwork: flags.allowPrivate,
      redirectProtection: flags.redirectProtection,
      protocolLock: flags.protocolLock,
    })
    const httpWarnings: string[] = []
    if (r.meta.truncated) httpWarnings.push(`Body truncated at ${r.meta.maxChars} characters.`)
    if (r.meta.redirectChain.length > 0) httpWarnings.push(`Followed ${r.meta.redirectChain.length} redirect(s) to ${r.finalUrl}.`)
    if (flags.allowPrivate) httpWarnings.push('Private network protection was disabled for this request.')
    if (!flags.redirectProtection) httpWarnings.push('Redirect protection was disabled for this request (cross-domain hops allowed).')
    if (!flags.protocolLock) httpWarnings.push('Protocol lock was disabled for this request (http/https switches allowed).')
    // Dedup: a warm cache hit for the same method+URL skips the network.
    const dedupKey = `http|${method}|${r.finalUrl}`
    const cached = cache ? cache.getByKey(dedupKey) : undefined
    if (cached) {
      const hitWarnings = [...httpWarnings]
      // Same degrade shape as the fetch dedup path: over-cap entries must
      // come back as preview + cacheId, never the full body inline.
      const served = serveCachedEntry(cached, hitWarnings)
      return {
        kind: 'http',
        engine: 'undici-direct',
        status: 'ok',
        summary: `HTTP ${r.status} ${method} ${r.finalUrl} (cached)`,
        body: served.content,
        headers: r.headers,
        statusCode: r.status,
        statusText: r.statusText,
        contentType: r.contentType,
        finalUrl: r.finalUrl,
        attempts: [],
        cacheId: cached.id,
        contentLength: served.contentLength,
      }
    }
    const degraded = applyCacheToHttp(
      {
        body: r.body,
        contentType: r.contentType,
        finalUrl: r.finalUrl,
        warnings: httpWarnings,
      },
      cache,
      dedupKey,
    )
    return {
      kind: 'http',
      engine: 'undici-direct',
      status: 'ok',
      summary: `HTTP ${r.status} ${method} ${r.finalUrl}`,
      body: degraded.body,
      headers: r.headers,
      statusCode: r.status,
      statusText: r.statusText,
      contentType: r.contentType,
      finalUrl: r.finalUrl,
      attempts: [],
      cacheId: degraded.cacheId,
      contentLength: degraded.contentLength,
    }
  } catch (error) {
    return {
      kind: 'http',
      engine: 'undici-direct',
      status: 'unavailable',
      summary: (error as Error).message,
      body: '',
      headers: [],
      statusCode: 0,
      statusText: '',
      contentType: '',
      finalUrl: '',
      attempts: [{ stage: 'http_request', error: (error as Error).message }],
    }
  }
}

/**
 * Web sitemap lookup. Pure (no I/O); the data lives in `sitemap.ts`.
 *
 * Modes:
 *   - `dsh-network sitemap`                       → top-N by priority
 *   - `dsh-network sitemap -q "rust package"`     → fuzzy match
 *   - `dsh-network sitemap --domain github.com`   → exact lookup
 *   - `dsh-network sitemap -c ai-platforms`       → category filter
 *   - `dsh-network sitemap -p 9`                  → priority threshold
 *   - `dsh-network sitemap --digest`              → include Markdown digest
 *   - `dsh-network sitemap --domain github.com -q "rust"` → resolve search URL
 */
async function runSitemap(flags: CliFlags): Promise<SitemapEntry> {
  const limit = flags.maxResults || 10
  const attempts: Array<{ stage: string; error?: string }> = []
  const warnings: string[] = []
  const uncertainty: string[] = []
  let entries: WebSitemapEntry[] = []
  let resolved: Array<{ domain: string; query: string; url: string }> = []
  try {
    if (flags.sitemapDomain) {
      const direct = findByDomain(flags.sitemapDomain)
      if (!direct) {
        return {
          kind: 'sitemap',
          engine: 'web_sitemap',
          status: 'unavailable',
          summary: `no entry for domain "${flags.sitemapDomain}"`,
          entries: [],
          resolved: [],
          uncertainty: [],
          warnings: [],
          attempts: [{ stage: 'lookup', error: 'unknown domain' }],
        }
      }
      entries = [direct]
      if (typeof flags.query === 'string' && flags.query.trim() !== '') {
        const url = buildSearchUrl(direct.domain, flags.query)
        if (url) resolved = [{ domain: direct.domain, query: flags.query, url }]
        else uncertainty.push(`domain "${direct.domain}" has no search-URL template`)
      }
    } else if (flags.sitemapCategory) {
      // Validate the category label before filtering so the user gets
      // a useful error instead of a silent empty list.
      const known = new Set<string>(categoriesInUse())
      if (!known.has(flags.sitemapCategory)) {
        attempts.push({ stage: 'category', error: `unknown category "${flags.sitemapCategory}"` })
        return {
          kind: 'sitemap',
          engine: 'web_sitemap',
          status: 'unavailable',
          summary: `unknown category "${flags.sitemapCategory}"; valid: ${categoriesInUse().join(', ')}`,
          entries: [],
          resolved: [],
          uncertainty: [],
          warnings: [],
          attempts,
        }
      }
      entries = listByCategory(flags.sitemapCategory)
      if (typeof flags.sitemapMinPriority === 'number') {
        entries = entries.filter((e) => e.priority >= flags.sitemapMinPriority!)
      }
      entries = entries.slice(0, limit)
    } else {
      entries = searchSitemap(flags.query ?? '', {
        minPriority: flags.sitemapMinPriority,
        limit,
      })
    }
  } catch (error) {
    return {
      kind: 'sitemap',
      engine: 'web_sitemap',
      status: 'unavailable',
      summary: (error as Error).message,
      entries: [],
      resolved: [],
      uncertainty,
      warnings,
      attempts: [{ stage: 'sitemap', error: (error as Error).message }],
    }
  }
  if (entries.length === 0) uncertainty.push('no entries matched the requested filter')
  return {
    kind: 'sitemap',
    engine: 'web_sitemap',
    status: 'ok',
    summary: `${entries.length} portal(s)${resolved.length ? `, ${resolved.length} search URL(s)` : ''}`,
    entries: entries.map(summarize),
    resolved,
    digest: flags.sitemapDigest ? renderPromptDigest({
      category: flags.sitemapCategory,
      minPriority: flags.sitemapMinPriority,
    }) : undefined,
    uncertainty,
    warnings,
    attempts,
  }
}

async function doctor(config: ParsedConfig): Promise<SearchEntry> {
  // No network, no quota: report the resolved config and reachable engines.
  const github = config.githubIndexes.length > 0 ? `indexes=${config.githubIndexes.join(',')}` : 'indexes=auto'
  const searxngUrl = defaultRegistry.get('searxng')?.endpoint ?? 'unset'
  return {
    kind: 'search',
    engine: 'doctor',
    status: 'ok',
    summary: `engines=${config.searchEngines.join(',')} fetchTimeoutMs=${config.fetchTimeoutMs} httpTimeoutMs=${config.httpTimeoutMs} allowlist=${config.allowlist.length} githubToken=${config.githubToken !== '' ? 'set' : 'unset'} github${github}${config.githubSort ? ` sort=${config.githubSort}` : ''} searxngUrl=${searxngUrl} sitemap=${WEB_SITEMAP.length}`,
    items: [],
    uncertainty: [],
    warnings: [],
    attempts: [],
  }
}

export interface RunContext {
  /** Shared result cache (only present in server mode). */
  cache?: ResultCache
  /** Per-invoke env snapshot overriding `process.env` for this run. */
  env?: NodeJS.ProcessEnv
}

/**
 * Run exactly one job from argv and return the structured envelope — the
 * shared core behind both the single-shot CLI (`main`) and the persistent
 * server (`POST /invoke`).
 */
export async function runOnce(argv: string[], ctx?: RunContext): Promise<Envelope> {
  const started = Date.now()
  const flags = parseFlags(argv)
  if (flags.showHelp) {
    return { ok: true, results: [], elapsedMs: 0, help: helpText() }
  }
  const config = loadConfig(ctx?.env ?? process.env)
  let entry: Entry
  if (flags.mode === 'search') entry = await runSearch(flags, config)
  else if (flags.mode === 'fetch') entry = await runFetch_(flags, config, ctx?.cache)
  else if (flags.mode === 'http') entry = await runHttp(flags, config, ctx?.cache)
  else if (flags.mode === 'sitemap') entry = await runSitemap(flags)
  else if (flags.mode === 'doctor') entry = await doctor(config)
  else entry = await runFetch_(flags, config, ctx?.cache)

  return {
    ok: entry.status === 'ok',
    results: [entry],
    elapsedMs: Date.now() - started,
  }
}

function failedEnvelope(error: unknown): Envelope {
  return {
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
      } as SearchEntry,
    ],
    elapsedMs: 0,
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  if (flags.showHelp) {
    process.stdout.write(helpText() + '\n')
    return
  }
  if (flags.mode === 'server') {
    // Dynamic import avoids a static import cycle (server.ts imports runOnce
    // from this module).
    const { startServer } = await import('./server.ts')
    await startServer({ port: flags.serverPort, stdinWatch: true })
    return
  }
  const envelope = await runOnce(process.argv.slice(2))
  process.stdout.write(JSON.stringify(envelope) + '\n')
}

main().catch((error) => {
  process.stdout.write(JSON.stringify(failedEnvelope(error)) + '\n')
  process.exit(2)
})
