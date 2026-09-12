/**
 * Configuration schema and runtime config (host-side).
 *
 * The plugin receives its initial values from the cordis row config; the same
 * schema backs the optional `dsh-network` settings namespace, so users can
 * also override values in `~/.dsh/settings.yaml` (hot-reloaded). Policy
 * fields (timeouts, caps, allowlist, engines) take effect on the next call
 * without a restart; tool enablement is read once at apply().
 */
import z from '@deepseek-ai/schemastery'

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0'

export const DEFAULT_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'

export const DEFAULT_ACCEPT_LANG = 'zh-CN,zh;q=0.9,en;q=0.8'

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export const DEFAULT_SEARCH_ENGINES = ['bing', 'duckduckgo', 'baidu'] as const
export const SEARCH_ENGINE_IDS = new Set<string>(['bing', 'duckduckgo', 'baidu', 'github', 'searxng'])
export const GITHUB_INDEX_IDS = new Set<string>(['repositories', 'code', 'issues', 'users'])
export const GITHUB_SORTS = ['best', 'stars', 'updated'] as const

export interface Config {
  enabled: boolean
  userAgent: string
  allowlist: string[]
  /** SSRF protection: blocks private/loopback/reserved targets. Default on. */
  ssrfProtection: boolean
  /** Redirect protection: only same-domain redirect hops. Default on. */
  redirectProtection: boolean
  /** Protocol lock: no http ↔ https switch on redirect hops. Default on. */
  protocolLock: boolean
  fetchTimeoutMs: number
  searchTimeoutMs: number
  httpTimeoutMs: number
  maxBodyChars: number
  maxRedirects: number
  searchEngines: string[]
  searchMaxResults: number
  /** Optional GitHub token for the github engine (code index + higher quota). */
  githubToken: string
  /** Explicit GitHub index selection (empty = automatic intent routing). */
  githubIndexes: string[]
  /** GitHub repositories sort: 'best' | 'stars' | 'updated'. */
  githubSort: string
  webSearchTool: boolean
  webFetchTool: boolean
  httpRequestTool: boolean
  httpMethods: HttpMethod[]
}

export const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  allowlist: z.array(z.string()).default([]),
  ssrfProtection: z.boolean().default(true),
  redirectProtection: z.boolean().default(true),
  protocolLock: z.boolean().default(true),
  fetchTimeoutMs: z.number().default(25_000),
  searchTimeoutMs: z.number().default(15_000),
  httpTimeoutMs: z.number().default(25_000),
  maxBodyChars: z.number().default(3_000_000),
  maxRedirects: z.number().default(3),
  searchEngines: z.array(z.string()).default([...DEFAULT_SEARCH_ENGINES]),
  searchMaxResults: z.number().default(10),
  githubToken: z.string().default(''),
  githubIndexes: z.array(z.string()).default([]),
  githubSort: z.union([z.const('best'), z.const('stars'), z.const('updated')]).default('best'),
  webSearchTool: z.boolean().default(true),
  webFetchTool: z.boolean().default(true),
  httpRequestTool: z.boolean().default(true),
  httpMethods: z.array(z.string()).default([...HTTP_METHODS]),
})

export function normalizeConfig(raw: unknown): Config {
  const config = ConfigSchema(raw ?? {})
  assertPositive('fetchTimeoutMs', config.fetchTimeoutMs)
  assertPositive('searchTimeoutMs', config.searchTimeoutMs)
  assertPositive('httpTimeoutMs', config.httpTimeoutMs)
  assertPositive('maxBodyChars', config.maxBodyChars)
  assertPositive('maxRedirects', config.maxRedirects)
  assertPositive('searchMaxResults', config.searchMaxResults)
  for (const engine of config.searchEngines) {
    if (!SEARCH_ENGINE_IDS.has(engine)) {
      throw new Error(`dsh-network: unknown search engine "${engine}" (bing | duckduckgo | baidu | github | searxng)`)
    }
  }
  const githubIndexes = new Set<string>()
  for (const index of config.githubIndexes) {
    const i = String(index).toLowerCase()
    if (!GITHUB_INDEX_IDS.has(i)) {
      throw new Error(`dsh-network: unknown github index "${index}" (repositories | code | issues | users)`)
    }
    githubIndexes.add(i)
  }
  const methods = new Set<HttpMethod>()
  for (const raw of config.httpMethods) {
    const m = String(raw).toUpperCase()
    if (!/^[A-Z]+$/.test(m)) throw new Error(`dsh-network: invalid HTTP method "${raw}"`)
    methods.add(m as HttpMethod)
  }
  if (!methods.has('GET')) throw new Error('dsh-network: httpMethods must contain at least GET')
  return {
    enabled: config.enabled,
    userAgent: config.userAgent,
    allowlist: config.allowlist,
    ssrfProtection: config.ssrfProtection,
    redirectProtection: config.redirectProtection,
    protocolLock: config.protocolLock,
    fetchTimeoutMs: config.fetchTimeoutMs,
    searchTimeoutMs: config.searchTimeoutMs,
    httpTimeoutMs: config.httpTimeoutMs,
    maxBodyChars: config.maxBodyChars,
    maxRedirects: config.maxRedirects,
    searchEngines: config.searchEngines,
    searchMaxResults: config.searchMaxResults,
    githubToken: config.githubToken,
    githubIndexes: [...githubIndexes],
    githubSort: config.githubSort,
    webSearchTool: config.webSearchTool,
    webFetchTool: config.webFetchTool,
    httpRequestTool: config.httpRequestTool,
    httpMethods: [...methods],
  }
}

function assertPositive(field: string, value: number) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-network: ${field} must be a positive integer`)
  }
}
