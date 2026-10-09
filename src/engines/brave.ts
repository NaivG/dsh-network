/**
 * BraveSearchEngine — Brave Search API, the first keyed engine.
 *
 * Endpoint: `https://api.search.brave.com/res/v1/web/search`
 * Auth: `X-Subscription-Token: <key>` (the key never rides in the URL).
 *
 * Verified against the official docs (2026-10):
 *   - GET only; `q` is required, `count` caps at 20 (default 20),
 *     `offset` is 0-based and caps at 9, `country` is a 2-letter code,
 *     `search_lang` / `ui_lang`, `freshness` ∈ pd|pw|pm|py|<from>to<to>,
 *     `safesearch` ∈ off|moderate|strict, `extra_snippets=true` adds up to
 *     5 alternative excerpts per hit, `goggles` re-ranks.
 *   - Success body: `{ query: { more_results_available }, web: { results:
 *     [ { url, title, description, page_age, extra_snippets, … } ] } }`.
 *     `page_age` is an ISO-8601 timestamp — it lands in `published_at`,
 *     the field the host's search card and evidence renderer show.
 *   - A zero-hit query is NOT an error: Brave answers 200 with an empty
 *     `web.results` (this engine therefore reports zero items and lets the
 *     chain fall through, like every other engine).
 *
 * Auth handling: the engine never holds the key. The CLI resolves
 * `DSH_NETWORK_SEARCH_ENGINE_API_KEYS['brave']` (host-injected per invoke)
 * or the single-engine `DSH_NETWORK_BRAVE_API_KEY` override, then injects
 * the `X-Subscription-Token` header declared by `auth` below. With no key
 * the CLI skips the network call entirely and synthesizes a 401 body, so
 * the "missing key" classification lives on the same code path as a real
 * rejected one.
 *
 * FREE TIER: Brave removed its free tier (Feb 2026) — every query is
 * billed. That is why this engine is registered LAST and never added to
 * the default chain: it runs only when the user puts it in the engine list
 * or pins it with `engine: 'brave'`.
 */
import {
  type EngineAuth,
  type EngineBody,
  type EngineParseResult,
  type EngineRequest,
  type SearchEngine,
  type SearchSource,
  composeEngineUrl,
  readEngineEnvOptions,
} from './index.ts'

export const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/** Single-engine env override (the host also injects the shared keys map). */
export const BRAVE_API_KEY_ENV = 'DSH_NETWORK_BRAVE_API_KEY'

/** The API answers to this header name; the CLI is what fills it in. */
export const BRAVE_AUTH_HEADER = 'X-Subscription-Token'

/** Brave rejects `count` above 20 and `offset` above 9. */
const MAX_COUNT = 20
const MAX_OFFSET = 9

const SNIPPET_CAP = 300
const TITLE_CAP = 200

const FRESHNESS = ['pd', 'pw', 'pm', 'py']
const SAFESEARCH = ['off', 'moderate', 'strict']

/** Loose JSON parse (tolerates a BOM / leading whitespace). */
function parseJsonLoose(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(body ?? '').replace(/^\uFEFF/, '').trim())
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Extract Brave's error text, if the body is JSON.
 *
 * Verified shape (live probe, 2026-10):
 *   { "error": { "code": "VALIDATION",
 *                "detail": "Unable to validate request parameter(s)",
 *                "meta": { "errors": [ { "loc": ["header","x-subscription-token"],
 *                                        "msg": "Field required", "type": "missing" } ] },
 *                "status": 422 },
 *     "type": "ErrorResponse" }
 * so the actionable half is `error.meta.errors[*].msg` (and its `loc`),
 * not the generic top-level `detail`.
 */
function errorBodyMessage(body: string): string {
  const parsed = parseJsonLoose(body)
  if (!parsed) return ''
  const error = parsed.error
  // FastAPI-style shape above.
  if (error && typeof error === 'object') {
    const errObj = error as Record<string, unknown>
    // The `meta.errors` detail-list is the actionable half when present.
    const meta = errObj.meta
    const errors = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).errors : undefined
    if (Array.isArray(errors) && errors.length > 0) {
      const parts: string[] = []
      for (const entry of errors.slice(0, 3)) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as Record<string, unknown>
        const loc = Array.isArray(e.loc) ? e.loc.map((p) => String(p)).join('.') : ''
        const msg = typeof e.msg === 'string' ? e.msg : ''
        if (msg) parts.push(loc ? `${loc}: ${msg}` : msg)
      }
      if (parts.length > 0) return parts.join('; ')
    }
    if (typeof errObj.detail === 'string') return errObj.detail
    if (typeof errObj.message === 'string') return errObj.message
    if (typeof errObj.code === 'string') return errObj.code
  }
  if (typeof error === 'string') return error
  if (typeof parsed.message === 'string') return parsed.message
  return ''
}

/**
 * True when Brave's validation complaint is about the credential rather
 * than the query. Brave answers 422 (never 401) for both a missing
 * `x-subscription-token` and an invalid one — verified live, twice:
 *   - no header   → errors[].loc = ["header","x-subscription-token"]
 *   - bogus value → `The provided API key is invalid.`
 * Without this check a key problem would be reported as "check your query",
 * which is the exact wrong advice. A query-validation body never mentions
 * the API key, so the sniff stays one-directional.
 */
function isAuthComplaint(body: string): boolean {
  return /x-subscription-token|api key/i.test(String(body ?? ''))
}

/** Whitespace-collapse + cap a string. */
function clip(s: string, cap = SNIPPET_CAP): string {
  const clean = String(s ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean
}

/**
 * Accept a `page_age` value only when it is a plausible ISO-8601 timestamp.
 *
 * Brave's own example says `page_age` is ISO-8601, but real responses also
 * carry broken values — a live query returned `1970-01-19T20:35:52` for a
 * page that is certainly not from 1970 (an upstream epoch-seconds field
 * being read as milliseconds). Passing that through puts a nonsense date in
 * the model's evidence and on the search card, and a wrong date is worse
 * than no date. Non-ISO shapes (`3 days ago`) are dropped for the same
 * reason: the renderer prints the raw string.
 */
function plausiblePublishedAt(raw: unknown): string {
  const value = String(raw ?? '').trim()
  const match = /^(\d{4})-\d{2}-\d{2}T/.exec(value)
  if (!match) return ''
  const year = Number(match[1])
  const nextYear = new Date().getUTCFullYear() + 1
  if (year < 1990 || year > nextYear) return ''
  return value
}

/**
 * `count` for the request. The CLI passes the call's result cap as
 * `perPage` (that is what the host sends for every engine); `max` is the
 * standalone path's spelling of the same thing. The server-provided value
 * wins so a per-call `count` argument is honored.
 */
function clampCount(perPage: unknown, max: unknown): number {
  const raw = typeof perPage === 'number' && Number.isFinite(perPage) ? perPage : max
  const v = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 20
  if (v < 1) return 1
  return Math.min(v, MAX_COUNT)
}

/**
 * Compose the `/res/v1/web/search` URL. Pure and sync — every option is
 * validated here so a typo in the settings textarea drops the parameter
 * instead of burning a billed request on a 422.
 */
export function buildBraveUrl(
  query: string,
  options?: Readonly<Record<string, unknown>>,
): string {
  const opts = options ?? {}
  const extras: Record<string, string> = {
    count: String(clampCount(opts.perPage, opts.max)),
    extra_snippets: 'true',
  }

  const offset = Number(opts.offset)
  if (Number.isInteger(offset) && offset > 0 && offset <= MAX_OFFSET) {
    extras.offset = String(offset)
  }

  const country = typeof opts.country === 'string' ? opts.country.trim().toUpperCase() : ''
  if (/^[A-Z]{2}$/.test(country)) extras.country = country

  const searchLang = typeof opts.searchLang === 'string' ? opts.searchLang.trim() : ''
  if (searchLang !== '') extras.search_lang = searchLang

  const uiLang = typeof opts.uiLang === 'string' ? opts.uiLang.trim() : ''
  if (uiLang !== '') extras.ui_lang = uiLang

  const freshness = typeof opts.freshness === 'string' ? opts.freshness.trim() : ''
  if (FRESHNESS.includes(freshness) || /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(freshness)) {
    extras.freshness = freshness
  }

  const safesearch = typeof opts.safesearch === 'string' ? opts.safesearch.trim().toLowerCase() : ''
  if (SAFESEARCH.includes(safesearch)) extras.safesearch = safesearch

  // Goggles must be a URL or an inline definition. Only http(s) URLs are
  // passed through: an inline `$discard`-style rule is a legitimate Brave
  // feature but arbitrary text in a query param is not worth the surprise.
  const goggles = typeof opts.goggles === 'string' ? opts.goggles.trim() : ''
  if (/^https?:\/\/[^\s]+$/i.test(goggles)) extras.goggles = goggles

  return composeEngineUrl(BRAVE_ENDPOINT, 'q', query, extras)
}

export class BraveSearchEngine implements SearchEngine {
  readonly id = 'brave'
  readonly displayName = 'Brave Search'
  readonly endpoint = BRAVE_ENDPOINT

  readonly auth: EngineAuth = {
    header: BRAVE_AUTH_HEADER,
    scheme: 'raw',
    apiKeyEnv: BRAVE_API_KEY_ENV,
  }

  /**
   * Deliberately minimal, and deliberately NOT a browser fingerprint: this
   * is a JSON API, so there is no HTML/anti-bot profile to match (unlike
   * Bing/Baidu, which answer real Firefox headers). Only the JSON accept is
   * set; the CLI merges `config.userAgent` over it when the user set one.
   */
  readonly defaultHeaders: Readonly<Record<string, string>> = {
    Accept: 'application/json',
  }

  /**
   * The options the settings UI's free-form textarea carries for this
   * engine (`{ "country": "DE", … }`). Read at request time so a UI edit
   * lands on the next search without restarting the server.
   */
  private envOptions(): Readonly<Record<string, unknown>> {
    return readEngineEnvOptions(this.id)
  }

  /** Single-request compatibility path (parity with the scrapers). */
  buildUrl(query: string, options?: Readonly<Record<string, string>>): string {
    return buildBraveUrl(query, { ...this.envOptions(), ...(options ?? {}) })
  }

  buildRequests(query: string, options?: Readonly<Record<string, unknown>>): EngineRequest[] {
    const q = String(query ?? '').trim()
    if (q.length === 0) return []
    const merged = { ...this.envOptions(), ...(options ?? {}) }
    return [{ key: 'brave', url: buildBraveUrl(q, merged) }]
  }

  parseMany(bodies: EngineBody[], max: number): EngineParseResult {
    const warnings: string[] = []
    const uncertainty: string[] = []
    const items: SearchSource[] = []

    for (const body of bodies) {
      // Transport-level failure (fetch threw / never sent).
      if (body.error) {
        warnings.push(`brave: ${body.error}`)
        continue
      }

      const status = body.status ?? 0

      // Auth: a real 401/403, or the CLI-synthesized 401 for a missing key.
      // Brave ALSO answers 422 when the `x-subscription-token` header is
      // absent (verified with a live probe), so the 422 branch below checks
      // whether the complaint names the credential.
      if (status === 401 || status === 403 || (status === 422 && isAuthComplaint(body.body))) {
        const msg = errorBodyMessage(body.body)
        warnings.push(
          `brave: authentication failed (HTTP ${status}${msg ? ` — ${clip(msg, 120)}` : ''}). ` +
            'Set the Brave Search API key in 网络 → 搜索引擎 (or DSH_NETWORK_BRAVE_API_KEY). ' +
            'Brave has no free tier: every query is billed.',
        )
        continue
      }

      if (status === 429) {
        const msg = errorBodyMessage(body.body)
        warnings.push(
          `brave: rate limited (HTTP 429${msg ? ` — ${clip(msg, 120)}` : ''}); check the plan quota on the Brave dashboard`,
        )
        continue
      }

      if (status === 422) {
        const msg = errorBodyMessage(body.body)
        warnings.push(
          `brave: query rejected (422${msg ? ` — ${clip(msg, 120)}` : ''}) — check the query and the engine options`,
        )
        continue
      }

      if (status !== 0 && status !== 200) {
        const msg = errorBodyMessage(body.body)
        warnings.push(`brave: unexpected HTTP ${status}${msg ? ` — ${clip(msg, 120)}` : ''}`)
        continue
      }

      const parsed = parseJsonLoose(body.body)
      if (!parsed) {
        warnings.push('brave: response was not JSON')
        continue
      }

      const web = parsed.web
      const results = web && typeof web === 'object' && Array.isArray((web as Record<string, unknown>).results)
        ? ((web as Record<string, unknown>).results as unknown[])
        : []
      // An object without `web` is a valid empty answer (zero hits); a
      // completely foreign body is worth flagging instead.
      if (results.length === 0 && !('web' in parsed)) {
        warnings.push('brave: unexpected response shape (no `web.results`)')
      }

      // `more_results_available` is Brave's own "there is another page"
      // signal; without it the model cannot tell "10 of 10" from "10 of 900".
      const query = parsed.query
      const more =
        query && typeof query === 'object'
          ? (query as Record<string, unknown>).more_results_available === true
          : false
      if (more && results.length >= max) {
        uncertainty.push(
          `brave: more results are available (returned ${results.length}); narrow the query or raise the result cap`,
        )
      }

      for (const raw of results) {
        if (items.length >= max) break
        if (!raw || typeof raw !== 'object') continue
        const r = raw as Record<string, unknown>
        const url = String(r.url ?? '').trim()
        if (!url) continue
        const title = String(r.title ?? '').trim() || url
        const source: SearchSource = { url, title: clip(title, TITLE_CAP) }

        const description = String(r.description ?? '').trim()
        const extras = Array.isArray(r.extra_snippets)
          ? (r.extra_snippets as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim() !== '')
          : []
        // Ship the main excerpt plus ONE extra one: the extra snippets are
        // the reason `extra_snippets=true` is on, and two excerpts per hit
        // is where the card's value stops growing and the token cost does not.
        const snippet = [description, extras[0] ?? ''].filter(Boolean).join(' … ')
        if (snippet) source.snippet = clip(snippet)

        const age = plausiblePublishedAt(r.page_age)
        if (age) source.published_at = age

        items.push(source)
      }
    }

    return {
      items,
      warnings: warnings.length > 0 ? warnings : undefined,
      uncertainty: uncertainty.length > 0 ? uncertainty : undefined,
    }
  }

  /** Single-body compatibility path: parse one JSON search page. */
  parse(body: string, max: number): SearchSource[] {
    return this.parseMany([{ key: 'brave', body, status: 200, headers: {} }], max).items
  }
}
