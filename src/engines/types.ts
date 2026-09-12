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

/** One search hit: a URL, its title, and an optional snippet. */
export interface SearchSource {
  url: string
  title: string
  snippet?: string
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
 */
export function stripTags(s: string): string {
  return String(s).replace(/<[^>]*>/g, '')
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
