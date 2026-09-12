/**
 * GitHubSearchEngine — hybrid GitHub search via the REST Search API.
 *
 * One engine, many indexes. `buildRequests` routes one natural-language
 * query across GitHub's search endpoints (repositories / code / issues /
 * users) and the CLI fetches them in parallel; `parseMany` classifies
 * API errors (rate limit, auth, validation) and fuses the ranked lists
 * with weighted Reciprocal Rank Fusion (k=60).
 *
 * Endpoint facts (docs.github.com/rest/search, verified 2026-08):
 *   - `/search/repositories|issues|users` — anonymous OK
 *   - `/search/code` — REQUIRES auth (401 otherwise), 10 req/min
 *   - search resource: 10 req/min anonymous per IP, 30 req/min with token
 *   - query ≤ 256 chars, ≤ 5 boolean operators (422 beyond)
 *   - `Accept: application/vnd.github.text-match+json` adds text_matches
 *     highlight fragments to code/issues/repos hits
 *
 * Rate-limit handling: a 403/429 whose JSON message says "rate limit
 * exceeded" yields zero items plus a warning carrying the
 * `x-ratelimit-reset` timestamp (the CLI exposes response headers since
 * the `ClientResult.headers` addition). The engine never retries; the
 * chain falls through to the next engine.
 *
 * The engine never holds a token. The CLI reads
 * `DSH_NETWORK_GITHUB_TOKEN` and injects `Authorization: Bearer …`; it
 * passes only `hasToken: boolean` into `buildRequests` so routing can
 * drop the code index (and `requiresToken: true` marks it, so the CLI
 * can synthesize a 401 body instead of burning a network call).
 */
import {
  type EngineBody,
  type EngineParseResult,
  type EngineRequest,
  type SearchEngine,
  type SearchSource,
  BROWSER_FETCH_BASE,
} from './index.ts'
import { appendQuery } from '../network.ts'

/** GitHub index labels. */
export type GitHubIndex = 'repositories' | 'code' | 'issues' | 'users'

const API_BASE = 'https://api.github.com/search'

/** RRF constant (standard k=60). */
const RRF_K = 60

/** Cross-index fusion weights: repositories & code are the main battleground. */
const INDEX_WEIGHTS: Record<GitHubIndex, number> = {
  repositories: 1.0,
  code: 1.0,
  issues: 0.9,
  users: 0.7,
}

/** Display prefixes so an LLM can tell hit kinds apart at a glance. */
const INDEX_PREFIX: Record<GitHubIndex, string> = {
  repositories: 'repo',
  code: 'code',
  issues: 'issue',
  users: 'user',
}

const INDEX_ORDER: GitHubIndex[] = ['repositories', 'code', 'issues', 'users']

const SNIPPET_CAP = 300

/**
 * Route a query to the GitHub indexes worth asking. Pure, sync, testable.
 *
 * Priority:
 *   1. `@handle` / `user:`-targeted query and nothing else → users
 *   2. any GitHub qualifier (`repo:` `language:` `stars:` …) → repositories
 *      only (qualifiers are repositories-centric and pass through verbatim)
 *   3. "how to / 用法 / example" intent → repositories + code. The code
 *      request carries `requiresToken`; without a token the CLI never
 *      sends it and synthesizes a 401 body, keeping one error path.
 *   4. bug/issue intent → repositories + issues
 *   5. default → repositories
 */
export function routeGithubIndexes(query: string): GitHubIndex[] {
  const q = String(query ?? '').trim()
  if (q.length === 0) return []

  const hasQualifier =
    /(^|\s)(repo|user|org|language|stars|topic|in|created|pushed|is|state|label|archived):/i.test(q)
  const userTarget = /(^|\s)@[\w-]+/.test(q) || /(^|\s)user:[\w-]+(\s|$)/i.test(q)

  if (userTarget && !hasQualifier) return ['users']

  if (hasQualifier) return ['repositories']

  const codeIntent =
    /(用法|示例|怎么|如何|实现|代码|片段|怎么用|how to|example|snippet|usage|sample|demo|api for|usage of|tutorial)/i.test(
      q,
    )
  const issueIntent =
    /(bug|issue|报错|错误|崩溃|crash|问题|修复|fix|broken|not working|doesn't work|error)/i.test(q)

  if (codeIntent) return ['repositories', 'code']
  if (issueIntent) return ['repositories', 'issues']
  return ['repositories']
}

/** Strip control noise and cap a snippet. */
function clip(s: string, cap = SNIPPET_CAP): string {
  const clean = String(s ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean
}

/** Loose JSON parse of an API body (tolerates a BOM / leading whitespace). */
function parseJsonLoose(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(body ?? '').replace(/^\uFEFF/, '').trim())
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Extract the GitHub error `message` from an error body, if any. */
function errorMessage(body: string): string {
  const parsed = parseJsonLoose(body)
  return typeof parsed?.message === 'string' ? parsed.message : ''
}

/** Read the epoch-seconds reset from rate-limit headers, if present. */
function rateLimitReset(headers: Record<string, string> | undefined): string | null {
  const raw = headers?.['x-ratelimit-reset']
  if (!raw) return null
  const epoch = Number(raw)
  if (!Number.isFinite(epoch) || epoch <= 0) return null
  return new Date(epoch * 1000).toISOString()
}

interface RepoItem {
  full_name?: string
  html_url?: string
  description?: string | null
  stargazers_count?: number
  language?: string | null
  pushed_at?: string
  fork?: boolean
  text_matches?: Array<{ fragment?: string }>
}

interface CodeItem {
  path?: string
  html_url?: string
  repository?: { full_name?: string; html_url?: string }
  text_matches?: Array<{ fragment?: string }>
}

interface IssueItem {
  number?: number
  title?: string
  html_url?: string
  state?: string
  repository_url?: string
  body?: string | null
  text_matches?: Array<{ fragment?: string }>
}

interface UserItem {
  login?: string
  html_url?: string
  name?: string | null
  bio?: string | null
  followers?: number
}

interface ApiPage {
  total_count?: number
  incomplete_results?: boolean
  items?: unknown[]
}

/** One parsed hit carrying its fusion context. */
interface RankedHit {
  index: GitHubIndex
  rank: number
  source: SearchSource
}

export class GitHubSearchEngine implements SearchEngine {
  readonly id = 'github'
  readonly displayName = 'GitHub'
  readonly endpoint = API_BASE
  readonly defaultHeaders: Readonly<Record<string, string>> = {
    Accept: 'application/vnd.github.text-match+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': BROWSER_FETCH_BASE['User-Agent'],
  }

  /** Single-request compatibility path (kept for parity; CLI uses buildRequests). */
  buildUrl(query: string, options?: Readonly<Record<string, string>>): string {
    const index = (options?.index as GitHubIndex) || 'repositories'
    const perPage = clampPerPage(options?.per_page ? Number(options.per_page) : 10)
    const url = appendQuery(`${API_BASE}/${index}`, { q: query, per_page: String(perPage) })
    if (options?.sort) {
      return appendQuery(url, { sort: options.sort, order: 'desc' })
    }
    return url
  }

  buildRequests(query: string, options?: Readonly<Record<string, unknown>>): EngineRequest[] {
    const hasToken = options?.hasToken === true
    const perPage = clampPerPage(
      typeof options?.perPage === 'number' ? (options.perPage as number) : 10,
    )
    // Sort applies to the repositories index only — the issues/users
    // endpoints accept different `sort` enums and would 422 otherwise.
    const sort =
      typeof options?.sort === 'string' && (options.sort === 'stars' || options.sort === 'updated')
        ? (options.sort as string)
        : ''
    // The API caps queries at 256 chars; truncate locally so we never
    // burn a request on a guaranteed 422.
    const q = String(query ?? '').slice(0, 256).trim()
    if (q.length === 0) return []

    // An explicit index selection (settings panel / env) wins over
    // intent routing; unknown ids are dropped.
    const raw = options?.indexes
    const forced = Array.isArray(raw)
      ? (raw as unknown[])
      : typeof raw === 'string' && raw.trim() !== ''
        ? raw.split(',')
        : []
    const indexes: GitHubIndex[] = forced.length > 0
      ? (forced.filter((i): i is GitHubIndex => INDEX_ORDER.includes(i as GitHubIndex)))
      : routeGithubIndexes(q)

    return indexes.map((index) => {
      const url = appendQuery(`${API_BASE}/${index}`, {
        q,
        per_page: String(perPage),
        ...(index === 'repositories' && sort ? { sort, order: 'desc' } : {}),
      })
      const request: EngineRequest = { key: index, url }
      if (index === 'code' && !hasToken) request.requiresToken = true
      return request
    })
  }

  parseMany(bodies: EngineBody[], max: number): EngineParseResult {
    const warnings: string[] = []
    const uncertainty: string[] = []
    const hits: RankedHit[] = []

    for (const body of bodies) {
      const index = (INDEX_ORDER.includes(body.key as GitHubIndex) ? body.key : 'repositories') as GitHubIndex

      // Transport-level failure (fetch threw / never sent).
      if (body.error) {
        warnings.push(`github[${index}]: ${body.error}`)
        continue
      }

      const status = body.status ?? 0
      const message = errorMessage(body.body)

      // Rate limited → zero items, warn with the reset time, never retry.
      if ((status === 403 || status === 429) && /rate limit/i.test(message)) {
        const reset = rateLimitReset(body.headers)
        warnings.push(
          reset
            ? `github[${index}]: search rate limit exceeded (anonymous: 10/min per IP); resets ${reset}. Set DSH_NETWORK_GITHUB_TOKEN for 30/min.`
            : `github[${index}]: search rate limit exceeded (anonymous: 10/min per IP); retry later. Set DSH_NETWORK_GITHUB_TOKEN for 30/min.`,
        )
        continue
      }

      // Authentication required (real 401, or CLI-synthesized for code).
      if (status === 401 || /requires authentication/i.test(message)) {
        warnings.push(
          `github[${index}]: authentication required (set DSH_NETWORK_GITHUB_TOKEN to enable code search)`,
        )
        continue
      }

      if (status === 422) {
        warnings.push(
          `github[${index}]: query rejected (422) — queries are capped at 256 chars and 5 boolean operators`,
        )
        continue
      }
      if (status === 404) {
        warnings.push(`github[${index}]: endpoint not found (404)`)
        continue
      }
      if (status !== 0 && status !== 200) {
        warnings.push(`github[${index}]: unexpected HTTP ${status}${message ? ` — ${clip(message, 120)}` : ''}`)
        continue
      }

      const page = parseJsonLoose(body.body) as ApiPage | null
      if (!page) {
        warnings.push(`github[${index}]: response was not JSON`)
        continue
      }
      if (page.incomplete_results === true) {
        uncertainty.push(`github[${index}]: results may be incomplete (API timeout)`)
      }
      const items = Array.isArray(page.items) ? (page.items as unknown[]) : []
      items.slice(0, max).forEach((item, rank) => {
        const source = parseItem(index, item)
        if (source) hits.push({ index, rank, source })
      })
    }

    return {
      items: fuse(hits, max),
      warnings: warnings.length > 0 ? warnings : undefined,
      uncertainty: uncertainty.length > 0 ? uncertainty : undefined,
    }
  }

  /** Single-body compatibility path: parse one repositories page. */
  parse(body: string, max: number): SearchSource[] {
    return this.parseMany([{ key: 'repositories', body, status: 200, headers: {} }], max).items
  }
}

function clampPerPage(n: number): number {
  if (!Number.isInteger(n) || n < 1) return 10
  return Math.min(n, 100)
}

/** Map one API item to a SearchSource with a rich, LLM-friendly snippet. */
function parseItem(index: GitHubIndex, raw: unknown): SearchSource | null {
  if (!raw || typeof raw !== 'object') return null
  const prefix = INDEX_PREFIX[index]
  switch (index) {
    case 'repositories': {
      const item = raw as RepoItem
      if (!item.html_url) return null
      const title = item.full_name ?? item.html_url
      const meta: string[] = []
      if (typeof item.stargazers_count === 'number') meta.push(`⭐${formatCount(item.stargazers_count)}`)
      if (item.language) meta.push(item.language)
      if (item.pushed_at) meta.push(`updated ${item.pushed_at.slice(0, 10)}`)
      if (item.fork) meta.push('fork')
      const snippet = [item.description ? clip(item.description) : '', meta.join(' · ')]
        .filter(Boolean)
        .join(' — ')
      return { url: item.html_url, title: `[${prefix}] ${title}`, snippet: clip(snippet) || undefined }
    }
    case 'code': {
      const item = raw as CodeItem
      if (!item.html_url) return null
      const repo = item.repository?.full_name ?? ''
      const title = item.path ? `${item.path}${repo ? ` @ ${repo}` : ''}` : repo || item.html_url
      const fragment = item.text_matches?.find((m) => typeof m.fragment === 'string')?.fragment
      return {
        url: item.html_url,
        title: `[${prefix}] ${title}`,
        snippet: fragment ? clip(fragment) : undefined,
      }
    }
    case 'issues': {
      const item = raw as IssueItem
      if (!item.html_url) return null
      const num = typeof item.number === 'number' ? `#${item.number} ` : ''
      const state = item.state ? `[${item.state}] ` : ''
      const fragment = item.text_matches?.find((m) => typeof m.fragment === 'string')?.fragment
      const bodySnippet = item.body ? clip(item.body, 200) : ''
      return {
        url: item.html_url,
        title: `[${prefix}] ${num}${item.title ?? ''}`,
        snippet: clip(`${state}${fragment ?? bodySnippet}`) || undefined,
      }
    }
    case 'users': {
      const item = raw as UserItem
      if (!item.html_url) return null
      const bits = [item.name ? String(item.name) : '', item.bio ? clip(String(item.bio), 200) : '']
      if (typeof item.followers === 'number') bits.push(`${item.followers} followers`)
      return {
        url: item.html_url,
        title: `[${prefix}] ${item.login ?? ''}`,
        snippet: clip(bits.filter(Boolean).join(' — ')) || undefined,
      }
    }
  }
}

/** 1234 → '1.2k'. */
function formatCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`
  }
  return String(n)
}

/**
 * Weighted Reciprocal Rank Fusion across the parallel indexes.
 * score = Σ w / (k + rank + 1); dedupe by URL keeping the higher score.
 */
function fuse(hits: RankedHit[], max: number): SearchSource[] {
  const scored = new Map<string, { score: number; source: SearchSource; tie: number }>()
  for (const hit of hits) {
    const weight = INDEX_WEIGHTS[hit.index]
    const score = weight / (RRF_K + hit.rank + 1)
    const url = hit.source.url
    const existing = scored.get(url)
    if (!existing || score > existing.score) {
      // tie-break: higher weight first, then lower rank, then index order.
      const tie =
        INDEX_ORDER.indexOf(hit.index) * 1_000_000 + hit.rank * 1000 + (100 - Math.round(weight * 100))
      scored.set(url, { score, source: hit.source, tie })
    }
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.tie - b.tie)
    .slice(0, max)
    .map((e) => e.source)
}
