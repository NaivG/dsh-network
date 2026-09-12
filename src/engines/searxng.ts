/**
 * SearxngSearchEngine — self-hosted SearXNG metasearch via its JSON API.
 *
 * API (docs.searxng.org/dev/search_api.html):
 *   - GET /search?q=<q>&format=json   (POST / or /search with form data
 *     also works; GET /search is the canonical shape)
 *   - `format` MUST be enabled in the instance's settings.yml under
 *     `search.formats`; requesting a disabled format returns 403 Forbidden
 *   - error responses are JSON `{ "error": "..." }` (400/500)
 *   - success body (verified against searxng master 2026-08,
 *     searx/webutils.py get_json_response):
 *       { query, results: [ { url, title, content, engine, score, … } ],
 *         answers, corrections, infoboxes, suggestions,
 *         unresponsive_engines: [ [engine, errorText], … ] }
 *
 * This engine is a hybrid (buildRequests + parseMany): the single request
 * lets the error classification live on the same code path as GitHub's,
 * so a 403 (formats not enabled) or a JSON error body surfaces as a
 * warning instead of a silent "no results".
 *
 * Endpoint: the instance is user-configured. The CLI reads
 * `DSH_NETWORK_SEARXNG_URL` (host plugin injects it from the settings UI);
 * the default is the common self-hosted loopback `http://127.0.0.1:8888`.
 *
 * Private network: a loopback/private endpoint is normally refused by the
 * CLI's SSRF guard. Reaching your own SearXNG instance IS the feature, so
 * cli.ts grants private-network access to this engine's requests when the
 * configured endpoint is itself a private/loopback target (see
 * `engineAllowsPrivate` in cli.ts). Every hop is still SSRF-validated and
 * IP-pinned, and no other engine / web_fetch path is affected.
 */
import {
  type EngineBody,
  type EngineParseResult,
  type EngineRequest,
  type SearchEngine,
  type SearchSource,
  composeEngineUrl,
  BROWSER_BASE,
} from './index.ts'

/** Default self-hosted endpoint (the common `docker run` port is 8080;
 *  the loopback default here matches dsh-network's own 8888 convention). */
export const SEARXNG_DEFAULT_ENDPOINT = 'http://127.0.0.1:8888'

/** Env knob the CLI and the host plugin share (host injects per-call). */
export const SEARXNG_ENV = 'DSH_NETWORK_SEARXNG_URL'

const SNIPPET_CAP = 300
const TITLE_CAP = 200

/**
 * Accept a user-supplied endpoint; anything that is not a clean http(s)
 * URL falls back to the loopback default. Pure, sync, testable.
 */
export function normalizeSearxngEndpoint(raw: string | undefined): string {
  const s = String(raw ?? '').trim().replace(/\/+$/, '')
  if (/^https?:\/\/[^\s/]+$/i.test(s)) return s
  return SEARXNG_DEFAULT_ENDPOINT
}

/** Compose a `GET /search?q=…&format=json` URL for the JSON API. */
export function buildSearxngUrl(
  endpoint: string,
  query: string,
  options?: Readonly<Record<string, unknown>>,
): string {
  const extras: Record<string, string> = { format: 'json' }
  const language = options?.language
  if (typeof language === 'string' && language.trim() !== '') extras.language = language.trim()
  const safesearch = options?.safesearch
  if (safesearch === 0 || safesearch === 1 || safesearch === 2) extras.safesearch = String(safesearch)
  const timeRange = options?.timeRange
  if (typeof timeRange === 'string' && ['day', 'month', 'year'].includes(timeRange)) {
    extras.time_range = timeRange
  }
  const categories = options?.categories
  if (typeof categories === 'string' && categories.trim() !== '') extras.categories = categories.trim()
  const pageno = options?.pageno
  if (typeof pageno === 'number' && Number.isInteger(pageno) && pageno > 1) extras.pageno = String(pageno)
  return composeEngineUrl(`${endpoint}/search`, 'q', query, extras)
}

/** Loose JSON parse (tolerates a BOM / leading whitespace). */
function parseJsonLoose(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(body ?? '').replace(/^\uFEFF/, '').trim())
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Extract a SearXNG error-body `message`, if any. */
function errorBodyMessage(body: string): string {
  const parsed = parseJsonLoose(body)
  return typeof parsed?.error === 'string' ? parsed.error : ''
}

/** Whitespace-collapse + cap a string. */
function clip(s: string, cap = SNIPPET_CAP): string {
  const clean = String(s ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean
}

export class SearxngSearchEngine implements SearchEngine {
  readonly id = 'searxng'
  readonly displayName = 'SearXNG'
  /** Resolved at construction from `DSH_NETWORK_SEARXNG_URL`; surfaced for
   *  SSRF allowlist display and doctor output. */
  readonly endpoint = normalizeSearxngEndpoint(process.env[SEARXNG_ENV])
  /** A local instance does not gate on browser fingerprints, but the
   *  Firefox baseline keeps the request uniform with the rest of the chain. */
  readonly defaultHeaders: Readonly<Record<string, string>> = BROWSER_BASE

  /** Single-request compatibility path (kept for parity; CLI uses buildRequests). */
  buildUrl(query: string, options?: Readonly<Record<string, string>>): string {
    return buildSearxngUrl(this.endpoint, query, options)
  }

  buildRequests(query: string, options?: Readonly<Record<string, unknown>>): EngineRequest[] {
    const q = String(query ?? '').trim()
    if (q.length === 0) return []
    return [{ key: 'searxng', url: buildSearxngUrl(this.endpoint, q, options) }]
  }

  parseMany(bodies: EngineBody[], max: number): EngineParseResult {
    const warnings: string[] = []
    const uncertainty: string[] = []
    const items: SearchSource[] = []

    for (const body of bodies) {
      // Transport-level failure (fetch threw / never sent).
      if (body.error) {
        warnings.push(`searxng: ${body.error}`)
        continue
      }

      const status = body.status ?? 0

      // The #1 self-hosted misconfiguration: `format=json` not enabled in
      // settings.yml → the instance answers 403 Forbidden.
      if (status === 403) {
        warnings.push(
          'searxng: JSON output disabled (HTTP 403) — enable `json` in `search.formats` of the instance settings.yml and restart',
        )
        continue
      }
      if (status === 400 || status === 500) {
        const msg = errorBodyMessage(body.body)
        warnings.push(`searxng: HTTP ${status}${msg ? ` — ${msg}` : ''}`)
        continue
      }
      if (status !== 0 && status !== 200) {
        warnings.push(`searxng: unexpected HTTP ${status}`)
        continue
      }

      const parsed = parseJsonLoose(body.body)
      if (!parsed) {
        warnings.push('searxng: response was not JSON (is the endpoint actually a SearXNG instance?)')
        continue
      }
      if (typeof parsed.error === 'string') {
        warnings.push(`searxng: ${parsed.error}`)
        continue
      }

      // Metasearch means upstream engines can be down; surface that as
      // epistemic uncertainty, not a hard failure.
      const unresponsive = parsed.unresponsive_engines
      if (Array.isArray(unresponsive) && unresponsive.length > 0) {
        const names = unresponsive
          .slice(0, 5)
          .map((e) => (Array.isArray(e) ? String(e[0] ?? '') : String(e)))
          .filter(Boolean)
        uncertainty.push(
          `searxng: ${unresponsive.length} upstream engine(s) unresponsive: ${names.join(', ')}${unresponsive.length > 5 ? ', …' : ''}`,
        )
      }

      const results = Array.isArray(parsed.results) ? (parsed.results as unknown[]) : []
      for (const raw of results) {
        if (items.length >= max) break
        if (!raw || typeof raw !== 'object') continue
        const r = raw as Record<string, unknown>
        const url = String(r.url ?? '').trim()
        if (!url) continue
        const title = String(r.title ?? '').trim() || url
        const source: SearchSource = { url, title: clip(title, TITLE_CAP) }
        const content = String(r.content ?? '').trim()
        if (content) source.snippet = clip(content)
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
    return this.parseMany([{ key: 'searxng', body, status: 200, headers: {} }], max).items
  }
}
