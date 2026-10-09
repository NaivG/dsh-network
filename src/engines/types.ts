/**
 * dsh-network search engine types — interface and registry contract.
 *
 * One engine = one search source (Bing, DuckDuckGo, Baidu, or any future
 * addition). An engine owns:
 *
 *   - id + display name (registry keys)
 *   - the endpoint host (for SSRF allowlist display and logging)
 *   - defaultHeaders (the Firefox-flavoured request profile)
 *   - buildUrl(query, options?) → string  (URL composition)
 *   - parse(html, max) → SearchSource[]   (HTML → results)
 *
 * Engines do NOT own the fetch pipeline. The CLI calls `runClientFetch(...)`
 * with the engine's URL + headers, then hands the raw body to the engine's
 * `parse`. SSRF guards, retries, and telemetry stay in cli.ts / client.ts.
 *
 * Adding a new engine is two steps:
 *   1. Create `src/engines/<name>.ts` exporting a class implementing
 *      [SearchEngine].
 *   2. Add it to `engines/index.ts` and call `registry.register(...)`
 *      inside `registerDefaultEngines()`.
 */
import { appendQuery } from '../network.ts'
import { cleanHtmlText } from '../html-extract.ts'

/** One search hit: a URL, its title, and an optional snippet. */
export interface SearchSource {
  url: string
  title: string
  snippet?: string
  /**
   * Publication date, when the engine's JSON response carries one (Brave's
   * `page_age`). Snake_case because this is the CLI envelope's wire shape:
   * `toSearchSources` in the host maps it to the seam's `publishedAt` and
   * both renderSearchEvidence / renderSearchSourceItem show it. Optional on
   * purpose — engines that only scrape HTML leave it undefined.
   */
  published_at?: string
}

/**
 * Env knobs the CLI reads for the keyed engines, paired with HOW the
 * credential rides on a request. Declaring it on the engine keeps the
 * per-provider quirk (Brave's `X-Subscription-Token` vs a Bearer token)
 * inside the engine while the CLI stays the only actor that ever holds the
 * secret — the engine sees `options.hasApiKey`, never the key itself.
 *
 * Engines WITHOUT an `auth` block are the keyless HTML scrapers, whose
 * reachability is checked by fetching rather than by a token.
 */
export interface EngineAuth {
  /** Header the credential travels in (case-insensitive on the wire). */
  readonly header: string
  /** Header value format: `raw` (default) or `bearer` (prepends `Bearer `). */
  readonly scheme?: 'raw' | 'bearer'
  /**
   * Env var the CLI resolves the key from. `DSH_NETWORK_SEARCH_ENGINE_API_KEYS`
   * (a JSON `{ engineId: key }` map the host builds per invoke) is always
   * consulted first; this name is the single-engine override a caller can set
   * by hand, so `dsh-network search --engine brave` works standalone.
   */
  readonly apiKeyEnv: string
}

/**
 * One request produced by a hybrid engine's `buildRequests`. The CLI
 * fetches every request in parallel and hands the collected bodies to
 * `parseMany`. `buildUrl`/`parse` (single-request path) stay untouched.
 */
export interface EngineRequest {
  /** Index label, e.g. 'repositories' | 'code' | 'issues'. Surfaced in logs. */
  key: string
  /** Absolute URL to fetch. */
  url: string
  /** Optional per-request header overrides (merged over defaultHeaders). */
  headers?: Record<string, string>
  /**
   * When true the request needs `Authorization` (e.g. GitHub code search).
   * The CLI skips the network call when no token is configured and passes
   * a synthetic 401 body into `parseMany` so the engine's error
   * classification stays on one code path.
   */
  requiresToken?: boolean
}

/**
 * Body result handed to `parseMany`. One entry per request from
 * `buildRequests`, in the same order. A request that never reached the
 * network (no token, fetch failure) arrives with `status: 0` and an
 * `error` describing why.
 */
export interface EngineBody {
  key: string
  body: string
  status?: number
  headers?: Record<string, string>
  /** Non-transport failure (skipped before fetch / fetch threw). */
  error?: string
}

/** Structured result of a hybrid engine's `parseMany`. */
export interface EngineParseResult {
  items: SearchSource[]
  /** Operational notes surfaced to the caller (rate limited, auth skipped…). */
  warnings?: string[]
  /** Epistemic flags (incomplete_results, degraded metadata…). */
  uncertainty?: string[]
}

/**
 * A search engine that knows its own URL shape, headers, and parser.
 *
 * The implementation must be:
 *   - Sync for `buildUrl`/`parse`/`buildRequests`/`parseMany` (no I/O —
 *     engines stay pure)
 *   - Dependency-free (no network, no fs) — engines live in the CLI bundle
 *     alongside everything else
 *
 * Engines never call `fetch` themselves. The CLI iterates the registry and
 * uses the engine to build URL + headers; the engine only knows how to
 * parse the body that comes back.
 *
 * Two execution paths:
 *   - Single-request engines implement `buildUrl` + `parse` (Bing/DDG/Baidu).
 *   - Hybrid engines MAY additionally implement `buildRequests` +
 *     `parseMany`; when present the CLI uses the multi-request path and
 *     never calls `buildUrl`/`parse`.
 */
export interface SearchEngine {
  readonly id: string
  readonly displayName: string
  /** The endpoint host the engine hits; surfaced for SSRF allowlists. */
  readonly endpoint: string

  /**
   * OPTIONAL — keyed engines only (Brave, …). Declares the credential
   * header and the env var the CLI resolves the key from. Present means the
   * CLI sends no request at all when the key is missing: it synthesizes an
   * auth-failure body so the engine classifies it on the same code path as
   * a real 401/403 (the `requiresToken` trick GitHub uses, generalized).
   */
  readonly auth?: EngineAuth

  /**
   * Browser-shaped request headers. The CLI passes these to `runClientFetch`
   * unchanged. Order does not matter; case does (HTTP/2 lowercases).
   */
  readonly defaultHeaders: Readonly<Record<string, string>>

  /**
   * Compose the search URL for a query. Engine-specific query params
   * (Bing's `pc=MOZI`, Baidu's `ie=utf-8`) live here, not in the CLI.
   *
   * @param query   raw search query
   * @param options extra query params the caller wants to inject
   */
  buildUrl(query: string, options?: Readonly<Record<string, string>>): string

  /**
   * Parse the HTML body into at most `max` results. Returning zero
   * triggers the next engine in the chain. The CLI never sees a partial
   * success — it is all-or-nothing per engine.
   *
   * @param html  the raw HTML body returned by `runClientFetch`
   * @param max   upper bound on returned items
   */
  parse(html: string, max: number): SearchSource[]

  /**
   * OPTIONAL — hybrid engines only. Turn one query into multiple parallel
   * requests (e.g. GitHub repositories + code + issues). The CLI fetches
   * them concurrently and calls `parseMany` with the bodies. When absent,
   * the CLI uses the single-request `buildUrl`/`parse` path.
   *
   * @param query   raw search query
   * @param options context the caller wants to inject (see GitHub engine
   *                for the `hasToken` flag it consumes)
   */
  buildRequests?(query: string, options?: Readonly<Record<string, unknown>>): EngineRequest[]

  /**
   * OPTIONAL — hybrid engines only. Fuse the parallel responses into at
   * most `max` ranked results (e.g. weighted RRF across indexes). Called
   * whenever `buildRequests` is present, even when every body failed —
   * the engine classifies errors and reports them via `warnings`.
   *
   * @param bodies  one entry per `buildRequests` request, same order
   * @param max     upper bound on returned items
   */
  parseMany?(bodies: EngineBody[], max: number): EngineParseResult
}

/**
 * In-process registry of search engines. The CLI maintains one across
 * the whole process; engines can be added at boot from `index.ts` or by
 * a plugin via the dsh host's tool registry.
 *
 * Registration order matters: the first engine registered becomes the
 * `fallback` used when no engine list is configured.
 */
export class SearchEngineRegistry {
  private readonly engines: SearchEngine[] = []
  private readonly byId = new Map<string, SearchEngine>()

  /** Add an engine. Same id overwrites; we do not allow duplicates. */
  register(engine: SearchEngine): void {
    const existing = this.byId.get(engine.id)
    if (existing) {
      const idx = this.engines.indexOf(existing)
      if (idx >= 0) this.engines.splice(idx, 1)
    }
    this.engines.push(engine)
    this.byId.set(engine.id, engine)
  }

  /** Look up by id; returns undefined when the id is unknown. */
  get(id: string): SearchEngine | undefined {
    return this.byId.get(id)
  }

  /** True when the id is registered. */
  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** All registered engines in insertion order. */
  all(): readonly SearchEngine[] {
    return this.engines
  }

  /** First registered engine; the default fallback when none configured. */
  fallback(): SearchEngine {
    const first = this.engines[0]
    if (!first) throw new Error('SearchEngineRegistry has no engines registered')
    return first
  }

  /**
   * Resolve a configured engine list (in user order), skipping unknown
   * ids. Returns the engines actually chosen, in chain order. If the
   * filtered list is empty, falls back to `fallback()`.
   */
  resolve(ids: readonly string[]): readonly SearchEngine[] {
    const resolved: SearchEngine[] = []
    for (const id of ids) {
      const e = this.byId.get(id)
      if (e) resolved.push(e)
    }
    return resolved.length > 0 ? resolved : [this.fallback()]
  }
}

/**
 * Strip HTML tags from a string. Used by every engine's parser because
 * we do not pull in an HTML DOM library — regex parsing keeps the
 * engines dependency-free.
 *
 * Tag-stripping alone is NOT safe for anything a human or a model reads:
 * the leftover text still carries character references (`&nbsp;`,
 * `&#x27;`, `&amp;`). Every title/snippet extraction goes through
 * `cleanText` below instead; this stays exported for structural callers
 * (URL fragments) where a text decode would be wrong.
 */
export function stripTags(s: string): string {
  return String(s).replace(/<[^>]*>/g, '')
}

/**
 * `stripTags` + entity decode + whitespace collapse — the one way an
 * engine turns a markup fragment into text.
 *
 * Skipping the decode is how `&amp;NBSP HTML: Examples` reached a result
 * card, a `web_search` answer and the model's own reply: the engines
 * handed raw references straight through and everything downstream
 * rendered them literally.
 */
export function cleanText(html: string): string {
  return cleanHtmlText(html)
}

/** Decode a base64url string (Bing `u=a1<...>` redirect). */
export function b64UrlDecode(s: string): string | null {
  try {
    const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))
    if (bin.length === 0) return null
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return null
  }
}

/**
 * Small helper used by every engine's `buildUrl`: encode the query,
 * append engine-specific params, return the full URL.
 */
export function composeEngineUrl(endpoint: string, primaryKey: string, primaryValue: string, extras?: Record<string, string>): string {
  return appendQuery(endpoint, { [primaryKey]: primaryValue, ...(extras ?? {}) })
}

/**
 * Read one engine's per-engine options out of `DSH_NETWORK_ENGINE_OPTIONS`.
 *
 * The host serializes the settings UI's free-form `options` textarea (one
 * JSON map, `{ engineId: { ... } }`) into that env var on every `/invoke`,
 * so a user can target `country=DE` / `freshness=pw` at one engine without
 * a schema change or a CLI restart. Pure, sync, never throws: a malformed
 * value degrades to "no options", exactly like an unset one.
 */
export function readEngineEnvOptions(
  engineId: string,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, unknown>> {
  const raw = env.DSH_NETWORK_ENGINE_OPTIONS
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const perEngine = (parsed as Record<string, unknown>)[engineId]
  if (!perEngine || typeof perEngine !== 'object' || Array.isArray(perEngine)) return {}
  return perEngine as Record<string, unknown>
}
