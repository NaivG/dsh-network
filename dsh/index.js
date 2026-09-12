/**
 * dsh-network — DeepSeek Harness (dsh) plugin, host side.
 *
 * Hand-written ESM, no build step, no dsh package imports: the loader hands
 * `apply(ctx, config)` a live cordis context and we register into the
 * existing registries. The heavy lifting (network I/O, HTML→Markdown,
 * engine parsing) lives in the bundled CLI binary at `dist/cli.cjs`,
 * version-locked with this plugin so updating either side moves the other.
 *
 * Why hand-written JS and not a TS bundle:
 *
 *   - vite's lib mode replaces every `node:*` import with
 *     `__vite-browser-external` during scope analysis, regardless of
 *     `build.target: 'node20'` and external lists. A built host bundle
 *     therefore drops `spawn`, `fileURLToPath`, `readFileSync` to
 *     `undefined` at runtime. The CLI binary handles all those
 *     imports in a Node-targeted build without the lib-mode trip-up.
 *   - The host is small: two providers + three tools, each ~50 lines.
 *     Schema definitions are JSON Schema objects, so TypeScript buys
 *     little. Modsearch applies the same separation.
 */
import { loadPersistedConfig, PERSIST_FILE, savePersistedConfig } from './persist.js'
import { createNetworkServerClient, configToEnv } from './serverClient.js'

const GITHUB_INDEX_IDS = ['repositories', 'code', 'issues', 'users']
const GITHUB_SORTS = ['best', 'stars', 'updated']
// Kept in lockstep with src/schema.ts (when that file exists) by a future
// test; for now they are duplicated verbatim here so this plugin file stays
// dependency-free (no `import` from compiled dist files, no JSON-loader
// requirement).
// JSON Schema subset enforced by `dsh-tools`: `required` is only valid on
// `type: "object"` nodes and must be a string array of property names. The
// earlier versions of these constants placed `required: true` inside each
// property — invalid; the loader rejected them at boot.
const SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'engine', 'summary', 'items', 'uncertainty', 'warnings', 'attempts'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded', 'unavailable'] },
    engine: { type: 'string' },
    summary: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
        },
      },
    },
    uncertainty: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    attempts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { engine: { type: 'string' }, error: { type: 'string' } },
      },
    },
  },
}
const FETCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'url',
    'finalUrl',
    'statusCode',
    'contentType',
    'engine',
    'summary',
    'content',
    'links',
    'uncertainty',
    'warnings',
  ],
  properties: {
    url: { type: 'string' },
    finalUrl: { type: 'string' },
    statusCode: { type: 'integer' },
    contentType: { type: 'string' },
    engine: { type: 'string' },
    summary: { type: 'string' },
    content: { type: 'string' },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'url'],
        properties: {
          text: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
    uncertainty: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    // Server-side cache paging — present when the underlying result was
    // degraded to cacheId+preview because it exceeded the inline cap
    // (~20 KB). The model can re-invoke with cacheId + offset/limit to
    // page through the rest of the content, sidestepping both the
    // child-process stdout chunking and the model's own truncation.
    cacheId: { type: 'string' },
    contentLength: { type: 'integer' },
    cacheSlice: {
      type: 'object',
      additionalProperties: false,
      required: ['offset', 'limit', 'total'],
      properties: {
        offset: { type: 'integer' },
        limit: { type: 'integer' },
        total: { type: 'integer' },
      },
    },
  },
}
// Closed-set category vocabulary for `web_sitemap`. Mirrored verbatim from
// src/sitemap.ts (kept inline so this plugin file stays dependency-free —
// the same trade-off the search/fetch/http schemas make).
const WEB_SITEMAP_CATEGORIES = [
  'code-repos', 'code-search', 'package-registries', 'qna',
  'encyclopedia', 'docs', 'manuals', 'standards',
  'news', 'tech-news', 'academic', 'ai-platforms',
  'datasets', 'devops', 'government', 'search',
  'social', 'video', 'music', 'maps',
  'shopping', 'finance', 'forum',
]

const SITEMAP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'engine', 'summary', 'entries', 'resolved', 'uncertainty', 'warnings'],
  properties: {
    status: { type: 'string', enum: ['ok', 'unavailable'] },
    engine: { type: 'string', enum: ['web_sitemap'] },
    summary: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['domain', 'description', 'category', 'priority', 'hasSearchUrl'],
        properties: {
          domain: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string', enum: WEB_SITEMAP_CATEGORIES },
          priority: { type: 'integer' },
          hasSearchUrl: { type: 'boolean' },
          language: { type: 'string' },
          region: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    resolved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['domain', 'query', 'url'],
        properties: { domain: { type: 'string' }, query: { type: 'string' }, url: { type: 'string' } },
      },
    },
    digest: { type: 'string' },
    uncertainty: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

const HTTP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'url',
    'finalUrl',
    'method',
    'statusCode',
    'statusText',
    'contentType',
    'headers',
    'body',
    'warnings',
  ],
  properties: {
    url: { type: 'string' },
    finalUrl: { type: 'string' },
    method: { type: 'string' },
    statusCode: { type: 'integer' },
    statusText: { type: 'string' },
    contentType: { type: 'string' },
    headers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value'],
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
    body: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    // Server-side cache paging — see FETCH_OUTPUT_SCHEMA. http_request
    // also degrades body+raw-headers when the response is too large for
    // a single round-trip across the loopback socket / the model.
    cacheId: { type: 'string' },
    contentLength: { type: 'integer' },
    cacheSlice: {
      type: 'object',
      additionalProperties: false,
      required: ['offset', 'limit', 'total'],
      properties: {
        offset: { type: 'integer' },
        limit: { type: 'integer' },
        total: { type: 'integer' },
      },
    },
  },
}

// web_config — read or modify the dsh-network configuration. The set
// action is gated by the user-controlled `allowConfigEdit` safety toggle;
// get always works so the model can read what it would otherwise be
// allowed to change. Secrets (githubToken, searchEngineApiKeys) are
// filtered out by `summarize()` — the model never sees them, only the
// `hasGithubToken` / `hasApiKey` booleans the editor card needs.
//
// The toggle itself is deliberately hidden from the model — neither in
// the output nor in the patch schema. The model never reads
// `allowConfigEdit` and can never write it. If it could, a single bad
// batched patch (e.g. `set({ allowConfigEdit: false, … })`) would
// lock the model out of its own write path for the rest of the
// session. The user is the only actor that can flip the toggle, and
// they do it from the browser's 网络 → 安全 section. The set error
// message ("the user must enable the `allowConfigEdit` safety toggle
// in …") is how the model learns the gate exists at all.
const WEB_CONFIG_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'action', 'config'],
  properties: {
    status: { type: 'string', enum: ['ok', 'error'] },
    action: { type: 'string', enum: ['get', 'set'] },
    config: { type: 'object' },
    // Set-action only: explanation when status === 'error' (most often
    // because the safety toggle is off), or persistence confirmation
    // when the change was written to disk.
    error: { type: 'string' },
    persisted: { type: 'boolean' },
  },
}

// JSON Schema for the `patch` argument on web_config.set. Mirrors what
// `applyCardSettings()` accepts so the model can only set fields the
// browser UI also edits. `allowConfigEdit` is deliberately omitted:
// the model has no business toggling its own write gate, and surfacing
// it would invite the "model locked itself out" footgun. Secrets
// (`githubToken`, per-engine API keys) are kept off the list for the
// same reason — the browser still doesn't expose them either.
const WEB_CONFIG_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    userAgent: { type: 'string' },
    allowlist: {
      type: 'array',
      items: { type: 'string' },
      description: 'Hostname allowlist (e.g. ["*.example.com"]); empty array = unrestricted.',
    },
    ssrfProtection: { type: 'boolean' },
    redirectProtection: { type: 'boolean' },
    protocolLock: { type: 'boolean' },
    fetchTimeoutMs: { type: 'integer' },
    searchTimeoutMs: { type: 'integer' },
    httpTimeoutMs: { type: 'integer' },
    maxBodyChars: { type: 'integer' },
    maxRedirects: { type: 'integer' },
    searchMaxResults: { type: 'integer' },
    searchEngines: {
      type: 'array',
      items: { type: 'string' },
      description: 'Search-engine chain order; one of bing, duckduckgo, baidu, github, searxng.',
    },
    searchEngineConfigs: {
      type: 'object',
      description: 'Per-engine overrides (endpoint, hasApiKey, options).',
    },
    httpMethods: {
      type: 'array',
      items: { type: 'string' },
      description: 'Allowed http_request methods (uppercase).',
    },
    githubIndexes: {
      type: 'array',
      items: { type: 'string', enum: ['repositories', 'code', 'issues', 'users'] },
    },
    githubSort: { type: 'string', enum: ['best', 'stars', 'updated'] },
  },
}

// Cordis keeps no copy of the entry config after apply() returns, so
// `apply()` resolves the row config once into a live object the loopback
// route mutates; policy fields are read again at every tool call.
export const name = 'dsh-network'
export const inject = ['tools', 'web', 'systemPrompt']

// The single persistent `dsh-network server` child. Created lazily on first
// use and bound to the Cordis fiber via ctx.effect(), so it follows dsh's
// lifecycle (started with dsh, killed on dispose).
let networkClient = null

function getNetworkClient() {
  if (!networkClient) networkClient = createNetworkServerClient()
  return networkClient
}

/**
 * Run one job on the persistent loopback server. Returns the entry (the
 * first result of the envelope) and throws with the attempt trail on
 * failure — same contract as the old spawn-per-call runCli, so the tool
 * execute paths below are unchanged apart from the transport.
 */
async function runCli(args, signal, config) {
  const env = configToEnv(config)
  const parsed = await getNetworkClient().invoke(args, env, signal)
  const entry = Array.isArray(parsed.results) ? parsed.results[0] : undefined
  if (!entry || typeof entry.summary !== 'string') {
    throw new Error('dsh-network returned an envelope without a usable source entry')
  }
  if (entry.status === 'unavailable') {
    const attempts = Array.isArray(entry.attempts) ? entry.attempts : []
    const msg = attempts.length
      ? attempts.map((a) => `${a.engine || 'engine'}: ${a.error || 'skipped'}`).join('; ')
      : 'engine chain returned no usable result'
    throw new Error(`dsh-network could not reach the requested source (${msg}). Run \`npx dsh-network doctor\` to check setup.`)
  }
  return entry
}

/**
 * Soft variant used by web_sitemap: an `unavailable` entry is returned as-is
 * instead of throwing — an empty/soft sitemap result is the signal to fall
 * back to web_search, not a hard error.
 */
async function runCliSoft(args, signal, config) {
  const env = configToEnv(config)
  const parsed = await getNetworkClient().invoke(args, env, signal)
  const entry = Array.isArray(parsed.results) ? parsed.results[0] : undefined
  if (!entry || typeof entry.summary !== 'string') {
    throw new Error('dsh-network returned an envelope without a usable source entry')
  }
  return entry
}

/** Map CLI search items to the seam's `WebSearchSource` shape. */
function toSearchSources(items) {
  if (!Array.isArray(items)) return []
  return items
    .filter((item) => item && typeof item.url === 'string' && item.url !== '')
    .map((item) => ({
      url: item.url,
      ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title } : {}),
      ...(typeof item.snippet === 'string' && item.snippet !== '' ? { snippet: item.snippet } : {}),
      ...(typeof item.published_at === 'string' && item.published_at !== ''
        ? { publishedAt: item.published_at }
        : {}),
    }))
}

const RENDER_CONTENT_CAP = 20_000
const RENDER_LINK_CAP = 20

/**
 * Build a presentationMeta-shaped object that survives a JSON
 * `stringify → parse` round-trip.
 *
 * `JSON.stringify` silently drops keys whose value is `undefined`, and the
 * harness validates every tool's `presentationMeta` for lossless round-trip
 * (a strict `JSON.parse(JSON.stringify(meta))` deep-equal against the
 * original). Any tool whose output carries optional fields must omit them
 * entirely when absent, otherwise the check trips with
 * "output.presentationMeta returned non-lossless JSON" and the tool call
 * is rejected before the model ever sees the result.
 *
 * `null` is preserved (it is JSON-safe), so callers can use either
 * `undefined` for "absent" or `null` for "explicitly empty" — both collapse
 * correctly in the rendered card.
 */
function compactPresentation(meta) {
  const out = {}
  for (const key of Object.keys(meta)) {
    const value = meta[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

function renderSearchEvidence(value) {
  const lines = []
  if (value.status === 'degraded') {
    lines.push(`[degraded: ${value.engine} answered second-hand, treat as indirect evidence]`)
  } else if (value.status === 'unavailable') {
    lines.push('[unavailable: all engines failed]')
  }
  lines.push(value.summary || '')
  const items = Array.isArray(value.items) ? value.items : []
  if (items.length > 0) {
    lines.push('', 'Sources:')
    items.forEach((item, index) => {
      const dated = item.published_at ? ` (${item.published_at})` : ''
      lines.push(`${index + 1}. ${item.title || item.url}${dated} — ${item.url}`)
      if (item.snippet) lines.push(`   ${item.snippet}`)
    })
  }
  if (Array.isArray(value.uncertainty) && value.uncertainty.length > 0) {
    lines.push('', `Uncertain: ${value.uncertainty.join('; ')}`)
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `Warnings: ${value.warnings.join('; ')}`)
  }
  if (Array.isArray(value.attempts) && value.attempts.length > 0) {
    lines.push('', `Attempts: ${value.attempts.map((a) => `${a.engine}: ${a.error || 'ok'}`).join('; ')}`)
  }
  return lines.join('\n')
}

// The CLI/server emits a six-field slice descriptor
// ({offset, limit, start, end, total, more}); the tool output schemas (and
// the documented envelope) expose only the three paging-relevant fields, so
// narrow here — before the value reaches output validation — or the strict
// additionalProperties:false schema rejects every paged response.
function toHostCacheSlice(slice) {
  return {
    offset: Number(slice.offset),
    limit: Number(slice.limit),
    total: Number(slice.total),
  }
}

function renderFetchEvidence(value) {
  const lines = [value.summary || '']
  // Paging descriptor BEFORE the body — same rationale as renderHttpEvidence:
  // output retention truncates long tails, and the cacheId must survive it.
  if (
    typeof value.cacheId === 'string' &&
    value.cacheId !== '' &&
    Number.isInteger(value.contentLength) &&
    value.contentLength > value.content.length
  ) {
    // The next-offset hint must be the ABSOLUTE position of the served slice
    // (cacheSlice.offset + shown chars), not the slice-local length: on a
    // paged read the body is a 1-2k-char slice, and hinting offset=<slice
    // length> would send the model back to the top of the page.
    const nextOffset =
      value.cacheSlice && Number.isInteger(value.cacheSlice.offset)
        ? value.cacheSlice.offset + value.content.length
        : value.content.length
    lines.push(
      `Paged: showing ${value.content.length.toLocaleString()} of ${Number(value.contentLength).toLocaleString()} chars. ` +
        `Read the rest with web_fetch: cacheId="${value.cacheId}", offset=${nextOffset}, limit=20000.`,
    )
  }
  const content = typeof value.content === 'string' ? value.content.trim() : ''
  if (content) {
    lines.push(
      '',
      'Content:',
      content.length > RENDER_CONTENT_CAP ? `${content.slice(0, RENDER_CONTENT_CAP)}…` : content,
    )
  }
  const links = Array.isArray(value.links) ? value.links.slice(0, RENDER_LINK_CAP) : []
  if (links.length > 0) {
    lines.push('', 'Links:')
    for (const link of links) lines.push(`- ${link.text} — ${link.url}`)
  }
  if (Array.isArray(value.uncertainty) && value.uncertainty.length > 0) {
    lines.push('', `Uncertain: ${value.uncertainty.join('; ')}`)
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `Warnings: ${value.warnings.join('; ')}`)
  }
  return lines.join('\n')
}

function renderHttpEvidence(value) {
  const lines = [`HTTP ${value.statusCode} ${value.statusText || ''} ${value.finalUrl}`]
  // Cache paging descriptor goes BEFORE the body: the harness's output
  // retention can cut a long body tail, and a cacheId trailing the body is
  // then lost with it (defect: the model could never see the id to page).
  const degraded =
    typeof value.cacheId === 'string' &&
    value.cacheId !== '' &&
    Number.isInteger(value.contentLength) &&
    value.contentLength > (typeof value.body === 'string' ? value.body.length : 0)
  if (degraded) {
    // Same next-offset rule as renderFetchEvidence: absolute position
    // (cacheSlice.offset + shown chars), never the slice-local length.
    const nextOffset =
      value.cacheSlice && Number.isInteger(value.cacheSlice.offset)
        ? value.cacheSlice.offset + value.body.length
        : value.body.length
    lines.push(
      `Paged: showing ${value.body.length.toLocaleString()} of ${Number(value.contentLength).toLocaleString()} chars. ` +
        `Read the rest with http_request: cacheId="${value.cacheId}", offset=${nextOffset}, limit=20000.`,
    )
  }
  if (value.contentType) lines.push(`Content-Type: ${value.contentType}`)
  for (const h of Array.isArray(value.headers) ? value.headers : []) {
    lines.push(`${h.name}: ${h.value}`)
  }
  const body = typeof value.body === 'string' ? value.body : ''
  lines.push('', body.length > RENDER_CONTENT_CAP ? `${body.slice(0, RENDER_CONTENT_CAP)}…` : body)
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `Warnings: ${value.warnings.join('; ')}`)
  }
  return lines.join('\n')
}

// ────────────────────────── providers into the web seam ──────────────────────────
function makeSearchProvider(config) {
  return {
    id: 'dsh-network',
    available: () => true,
    async search(request, signal) {
      const args = ['search', '-q', request.query, '-t', String(60_000)]
      if (typeof request.maxResults === 'number') {
        args.push('--max-results', String(request.maxResults))
      }
      const entry = await runCli(args, signal, config)
      const sources = toSearchSources(entry.items)
      const truncated =
        typeof request.maxResults === 'number' && sources.length >= request.maxResults
      const lines = [entry.summary]
      const uncertainty = Array.isArray(entry.uncertainty) ? entry.uncertainty : []
      if (uncertainty.length > 0) lines.push(`Uncertain: ${uncertainty.join('; ')}`)
      return {
        content: lines.filter(Boolean).join('\n'),
        sources,
        truncated,
      }
    },
  }
}

function makeFetchProvider(config) {
  // The SSRF protection switch is read at every fetch — the settings
  // toggle mutates `config.ssrfProtection` in place, and the next tool
  // call picks up the new value without a plugin reload. Protections
  // default ON: only a disabled one is pushed to the CLI as a flag.
  //
  // dsh 0.1.5 note: the model-facing `web_fetch` tool is mounted per-session
  // by the agent preset's tool-web row, which consumes THIS provider through
  // the web seam. The seam contract (`WebFetchResult`) has no cacheId field,
  // so the server-side degrade (preview + cacheId) cannot travel structurally.
  // A degraded body is therefore flagged `truncated: true` and carries an
  // inline paging hint that routes the model to `http_request cacheId=...`
  // — the plugin's own tool, whose paging path shares the same server cache.
  // Dropping the cacheId silently (the 0.1.2-era behavior) left over-cap
  // pages as an unpageable 20k preview with `truncated: false`.
  return {
    id: 'dsh-network',
    available: () => true,
    async fetch(request, signal) {
      const cliArgs = ['fetch', '-u', request.url, '-t', String(60_000)]
      if (config && config.ssrfProtection === false) cliArgs.push('--allow-private-network')
      if (config && config.redirectProtection === false) cliArgs.push('--no-redirect-protection')
      if (config && config.protocolLock === false) cliArgs.push('--no-protocol-lock')
      const entry = await runCli(cliArgs, signal, config)
      let body = typeof entry.content === 'string' ? entry.content : ''
      const contentType = typeof entry.contentType === 'string' ? entry.contentType : ''
      const finalUrl = typeof entry.finalUrl === 'string' ? entry.finalUrl : request.url
      const status = typeof entry.statusCode === 'number' ? entry.statusCode : 0
      const truncatedByCache =
        typeof entry.cacheId === 'string' &&
        entry.cacheId !== '' &&
        Number.isInteger(entry.contentLength) &&
        entry.contentLength > body.length
      let truncated =
        truncatedByCache ||
        (Array.isArray(entry.warnings) && entry.warnings.some((w) => /truncated/i.test(w)))
      if (truncatedByCache) {
        const nextOffset = body.length
        body =
          `${body}\n\n[dsh-network] This is a ${body.length.toLocaleString()}-char preview of a ` +
          `${Number(entry.contentLength).toLocaleString()}-char page (server-side paging cache). ` +
          `Read the rest with the http_request tool: cacheId="${entry.cacheId}", ` +
          `offset=${nextOffset}, limit=20000 (url and cacheId are mutually exclusive).`
      }
      // The CLI emits Markdown by default; the seam accepts only `html` and
      // `text`. Markdown is text; the renderer on top of the seam will
      // surface it as-is.
      return {
        url: finalUrl,
        statusCode: status,
        body: { kind: 'text', content: body },
        truncated,
      }
    },
  }
}

// ─────────────────────────────── model-facing tools ────────────────────────────
function registerWebSearchTool(ctx, config) {
  const knownEngines = Array.isArray(config.searchEngines) ? config.searchEngines : ['bing', 'duckduckgo', 'baidu']
  ctx.tools.register({
    name: 'web_search',
    description:
      `Search the public web for current information. Returns citeable sources plus a summary, status, and any uncertainties or operational warnings. Pass \`engine\` to pin one engine (one of: ${knownEngines.join(', ')}); omit to use the default chain. Follow up with web_fetch for the full page of a chosen source.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'The search query.' },
        count: {
          type: 'integer',
          description: 'Maximum number of results to return (1-20, default 10).',
        },
        engine: {
          type: 'string',
          enum: knownEngines,
          description: 'Optional engine id to pin for this call. Omit to use the default engine chain.',
        },
      },
    },
    output: {
      schema: SEARCH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSearchEvidence(value) }],
      presentationMeta: (_args, value) => ({
        status: value.status,
        engine: value.engine,
        sources: toSearchSources(value.items),
        truncated: false,
        // dsh-network extras that the native web card doesn't model —
        // consumed by the dedicated block renderer in `dsh/client.js`.
        uncertainty: value.uncertainty,
        warnings: value.warnings,
        attempts: value.attempts,
      }),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: String(args.query || ''),
      kind: 'search',
      rawInput: String(args.query || ''),
    }),
    presentResult: (args, result) => {
      if (result.isError) return undefined
      const meta = result.meta
      if (!meta || typeof meta !== 'object') return undefined
      const sources = Array.isArray(meta.sources)
        ? meta.sources
            .filter((s) => s && typeof s.url === 'string')
            .map((s) => ({
              url: s.url,
              ...(typeof s.title === 'string' ? { title: s.title } : {}),
              ...(typeof s.snippet === 'string' ? { snippet: s.snippet } : {}),
            }))
        : []
      return {
        card: 'web',
        kind: 'search',
        title: String(args.query || ''),
        sources,
        truncated: Boolean(meta.truncated),
      }
    },
    async execute(args, exec) {
      const query = String(args.query || '').trim()
      if (!query) throw new Error('web_search: query must be a non-empty string')
      const count = args.count === undefined ? 10 : Number(args.count)
      if (!Number.isInteger(count) || count < 1 || count > 20) {
        throw new Error('web_search: count must be an integer in [1, 20]')
      }
      const cliArgs = ['search', '-q', query, '--max-results', String(count), '-t', '55000']
      if (typeof args.engine === 'string' && args.engine.trim() !== '') {
        cliArgs.push('--engine', args.engine.trim().toLowerCase())
      }
      const entry = await runCli(cliArgs, exec.signal, config)
      return {
        status: entry.status,
        engine: entry.engine,
        summary: entry.summary,
        items: Array.isArray(entry.items) ? entry.items : [],
        uncertainty: Array.isArray(entry.uncertainty) ? entry.uncertainty : [],
        warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
        attempts: Array.isArray(entry.attempts) ? entry.attempts : [],
      }
    },
  })
  ctx.systemPrompt.section({
    name: 'tool:web_search',
    order: 110,
    text:
      'Use the web_search tool for current public-web information. Returns a citeable sources list with title/snippet/date, a status (`ok`/`degraded`/`unavailable`), and `uncertainty`/`warnings` arrays. Optionally pass `engine` to pin one engine; omit to use the default chain. Cite relevant URLs as markdown links, and follow up with web_fetch for the full page.',
  })
}

function registerWebFetchTool(ctx, config) {
  // The protection toggles (`config.ssrfProtection` / `redirectProtection` /
  // `protocolLock`) are read at call time so the user can change them from
  // the settings page and have the next web_fetch pick up the new values
  // without a plugin reload.
  ctx.tools.register({
    name: 'web_fetch',
    description:
      'Fetch a specific HTTP(S) URL and return the page content as Markdown (default) or raw body. Returns outgoing links, status, and any uncertainty or operational warnings alongside the body. SSRF-protected: private/reserved addresses are blocked by default and an allowlist (when configured) is honored. When the body is larger than ~20 KB the response is automatically stored on the server and a `cacheId` is returned — re-invoke with `cacheId` + optional `offset`/`limit` to page through the rest without re-downloading.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      // Either url (fresh fetch) or cacheId (page an existing result). url
      // XOR cacheId is enforced in execute; the schema leaves `required`
      // empty because JSON Schema cannot express "one of".
      properties: {
        url: { type: 'string', description: 'The HTTP(S) URL to fetch.' },
        format: {
          type: 'string',
          enum: ['markdown', 'raw'],
          description: 'markdown (default) or raw body.',
        },
        cacheId: {
          type: 'string',
          description: 'A previously returned cache id (when the original response was too large). Mutually exclusive with `url`.',
        },
        offset: {
          type: 'integer',
          description: 'Paging: starting character offset into the cached body (default 0). Only meaningful with `cacheId`.',
        },
        limit: {
          type: 'integer',
          description: 'Paging: slice length, 1-20000 (default 4000). Only meaningful with `cacheId`.',
        },
      },
    },
    output: {
      schema: FETCH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderFetchEvidence(value) }],
      presentationMeta: (_args, value) => compactPresentation({
        url: value.finalUrl,
        statusCode: value.statusCode,
        truncated: Array.isArray(value.warnings) && value.warnings.some((w) => /truncated/i.test(w)),
        contentType: value.contentType,
        engine: value.engine,
        warnings: value.warnings,
        uncertainty: value.uncertainty,
        linksCount: Array.isArray(value.links) ? value.links.length : 0,
        // Surface the cache descriptor so the block renderer can hint at
        // paging controls (e.g. "(preview, 4123 more chars)").
        cacheId: value.cacheId,
        contentLength: value.contentLength,
        cacheSlice: value.cacheSlice,
      }),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => {
      const rawInput = typeof args.cacheId === 'string' && args.cacheId !== ''
        ? `cache:${args.cacheId.slice(0, 8)}`
        : String(args.url || '')
      const title = rawInput
      return { card: 'generic', title, kind: 'fetch', rawInput }
    },
    presentResult: (args, result) => {
      if (result.isError) return undefined
      const meta = result.meta
      if (!meta || typeof meta !== 'object') return undefined
      const url = typeof meta.url === 'string' ? meta.url : String(args.url || '')
      const statusCode =
        typeof meta.statusCode === 'number' ? meta.statusCode : 0
      return {
        card: 'web',
        kind: 'fetch',
        title: url,
        url,
        statusCode,
        truncated: Boolean(meta.truncated),
      }
    },
    async execute(args, exec) {
      const url = String(args.url || '').trim()
      const cacheId = typeof args.cacheId === 'string' ? args.cacheId.trim() : ''
      if ((url === '') === (cacheId === '')) {
        throw new Error('web_fetch: provide exactly one of `url` or `cacheId`')
      }
      let cliArgs
      if (cacheId !== '') {
        // Paging path — the original URL/ssrf/protocol knobs are baked into
        // the cache entry on the server, so we send only the paging args.
        cliArgs = ['fetch', '--cache-id', cacheId]
        if (Number.isInteger(args.offset) && args.offset >= 0) {
          cliArgs.push('--offset', String(args.offset))
        }
        if (Number.isInteger(args.limit) && args.limit >= 1) {
          cliArgs.push('--limit', String(args.limit))
        }
      } else {
        if (!/^https?:\/\//i.test(url)) throw new Error('web_fetch: an http(s) URL is required')
        const format = String(args.format || 'markdown').toLowerCase() === 'raw' ? 'raw' : 'markdown'
        cliArgs = ['fetch', '-u', url, '--format', format, '-t', '55000']
        if (config && config.ssrfProtection === false) cliArgs.push('--allow-private-network')
        if (config && config.redirectProtection === false) cliArgs.push('--no-redirect-protection')
        if (config && config.protocolLock === false) cliArgs.push('--no-protocol-lock')
      }
      const entry = await runCli(cliArgs, exec.signal, config)
      if (entry.status !== 'ok') {
        const attempt = Array.isArray(entry.attempts) && entry.attempts[0]
        throw new Error(
          `web_fetch: ${entry.summary || 'unavailable'}${attempt ? ` (${attempt.stage || 'fetch'}: ${attempt.error})` : ''}`,
        )
      }
      return {
        url: typeof entry.url === 'string' && entry.url !== '' ? entry.url : url,
        finalUrl: entry.finalUrl,
        statusCode: entry.statusCode,
        contentType: entry.contentType,
        engine: entry.engine,
        summary: entry.summary,
        content: entry.content || '',
        links: Array.isArray(entry.links) ? entry.links : [],
        uncertainty: Array.isArray(entry.uncertainty) ? entry.uncertainty : [],
        warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
        // Only present when the server degraded the result to a preview
        // (content > INLINE_CAP) or when paging returns a slice descriptor.
        ...(typeof entry.cacheId === 'string' ? { cacheId: entry.cacheId } : {}),
        ...(Number.isInteger(entry.contentLength) ? { contentLength: entry.contentLength } : {}),
        ...(entry.cacheSlice && typeof entry.cacheSlice === 'object'
          ? { cacheSlice: toHostCacheSlice(entry.cacheSlice) }
          : {}),
      }
    },
  })
  ctx.systemPrompt.section({
    name: 'tool:web_fetch',
    order: 111,
    text:
      'Use the web_fetch tool to read one HTTP(S) URL. Body is Markdown by default; outgoing links and any warnings come along with it. If the response carries a `cacheId`, the body was truncated to ~20 KB for transport — pass that `cacheId` back to `web_fetch` (with optional `offset`/`limit`) to page through the remainder without re-downloading. `url` and `cacheId` are mutually exclusive.',
  })
}

function registerHttpRequestTool(ctx, config) {
  // Call-time read of the protection toggles (see registerWebFetchTool).
  ctx.tools.register({
    name: 'http_request',
    description:
      'Send a low-level HTTP(S) request with full method/header/body control: GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS. Returns the final status code, response headers, and decoded response body as text. SSRF-protected: private/reserved addresses are blocked by default and an allowlist (when configured) is honored. When the body is larger than ~20 KB the response is automatically stored on the server and a `cacheId` is returned — re-invoke with `cacheId` + optional `offset`/`limit` to page through the rest without re-issuing the request.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      // url XOR cacheId is enforced in execute; JSON Schema cannot express
      // exclusive-or, so `required` is empty.
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
          description: 'HTTP method.',
        },
        url: { type: 'string', description: 'The HTTP(S) URL to request.' },
        headers: {
          type: 'object',
          additionalProperties: true,
          description: 'Request headers as a key→value map.',
        },
        body: {
          type: 'string',
          description: 'Optional request body; use with care on POST/PUT/PATCH.',
        },
        contentType: {
          type: 'string',
          description: 'Content-Type to send when no header named `content-type` is set.',
        },
        timeoutSec: {
          type: 'integer',
          description: 'Per-call timeout in seconds (default 25).',
        },
        followRedirects: {
          type: 'boolean',
          description: 'Follow redirects (default true). Each hop is SSRF-validated, same-domain, and http/https-locked.',
        },
        cacheId: {
          type: 'string',
          description: 'A previously returned cache id (when the original response was too large). Mutually exclusive with `url`.',
        },
        offset: {
          type: 'integer',
          description: 'Paging: starting character offset into the cached body (default 0). Only meaningful with `cacheId`.',
        },
        limit: {
          type: 'integer',
          description: 'Paging: slice length, 1-20000 (default 4000). Only meaningful with `cacheId`.',
        },
      },
    },
    output: {
      schema: HTTP_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderHttpEvidence(value) }],
      presentationMeta: (_args, value) => compactPresentation({
        url: value.finalUrl,
        method: value.method,
        statusCode: value.statusCode,
        contentType: value.contentType,
        truncated: typeof value.body === 'string' && value.body.length === 0,
        cacheId: value.cacheId,
        contentLength: value.contentLength,
        cacheSlice: value.cacheSlice,
      }),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => {
      if (typeof args.cacheId === 'string' && args.cacheId !== '') {
        const title = `cache:${args.cacheId.slice(0, 8)}`
        return { card: 'generic', title, kind: 'fetch', rawInput: title }
      }
      const title = `${String(args.method || 'GET')} ${String(args.url || '')}`
      return { card: 'generic', title, kind: 'fetch', rawInput: String(args.url || '') }
    },
    presentResult: (args, result) => {
      if (result.isError) return undefined
      const meta = result.meta
      if (!meta || typeof meta !== 'object') return undefined
      const url = typeof meta.url === 'string' ? meta.url : String(args.url || '')
      const method = typeof meta.method === 'string' ? meta.method : 'GET'
      const statusCode = typeof meta.statusCode === 'number' ? meta.statusCode : 0
      return {
        card: 'web',
        kind: 'fetch',
        title: `${method} ${url}`,
        url,
        statusCode,
        truncated: Boolean(meta.truncated),
      }
    },
    async execute(args, exec) {
      const url = String(args.url || '').trim()
      const cacheId = typeof args.cacheId === 'string' ? args.cacheId.trim() : ''
      if ((url === '') === (cacheId === '')) {
        throw new Error('http_request: provide exactly one of `url` or `cacheId`')
      }
      let cliArgs
      let method = String(args.method || 'GET').toUpperCase()
      if (cacheId !== '') {
        // Paging path — original method/headers/body are already baked
        // into the cache entry on the server, so we send only the paging
        // args. `method` stays whatever the caller passed so the result
        // echoes it correctly. The `http` subcommand is load-bearing: the
        // http paging path returns an http-shaped entry (`body` field); a
        // bare --cache-id used to route to the fetch path (`content`
        // field), which this handler read as an empty body.
        cliArgs = ['http', '--cache-id', cacheId]
        if (Number.isInteger(args.offset) && args.offset >= 0) {
          cliArgs.push('--offset', String(args.offset))
        }
        if (Number.isInteger(args.limit) && args.limit >= 1) {
          cliArgs.push('--limit', String(args.limit))
        }
      } else {
        if (!/^https?:\/\//i.test(url)) throw new Error('http_request: an http(s) URL is required')
        cliArgs = ['-X', method, url, '-t', String(((args.timeoutSec ?? 25) * 1000) | 0)]
        if (config && config.ssrfProtection === false) cliArgs.push('--allow-private-network')
        if (config && config.redirectProtection === false) cliArgs.push('--no-redirect-protection')
        if (config && config.protocolLock === false) cliArgs.push('--no-protocol-lock')
        if (args.followRedirects === false) cliArgs.push('--no-follow')
        if (args.body !== undefined) cliArgs.push('-d', String(args.body))
        if (typeof args.contentType === 'string') cliArgs.push('--content-type', args.contentType)
        if (args.headers && typeof args.headers === 'object') {
          cliArgs.push('--headers', JSON.stringify(args.headers))
        }
      }
      const entry = await runCli(cliArgs, exec.signal, config)
      if (entry.status !== 'ok') {
        const attempt = Array.isArray(entry.attempts) && entry.attempts[0]
        throw new Error(
          `http_request: ${entry.summary || 'unavailable'}${attempt ? ` (${attempt.stage || 'request'}: ${attempt.error})` : ''}`,
        )
      }
      return {
        url: typeof entry.url === 'string' && entry.url !== '' ? entry.url : url,
        finalUrl: entry.finalUrl,
        method: typeof entry.method === 'string' && entry.method !== '' ? entry.method : method,
        statusCode: entry.statusCode,
        statusText: entry.statusText || '',
        contentType: entry.contentType || '',
        headers: Array.isArray(entry.headers) ? entry.headers : [],
        body: entry.body || '',
        warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
        // Cache paging descriptor — only present when the server degraded
        // the response (>20 KB) or the caller is paging a slice.
        ...(typeof entry.cacheId === 'string' ? { cacheId: entry.cacheId } : {}),
        ...(Number.isInteger(entry.contentLength) ? { contentLength: entry.contentLength } : {}),
        ...(entry.cacheSlice && typeof entry.cacheSlice === 'object'
          ? { cacheSlice: toHostCacheSlice(entry.cacheSlice) }
          : {}),
      }
    },
  })
  ctx.systemPrompt.section({
    name: 'tool:http_request',
    order: 112,
    text:
      'Use the http_request tool for low-level API calls (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS). Returns final status code, response headers, and decoded body. SSRF-protected. If the response carries a `cacheId`, the body was truncated to ~20 KB for transport — pass that `cacheId` back to `http_request` (with optional `offset`/`limit`) to page through the remainder without re-issuing the request. `url` and `cacheId` are mutually exclusive.',
  })
}

function renderConfigEvidence(value) {
  const lines = []
  if (value.status === 'error') {
    lines.push(`[error: ${value.error || 'set refused'}]`)
  }
  lines.push(
    `action: ${value.action}`,
    '',
    'Config:',
    JSON.stringify(value.config, null, 2),
  )
  if (value.persisted === true) lines.push('', '(persisted to disk)')
  return lines.join('\n')
}

/**
 * web_config — let the model read the live dsh-network config and,
 * when the user has flipped the "允许修改设置" safety toggle, apply
 * a partial patch. The toggle is read at call time so the user can
 * enable it from the settings page and have the very next
 * web_config.set pick it up without a plugin reload.
 *
 * `get` always works (the model needs to see the current values to
 * make targeted edits). `set` requires `config.allowConfigEdit === true`;
 * otherwise the tool returns a soft `error` status instead of throwing,
 * so the model can react to the gate and surface a message back to the
 * user without the call blowing up the conversation.
 *
 * The toggle ITSELF is hidden from the model — neither echoed on
 * `get` nor accepted on `set`. Surfacing it would let a single
 * botched `set({ allowConfigEdit: false, … })` lock the model out
 * for the rest of the session; surfacing it as a read field would
 * at best confuse the model and at worst let it reason its way into
 * the same outcome via a multi-step sequence. The user is the only
 * actor that can flip the toggle, and they do it from the browser's
 * 网络 → 安全 section. The set error message is how the model learns
 * the gate exists at all.
 */
function registerWebConfigTool(ctx, config) {
  ctx.tools.register({
    name: 'web_config',
    description:
      'Read or modify the dsh-network configuration. `action: "get"` returns the live config. `action: "set"` applies a partial patch to the same fields the browser UI edits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set'],
          description: '"get" reads the live config; "set" applies a partial patch.',
        },
        patch: {
          ...WEB_CONFIG_PATCH_SCHEMA,
          description:
            'Partial patch to apply. Required when action is "set", ignored otherwise. Same shape as the loopback route accepts (see the per-field descriptions). Note: the safety toggle is intentionally not part of this schema.',
        },
      },
    },
    output: {
      schema: WEB_CONFIG_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderConfigEvidence(value) }],
      presentationMeta: (_args, value) => compactPresentation({
        status: value.status,
        action: value.action,
        error: value.error,
        persisted: value.persisted,
      }),
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `web_config ${String(args.action || '')}`,
      kind: 'config',
      rawInput: String(args.action || ''),
    }),
    presentResult: (args, result) => {
      if (result.isError) return undefined
      const meta = result.meta
      if (!meta || typeof meta !== 'object') return undefined
      return {
        card: 'generic',
        kind: 'config',
        title: `web_config ${String(args.action || '')}`,
        meta: {
          status: meta.status,
          error: meta.error,
          persisted: meta.persisted,
        },
      }
    },
    async execute(args, exec) {
      const action = String(args.action || '').toLowerCase()
      if (action !== 'get' && action !== 'set') {
        throw new Error('web_config: action must be "get" or "set"')
      }
      // Both branches use the model-facing view so the live `config`
      // payload omits `allowConfigEdit`. The user-facing `summarize()`
      // keeps the field for the browser UI's toggle in the safety card.
      if (action === 'get') {
        return {
          status: 'ok',
          action: 'get',
          config: summarizeForModel(config),
        }
      }
      // action === 'set'
      if (config.allowConfigEdit !== true) {
        return {
          status: 'error',
          action: 'set',
          config: summarizeForModel(config),
          error:
            'web_config: set is disabled. The user must enable the `allowConfigEdit` (允许修改设置) safety toggle in the network settings → 安全 section before the model can modify dsh-network configuration.',
        }
      }
      const patch = args.patch
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('web_config: patch must be a JSON object')
      }
      // Belt-and-braces: drop any field the JSON Schema does not list, so
      // a model trying to write `githubToken` / `searchEngineApiKeys`
      // (the secret fields) gets silently filtered before reaching the
      // host config. `summarizeForModel()` already omits secrets from the
      // response, but this also keeps them out of the write path.
      const filtered = {}
      for (const key of Object.keys(WEB_CONFIG_PATCH_SCHEMA.properties)) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          filtered[key] = patch[key]
        }
      }
      const ok = applyCardSettings(config, filtered)
      if (ok && ok.ok === false) {
        return {
          status: 'error',
          action: 'set',
          config: summarizeForModel(config),
          error: ok.error || 'patch rejected',
        }
      }
      // Persist to disk (best effort — a failed write keeps the
      // in-memory change so the rest of this session keeps working, the
      // same contract the browser UI's PUT route has).
      let persisted = true
      try {
        savePersistedConfig(config)
      } catch (error) {
        persisted = false
        ctx.logger?.warn?.(
          '[dsh-network] web_config patch NOT persisted to %s: %s',
          PERSIST_FILE,
          error?.message ?? String(error),
        )
      }
      return {
        status: 'ok',
        action: 'set',
        config: summarizeForModel(config),
        persisted,
      }
    },
  })
  ctx.systemPrompt.section({
    name: 'tool:web_config',
    order: 113,
    text:
      'Use the web_config tool to read or modify the dsh-network configuration. `action: "get"` returns the live config. `action: "set"` applies a partial patch to the same fields the browser UI edits. Before calling set, prefer calling get first so the patch reflects current values.',
  })
}

function renderSitemapEvidence(value) {
  const lines = []
  if (value.status === 'unavailable') {
    lines.push('[unavailable: web_sitemap returned no usable entry]')
  }
  lines.push(value.summary || '')
  const entries = Array.isArray(value.entries) ? value.entries : []
  if (entries.length > 0) {
    lines.push('', 'Portals:')
    entries.forEach((entry, index) => {
      const lang = entry.language ? ` [${entry.language}]` : ''
      const region = entry.region ? ` (${entry.region})` : ''
      const tail = entry.hasSearchUrl ? ' — has search URL' : ''
      lines.push(
        `${index + 1}. ${entry.domain}${lang}${region} (p${entry.priority}, ${entry.category})${tail} — ${entry.description}`,
      )
    })
  }
  const resolved = Array.isArray(value.resolved) ? value.resolved : []
  if (resolved.length > 0) {
    lines.push('', 'Resolved search URLs:')
    for (const r of resolved) lines.push(`- ${r.domain}: ${r.url}`)
  }
  if (typeof value.digest === 'string' && value.digest !== '') {
    lines.push('', 'Digest:', value.digest)
  }
  if (Array.isArray(value.uncertainty) && value.uncertainty.length > 0) {
    lines.push('', `Uncertain: ${value.uncertainty.join('; ')}`)
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `Warnings: ${value.warnings.join('; ')}`)
  }
  return lines.join('\n')
}

/**
 * web_sitemap — look up authoritative domains from a curated portals table
 * before falling back to generic web_search. The CLI side already enforces
 * the closed category vocabulary, priority thresholds, and search-URL
 * template resolution; this host wrapper just translates the JSON envelope
 * into the dsh tool contract.
 *
 * Empty / no-match results are *not* errors: the model should treat them as
 * a soft miss and fall back to web_search, hence no throw on `ok`+empty.
 */
function registerWebSitemapTool(ctx, config) {
  ctx.tools.register({
    name: 'web_sitemap',
    description:
      'Look up authoritative portals in a curated table of ~90 commonly-useful domains (arxiv, MDN, crates.io, Stack Overflow, …). Returns matching entries with category, priority, language/region, and an optional pre-filled search URL when a domain and query are both given. Prefer this before web_search when you already know the topic kind (academic, code repo, package registry, Q&A, encyclopedia, vendor manual, …). If the table returns no useful entry, fall back to web_search.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'Free-text fuzzy match against description / tags. Omit when filtering by category or looking up a single domain.',
        },
        category: {
          type: 'string',
          enum: WEB_SITEMAP_CATEGORIES,
          description: 'Filter to one closed-set category (e.g. `academic`, `docs`, `package-registries`).',
        },
        domain: {
          type: 'string',
          description: 'Exact domain lookup. Combine with `query` to also receive a resolved search URL.',
        },
        minPriority: {
          type: 'integer',
          description: 'Minimum priority threshold (1-10; 10 = always-use).',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of entries to return (1-20, default 10).',
        },
        digest: {
          type: 'boolean',
          description: 'Include a compact Markdown digest of the matching entries (useful for prompt priming).',
        },
      },
    },
    output: {
      schema: SITEMAP_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSitemapEvidence(value) }],
      presentationMeta: (_args, value) => ({
        engine: value.engine,
        count: Array.isArray(value.entries) ? value.entries.length : 0,
        resolvedCount: Array.isArray(value.resolved) ? value.resolved.length : 0,
        uncertainty: value.uncertainty,
        warnings: value.warnings,
      }),
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => {
      const title = typeof args.domain === 'string' && args.domain !== ''
        ? args.domain
        : typeof args.category === 'string' && args.category !== ''
          ? args.category
          : typeof args.query === 'string' && args.query !== ''
            ? args.query
            : 'web_sitemap'
      return { card: 'generic', title, kind: 'search', rawInput: title }
    },
    presentResult: (args, result) => {
      if (result.isError) return undefined
      const meta = result.meta
      if (!meta || typeof meta !== 'object') return undefined
      const count = typeof meta.count === 'number' ? meta.count : 0
      const title = typeof args.domain === 'string' && args.domain !== ''
        ? args.domain
        : typeof args.query === 'string' && args.query !== ''
          ? args.query
          : 'web_sitemap'
      return { card: 'generic', kind: 'search', title, sources: [], truncated: false, meta: { count } }
    },
    async execute(args, exec) {
      const cliArgs = ['web_sitemap']
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const domain = typeof args.domain === 'string' ? args.domain.trim().toLowerCase() : ''
      const category = typeof args.category === 'string' ? args.category.trim() : ''
      const minPriority = args.minPriority
      const limit = args.limit === undefined ? 10 : Number(args.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new Error('web_sitemap: limit must be an integer in [1, 20]')
      }
      if (query !== '') cliArgs.push('-q', query)
      if (domain !== '') cliArgs.push('--domain', domain)
      if (category !== '') cliArgs.push('-c', category)
      if (Number.isInteger(minPriority) && minPriority >= 1 && minPriority <= 10) {
        cliArgs.push('-p', String(minPriority))
      }
      cliArgs.push('--limit', String(limit))
      if (args.digest === true) cliArgs.push('--digest')
      // Soft path: an `unavailable` sitemap entry is a soft miss (fall back
      // to web_search), so runCliSoft never throws on status.
      const entry = await runCliSoft(cliArgs, exec.signal, config)
      return {
        status: entry.status,
        engine: 'web_sitemap',
        summary: entry.summary,
        entries: Array.isArray(entry.entries) ? entry.entries : [],
        resolved: Array.isArray(entry.resolved) ? entry.resolved : [],
        digest: typeof entry.digest === 'string' ? entry.digest : '',
        uncertainty: Array.isArray(entry.uncertainty) ? entry.uncertainty : [],
        warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
      }
    },
  })
  ctx.systemPrompt.section({
    name: 'tool:web_sitemap',
    order: 108,
    text:
      `Use the web_sitemap tool FIRST when you need to look up authoritative web sources for a known topic kind (academic preprints, code repos, package registries, Q&A sites, encyclopedia, vendor manuals, standards, AI platforms, datasets, etc.). It returns curated portal entries with category, priority, and optional pre-filled search URLs (use \`domain\` + \`query\` together to get a ready-to-fetch URL). When the table returns no relevant entry or the topic is too open-ended / current-events oriented, fall back to web_search.`,
  })
}

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

function summarize(config) {
  // Build a JSON-safe view of the resolved config; never echo API keys —
  // only the `hasApiKey` boolean that the editor card needs to render its
  // status dot.
  const allowlist = Array.isArray(config.allowlist) ? config.allowlist : []
  const engines = Array.isArray(config.searchEngines) ? config.searchEngines : []
  const cfgMap = config.searchEngineConfigs && typeof config.searchEngineConfigs === 'object' ? config.searchEngineConfigs : {}
  const searchEngineConfigs = {}
  for (const id of engines) {
    const entry = cfgMap[id]
    if (!entry || typeof entry !== 'object') continue
    searchEngineConfigs[id] = {
      endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : undefined,
      hasApiKey: !!entry.hasApiKey,
      options: entry.options && typeof entry.options === 'object' ? entry.options : {},
    }
  }
  return {
    enabled: config.enabled !== false,
    fetchTimeoutMs: config.fetchTimeoutMs,
    searchTimeoutMs: config.searchTimeoutMs,
    httpTimeoutMs: config.httpTimeoutMs,
    maxBodyChars: config.maxBodyChars,
    maxRedirects: config.maxRedirects,
    searchEngines: engines,
    searchEngineConfigs,
    searchMaxResults: config.searchMaxResults,
    userAgent: config.userAgent,
    allowlist,
    // The three network protections, all defaulting to ON. The legacy
    // `allowPrivateNetwork` view (inverted SSRF toggle) is kept for
    // browser bundles that predate the rename.
    ssrfProtection: config.ssrfProtection !== false,
    redirectProtection: config.redirectProtection !== false,
    protocolLock: config.protocolLock !== false,
    allowPrivateNetwork: config.ssrfProtection === false,
    httpMethods: config.httpMethods,
    // GitHub: the token itself never leaves the host — the browser only
    // sees whether one is configured (write-only, like engine API keys).
    hasGithubToken: typeof config.githubToken === 'string' && config.githubToken !== '',
    githubIndexes: Array.isArray(config.githubIndexes) ? config.githubIndexes : [],
    githubSort: GITHUB_SORTS.includes(config.githubSort) ? config.githubSort : 'best',
    webSearchTool: config.webSearchTool !== false,
    webFetchTool: config.webFetchTool !== false,
    httpRequestTool: config.httpRequestTool !== false,
    webSitemapTool: config.webSitemapTool !== false,
    webConfigTool: config.webConfigTool !== false,
    // Safety toggle that gates web_config.set (see SafetyFields in
    // dsh/client.js). The browser UI renders the corresponding switch
    // in the 网络 → 安全 section; the model NEVER sees this field —
    // it would let the model toggle its own write gate and the
    // "model locked itself out" footgun is exactly what we are trying
    // to avoid. web_config.set returning a soft error is how the model
    // learns the gate exists.
    allowConfigEdit: config.allowConfigEdit === true,
  }
}

/**
 * Model-facing view of the config. Same shape as `summarize()`, minus
 * the user-only fields. `allowConfigEdit` is stripped because the
 * model must not be able to read its own gate — otherwise a single
 * `set` that happens to include `allowConfigEdit: false` would lock
 * the model out for the rest of the session. `webConfigTool` is
 * stripped too for symmetry: the model can't toggle whether its own
 * tool is registered, and exposing the field would only invite
 * confusion.
 *
 * Secrets are already filtered by `summarize()` (no `githubToken`
 * leak; only `hasGithubToken`).
 */
function summarizeForModel(config) {
  const { allowConfigEdit: _allowConfigEdit, ...rest } = summarize(config)
  void _allowConfigEdit
  return rest
}

function applyCardSettings(config, patch) {
  if (patch === null || typeof patch !== 'object') {
    return { ok: false, error: 'expected a JSON object body' }
  }
  // Live-mutate the config object the caller owns. Settings are read at
  // call time, so this takes effect immediately.
  if (typeof patch.fetchTimeoutMs === 'number' && patch.fetchTimeoutMs >= 1) {
    config.fetchTimeoutMs = Math.floor(patch.fetchTimeoutMs)
  }
  if (typeof patch.searchTimeoutMs === 'number' && patch.searchTimeoutMs >= 1) {
    config.searchTimeoutMs = Math.floor(patch.searchTimeoutMs)
  }
  if (typeof patch.httpTimeoutMs === 'number' && patch.httpTimeoutMs >= 1) {
    config.httpTimeoutMs = Math.floor(patch.httpTimeoutMs)
  }
  if (typeof patch.maxBodyChars === 'number' && patch.maxBodyChars >= 1) {
    config.maxBodyChars = Math.floor(patch.maxBodyChars)
  }
  if (typeof patch.maxRedirects === 'number' && patch.maxRedirects >= 0) {
    config.maxRedirects = Math.floor(patch.maxRedirects)
  }
  if (Array.isArray(patch.searchEngines)) {
    config.searchEngines = patch.searchEngines.filter((s) => typeof s === 'string')
  }
  if (patch.searchEngineConfigs && typeof patch.searchEngineConfigs === 'object') {
    const next = config.searchEngineConfigs && typeof config.searchEngineConfigs === 'object' ? config.searchEngineConfigs : {}
    const nextKeys = config.searchEngineApiKeys && typeof config.searchEngineApiKeys === 'object' ? config.searchEngineApiKeys : {}
    for (const id of Object.keys(patch.searchEngineConfigs)) {
      const incoming = patch.searchEngineConfigs[id]
      if (!incoming || typeof incoming !== 'object') continue
      const prev = next[id] && typeof next[id] === 'object' ? next[id] : {}
      // The browser dialog ships the real API key only when the user typed
      // a non-empty value; empty / missing means "keep whatever was stored".
      // The key itself never leaves the host (browser only sees hasApiKey).
      if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim() !== '') {
        nextKeys[id] = incoming.apiKey
      }
      next[id] = {
        endpoint: typeof incoming.endpoint === 'string' ? incoming.endpoint : prev.endpoint,
        hasApiKey: typeof incoming.apiKey === 'string' && incoming.apiKey.trim() !== ''
          ? true
          : typeof incoming.hasApiKey === 'boolean'
            ? incoming.hasApiKey
            : prev.hasApiKey === true,
        options: incoming.options && typeof incoming.options === 'object'
          ? incoming.options
          : prev.options && typeof prev.options === 'object' ? prev.options : {},
      }
    }
    config.searchEngineConfigs = next
    config.searchEngineApiKeys = nextKeys
  }
  if (typeof patch.searchMaxResults === 'number' && patch.searchMaxResults >= 1) {
    config.searchMaxResults = Math.min(20, Math.floor(patch.searchMaxResults))
  }
  if (typeof patch.userAgent === 'string') {
    config.userAgent = patch.userAgent
  }
  if (Array.isArray(patch.allowlist)) {
    config.allowlist = patch.allowlist.filter((s) => typeof s === 'string')
  }
  // The three network protections. `ssrfProtection` (positive framing,
  // ON by default) supersedes the legacy inverted `allowPrivateNetwork`
  // key: when both arrive in one patch, the new key wins.
  if (typeof patch.ssrfProtection === 'boolean') {
    config.ssrfProtection = patch.ssrfProtection
  } else if (typeof patch.allowPrivateNetwork === 'boolean') {
    config.ssrfProtection = !patch.allowPrivateNetwork
  }
  if (typeof patch.redirectProtection === 'boolean') {
    config.redirectProtection = patch.redirectProtection
  }
  if (typeof patch.protocolLock === 'boolean') {
    config.protocolLock = patch.protocolLock
  }
  if (Array.isArray(patch.httpMethods)) {
    config.httpMethods = patch.httpMethods.filter((m) => /^[A-Z]+$/.test(String(m).toUpperCase()))
  }
  // GitHub engine settings. The token is write-only: a non-empty string
  // stores the key, an explicit empty string clears it, and an absent
  // field keeps whatever was stored. The browser never reads it back.
  if (typeof patch.githubToken === 'string') {
    config.githubToken = patch.githubToken
  }
  if (Array.isArray(patch.githubIndexes)) {
    config.githubIndexes = patch.githubIndexes.filter((s) => typeof s === 'string' && GITHUB_INDEX_IDS.includes(s))
  }
  if (typeof patch.githubSort === 'string' && GITHUB_SORTS.includes(patch.githubSort)) {
    config.githubSort = patch.githubSort
  }
  // Safety toggle: gate the web_config tool's set action. The browser UI
  // can flip it; the model itself only writes it through web_config.set,
  // which is itself gated by the existing value of this flag (so the
  // model cannot escalate from off to on — it would have to ask the
  // user to flip it from the settings page).
  if (typeof patch.allowConfigEdit === 'boolean') {
    config.allowConfigEdit = patch.allowConfigEdit
  }
  return { ok: true }
}

function isLoopbackHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ──────────────────────────────── apply ────────────────────────────
function defaultConfig(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {}
  const searchEngines = Array.isArray(c.searchEngines) && c.searchEngines.length > 0
    ? c.searchEngines.filter((s) => typeof s === 'string')
    : ['bing', 'duckduckgo', 'baidu']
  const searchEngineConfigs = {}
  if (c.searchEngineConfigs && typeof c.searchEngineConfigs === 'object') {
    for (const id of Object.keys(c.searchEngineConfigs)) {
      const entry = c.searchEngineConfigs[id]
      if (!entry || typeof entry !== 'object') continue
      searchEngineConfigs[id] = {
        endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : undefined,
        hasApiKey: entry.hasApiKey === true,
        options: entry.options && typeof entry.options === 'object' ? entry.options : {},
      }
    }
  }
  // SearXNG is self-hosted, so its endpoint is part of the config surface
  // (editable in the settings UI, injected into the CLI as
  // DSH_NETWORK_SEARXNG_URL). Seed the loopback default so the UI shows it
  // SearXNG is self-hosted, so its endpoint is part of the config surface
  // (editable in the settings UI, injected into the CLI as
  // DSH_NETWORK_SEARXNG_URL). Seed the loopback default so the UI shows it
  // pre-filled even when the row config carries no searchEngineConfigs.
  if (!searchEngineConfigs.searxng) {
    searchEngineConfigs.searxng = {
      endpoint: 'http://127.0.0.1:8888',
      hasApiKey: false,
      options: {},
    }
  }
  return {
    enabled: c.enabled !== false,
    userAgent: typeof c.userAgent === 'string' && c.userAgent
      ? c.userAgent
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0',
    allowlist: Array.isArray(c.allowlist) ? c.allowlist.filter((s) => typeof s === 'string') : [],
    // All three protections default ON. `ssrfProtection` supersedes the
    // legacy `allowPrivateNetwork` key (which was the inverted toggle):
    // an explicit new key wins, otherwise a persisted `allowPrivateNetwork:
    // true` maps to protection off, and absent keys mean ON.
    ssrfProtection:
      c.ssrfProtection !== undefined ? c.ssrfProtection !== false : c.allowPrivateNetwork !== true,
    redirectProtection: c.redirectProtection !== false,
    protocolLock: c.protocolLock !== false,
    fetchTimeoutMs: Number.isInteger(c.fetchTimeoutMs) && c.fetchTimeoutMs > 0 ? c.fetchTimeoutMs : 25_000,
    searchTimeoutMs: Number.isInteger(c.searchTimeoutMs) && c.searchTimeoutMs > 0 ? c.searchTimeoutMs : 15_000,
    httpTimeoutMs: Number.isInteger(c.httpTimeoutMs) && c.httpTimeoutMs > 0 ? c.httpTimeoutMs : 25_000,
    maxBodyChars: Number.isInteger(c.maxBodyChars) && c.maxBodyChars > 0 ? c.maxBodyChars : 3_000_000,
    maxRedirects: Number.isInteger(c.maxRedirects) && c.maxRedirects >= 0 ? c.maxRedirects : 3,
    searchEngines,
    searchEngineConfigs,
    // Carried through from the seed (row config or the persisted snapshot):
    // the loopback route stores engine API keys here, and without this the
    // keys would be rebuilt as `{}` on every restart even though the rest of
    // the config survived.
    searchEngineApiKeys:
      c.searchEngineApiKeys && typeof c.searchEngineApiKeys === 'object'
        ? { ...c.searchEngineApiKeys }
        : {},
    searchMaxResults: Number.isInteger(c.searchMaxResults) && c.searchMaxResults > 0 ? c.searchMaxResults : 10,
    githubToken: typeof c.githubToken === 'string' ? c.githubToken : '',
    githubIndexes: Array.isArray(c.githubIndexes)
      ? c.githubIndexes.filter((s) => typeof s === 'string' && GITHUB_INDEX_IDS.includes(s))
      : [],
    githubSort: GITHUB_SORTS.includes(c.githubSort) ? c.githubSort : 'best',
    webSearchTool: c.webSearchTool !== false,
    webFetchTool: c.webFetchTool !== false,
    httpRequestTool: c.httpRequestTool !== false,
    webSitemapTool: c.webSitemapTool !== false,
    // web_config exposes the live config to the model. The set action is
    // gated by this safety toggle (network settings → 安全 → "允许修改设置"
    // / "Allow the model to modify settings"); off by default so the
    // user has to opt in before the model can write. get always works.
    allowConfigEdit: c.allowConfigEdit === true,
    // The tool registration itself is gated by this flag (default ON, in
    // line with the other tools) so deployments that want to drop the
    // web_config surface entirely can do so via the cordis row config.
    webConfigTool: c.webConfigTool !== false,
    httpMethods: Array.isArray(c.httpMethods) && c.httpMethods.length > 0
      ? c.httpMethods.map((m) => String(m).toUpperCase()).filter((m) => /^[A-Z]+$/.test(m))
      : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  }
}

export function apply(ctx, rawConfig) {
  // Durable overlay: the persisted snapshot (written by the loopback route on
  // every UI save, see registerConfigRoute) wins over the cordis row config,
  // so UI edits survive restarts. `enabled` is never part of the snapshot and
  // is stripped here too — the row config is the only kill-switch, so a
  // hand-edited file cannot disable the plugin past the route that could
  // re-enable it. Delete the file to reset to row config.
  const persisted = loadPersistedConfig()
  if (persisted.error) {
    ctx.logger?.warn?.(
      '[dsh-network] ignoring unreadable config file %s: %s',
      persisted.file,
      persisted.error.message ?? String(persisted.error),
    )
  }
  const persistedOverlay = persisted.value ? { ...persisted.value } : null
  if (persistedOverlay) delete persistedOverlay.enabled
  const seed = persistedOverlay ? { ...(rawConfig ?? {}), ...persistedOverlay } : rawConfig
  const config = defaultConfig(seed)
  if (!config.enabled) {
    ctx.logger?.info?.('[dsh-network] disabled by config')
    return
  }

  // ── eager server start + lifecycle binding ─────────────────────────────
  // One persistent `dsh-network server` child handles every tool call. We
  // spawn it at apply() so the first user-visible invocation doesn't pay
  // the cold-start cost (Node + undici + officeparser ≈ a couple seconds
  // on Windows). The effect disposer below binds the child to this cordis
  // fiber — the server dies when dsh unloads, alongside the providers and
  // tools registered below.
  //
  // ensure() failure here is logged but NOT fatal: a misconfigured dist
  // (missing cli.cjs, port already taken, …) shouldn't block the whole
  // plugin from loading, and the tool execute paths will surface a clear
  // error on first use. The compact summary's eager strategy is preserved
  // by retrying on every invoke() — serverClient respawns on death.
  const client = getNetworkClient()
  client.ensure().catch((error) => {
    ctx.logger?.warn?.(
      '[dsh-network] failed to pre-warm server (will retry on first tool call): %s',
      error?.message ?? String(error),
    )
  })
  ctx.logger?.info?.('[dsh-network] server client initialized (pid=%s)', client.pid)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void client.dispose()
    })
  }

  // ── providers into the web seam ─────────────────────────────────────────
  const searchProvider = makeSearchProvider(config)
  const fetchProvider = makeFetchProvider(config)

  // Both providers live on ctx.web and degrade gracefully in headless
  // contexts where ctx.web may not exist.
  if (ctx.web && typeof ctx.web.registerSearchProvider === 'function') {
    ctx.web.registerSearchProvider({
      id: searchProvider.id,
      available: searchProvider.available,
      search: searchProvider.search,
    })
  }
  if (ctx.web && typeof ctx.web.registerFetchProvider === 'function') {
    ctx.web.registerFetchProvider({
      id: fetchProvider.id,
      available: fetchProvider.available,
      fetch: fetchProvider.fetch,
    })
  }

  // ── model-facing tools ─────────────────────────────────────────────────
  if (config.webSearchTool) registerWebSearchTool(ctx, config)
  if (config.webFetchTool) registerWebFetchTool(ctx, config)
  if (config.httpRequestTool) registerHttpRequestTool(ctx, config)
  if (config.webSitemapTool) registerWebSitemapTool(ctx, config)
  if (config.webConfigTool !== false) registerWebConfigTool(ctx, config)

  // ── settings: NO settings-namespace registration, own durable file ─────
  // A `dsh-network` namespace in the settings document would be persisted,
  // but this plugin's runtime reads the cordis row config (cordis.patch.yml)
  // plus the live in-memory object the loopback route edits — a persisted
  // `dsh-network:` section would silently do nothing and mislead users.
  // Durability instead comes from `dsh/persist.js`: every successful UI save
  // snapshots the live config to ~/.dsh/dsh-network.json (atomic write), and
  // `apply()` above reloads it, so UI edits survive restarts.
  // The browser surface is the dedicated "网络" settings section
  // (`settings.section`, in dsh/client.js) talking to the loopback route
  // below; the legacy Plugins-tab card stays dormant in stock profiles.
  registerConfigRoute(ctx, config)
  registerHealthRoute(ctx)

  ctx.logger?.info?.(
    '[dsh-network] active (engines=%s, fetchTimeoutMs=%d, httpTimeoutMs=%d, tools: search=%s fetch=%s http=%s sitemap=%s config=%s, allowConfigEdit=%s)',
    config.searchEngines.join(','),
    config.fetchTimeoutMs,
    config.httpTimeoutMs,
    String(config.webSearchTool),
    String(config.webFetchTool),
    String(config.httpRequestTool),
    String(config.webSitemapTool),
    String(config.webConfigTool),
    String(config.allowConfigEdit),
  )
}
