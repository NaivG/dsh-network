/**
 * dsh-network — model-facing tool registrations (host side).
 *
 * The `ctx.tools.register` blocks (web_search / web_fetch /
 * http_request / web_config / web_sitemap / web_download) plus their
 * systemPrompt sections. Split out of index.js. The `parameters: { … },\n    output: {`
 * shape below is load-bearing: tests/schema-check.mjs extracts those
 * blocks textually, so keep the formatting stable.
 */
import { savePersistedConfig, PERSIST_FILE } from './persist.js'
import { runCli, runCliSoft } from './cli-runner.js'
import {
  SEARCH_OUTPUT_SCHEMA,
  FETCH_OUTPUT_SCHEMA,
  HTTP_OUTPUT_SCHEMA,
  DOWNLOAD_OUTPUT_SCHEMA,
  WEB_CONFIG_OUTPUT_SCHEMA,
  WEB_CONFIG_PATCH_SCHEMA,
  pickConfigPatch,
  WEB_SITEMAP_CATEGORIES,
  SITEMAP_OUTPUT_SCHEMA,
} from './schemas.js'
import {
  compactPresentation,
  jsonSafeMeta,
  previewText,
  toHostCacheSlice,
  toSearchSources,
  renderSearchEvidence,
  renderFetchEvidence,
  renderHttpEvidence,
  renderConfigEvidence,
  renderSitemapEvidence,
  renderDownloadEvidence,
} from './evidence.js'
import { summarizeForModel, applyCardSettings } from './config-summary.js'

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
      // The 网络 → 工具 toggle is read LIVE: flipping it off in the settings
      // page disables both the model-facing tool and the sidebar search
      // panel's backend route (registerSearchRoute) on the next call.
      if (config.webSearchTool === false) {
        throw new Error('web_search is disabled by the network settings (网络 → 工具)')
      }
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
      presentationMeta: (args, value) => compactPresentation({
        url: value.finalUrl,
        statusCode: value.statusCode,
        truncated: Array.isArray(value.warnings) && value.warnings.some((w) => /truncated/i.test(w)),
        contentType: value.contentType,
        engine: value.engine,
        // The card-side toolview (dsh/client.toolviews.js WebFetchToolview)
        // shows the page itself, so the markdown body has to ride along in
        // the persisted meta — same cap, same trailing `…` marker as
        // http_request's bodyPreview (both go through `previewText`), so the
        // row can tell a clipped preview from a complete one.
        contentPreview: previewText(value.content),
        // `format` is an ARGUMENT, not part of the output envelope: a `raw`
        // body is bytes, not markdown, and the row must not push it through
        // MarkdownText. Read it off the call args instead of widening
        // FETCH_OUTPUT_SCHEMA for a card-only concern.
        format:
          args && typeof args.format === 'string' && args.format.toLowerCase() === 'raw'
            ? 'raw'
            : 'markdown',
        warnings: value.warnings,
        uncertainty: value.uncertainty,
        linksCount: Array.isArray(value.links) ? value.links.length : 0,
        // The outgoing links themselves, capped like the http headers list —
        // the row renders them as an audit trail of where the page pointed.
        links: Array.isArray(value.links) ? value.links.slice(0, 40) : [],
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
      // The 网络 → 工具 toggle is read LIVE (see the matching guard in the
      // web_search tool): flipping it off fails fast instead of silently
      // running a tool the user switched off.
      if (config.webFetchTool === false) {
        throw new Error('web_fetch is disabled by the network settings (网络 → 工具)')
      }
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
        statusText: value.statusText,
        contentType: value.contentType,
        // The card-side toolview (dsh/client.js HttpRequestToolview) shows
        // the body inline. The full body can be ~20 KB after the server-side
        // degrade; cap here at the same inline cap so the JSON envelope
        // never balloons the persisted `meta`. Lossless JSON still holds
        // because every key is `string` or `number` and `compactPresentation`
        // drops the absent fields entirely.
        bodyPreview: previewText(value.body),
        headers: Array.isArray(value.headers)
          ? value.headers.slice(0, 40)
          : [],
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
      if (config.httpRequestTool === false) {
        throw new Error('http_request is disabled by the network settings (网络 → 工具)')
      }
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

// ───────────────────────────── web_download tool ────────────────────────────

/**
 * web_download — save one URL's bytes to a file.
 *
 * The gap this fills is not "web_fetch refuses binary" (that refusal is
 * correct — an inline blob of base64 tells the model nothing and breaks the
 * transport budget). It is that the model's ONLY other route to a file is
 * `pwsh` + curl, which bypasses every guarantee this plugin makes: no
 * allowlist, no private-IP rejection, no same-domain redirect lock, no TLS
 * and UA pinning. One injected page is enough to aim that at a cloud
 * metadata endpoint and drop the answer in the workspace. Routing the write
 * through the same `runClientFetch` transport is the whole point.
 *
 * Registered only when `config.downloadTool === true` (see index.js), and
 * the flag is read here too so a mid-session flip closes the door instead of
 * leaving a live registration behind.
 *
 * `dest` is an enum rather than the `workspace: bool` this started as: a
 * bare boolean is read wrong, and `workspace: true` in a transcript tells
 * nobody WHICH workspace. The enum also carries the default (tmp), which a
 * boolean cannot.
 */
function registerWebDownloadTool(ctx, config) {
  ctx.tools.register({
    name: 'web_download',
    description:
      'Download one HTTP(S) URL to a file on disk and return its path. Use this for binary payloads web_fetch refuses (images, archives, media, fonts) — for text pages and documents use web_fetch, which returns readable Markdown. SSRF-protected exactly like the other tools: private/reserved addresses are blocked unless allowlisted, and redirects stay on one domain. The file lands in the OS temp directory by default (`dest: "tmp"`); pass `dest: "workspace"` only when the user wants a file they will keep. Returns the absolute path, byte size and the type the bytes actually turned out to be — the extension follows the payload, not the URL.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'The HTTP(S) URL to download.' },
        dest: {
          type: 'string',
          enum: ['tmp', 'workspace'],
          description:
            'Where to write. "tmp" (default) → the OS temp directory, disposable. "workspace" → the user\'s workspace `downloads/` folder, for files the user wants to keep.',
        },
        filename: {
          type: 'string',
          description:
            'Preferred filename. Still sanitized, and the extension is decided by the payload itself — a name that disagrees with the bytes is corrected and reported.',
        },
      },
    },
    output: {
      schema: DOWNLOAD_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderDownloadEvidence(value) }],
      presentationMeta: (_args, value) =>
        compactPresentation({
          url: value.finalUrl,
          statusCode: value.statusCode,
          contentType: value.contentType,
          engine: value.engine,
          // The row's whole job is "here is the file, here is where it went".
          path: value.path,
          filename: value.filename,
          dest: value.dest,
          bytes: value.bytes,
          warnings: value.warnings,
          uncertainty: value.uncertainty,
        }),
    },
    // A large file takes much longer than a page render, and the download
    // cap (100 MB by default) is generous enough that a slow origin would
    // otherwise sit here until the harness kills it.
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => {
      const rawInput = String(args.url || '')
      return { card: 'generic', title: rawInput, kind: 'download', rawInput }
    },
    presentResult: (args, result) => {
      if (result.isError) return undefined
      const meta = result.meta
      if (!meta || typeof meta !== 'object') return undefined
      const url = typeof meta.url === 'string' ? meta.url : String(args.url || '')
      return {
        card: 'web',
        kind: 'download',
        title: typeof meta.filename === 'string' && meta.filename !== '' ? meta.filename : url,
        url,
        statusCode: typeof meta.statusCode === 'number' ? meta.statusCode : 0,
        truncated: false,
      }
    },
    async execute(args, exec) {
      if (config.downloadTool !== true) {
        throw new Error('web_download is disabled by the network settings (网络 → 工具 → 下载文件)')
      }
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//i.test(url)) throw new Error('web_download: an http(s) URL is required')
      const dest = args.dest === 'workspace' ? 'workspace' : 'tmp'
      if (dest === 'workspace' && !config.workspaceDir) {
        throw new Error('web_download: the workspace destination is not available in this host')
      }
      const cliArgs = ['download', '-u', url, '--dest', dest, '-t', '110000']
      if (typeof args.filename === 'string' && args.filename.trim() !== '') {
        cliArgs.push('--filename', args.filename.trim())
      }
      if (config && config.ssrfProtection === false) cliArgs.push('--allow-private-network')
      if (config && config.redirectProtection === false) cliArgs.push('--no-redirect-protection')
      if (config && config.protocolLock === false) cliArgs.push('--no-protocol-lock')
      const entry = await runCli(cliArgs, exec.signal, config)
      if (entry.status !== 'ok') {
        const attempt = Array.isArray(entry.attempts) && entry.attempts[0]
        throw new Error(
          `web_download: ${entry.summary || 'unavailable'}${attempt ? ` (${attempt.stage || 'download'}: ${attempt.error})` : ''}`,
        )
      }
      return {
        url: typeof entry.url === 'string' && entry.url !== '' ? entry.url : url,
        finalUrl: entry.finalUrl || url,
        statusCode: entry.statusCode,
        contentType: entry.contentType || '',
        engine: entry.engine,
        summary: entry.summary,
        path: entry.path || '',
        filename: entry.filename || '',
        dest: entry.dest === 'workspace' ? 'workspace' : 'tmp',
        bytes: Number.isInteger(entry.bytes) ? entry.bytes : 0,
        uncertainty: Array.isArray(entry.uncertainty) ? entry.uncertainty : [],
        warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
      }
    },
  })
  ctx.systemPrompt.section({
    name: 'tool:web_download',
    order: 113,
    text:
      'Use the web_download tool to save a binary file (image, archive, media, font) to disk — web_fetch and http_request return text and refuse binary content. It returns an absolute `path` you can pass to another tool; the extension reflects the payload, so trust `filename`/`contentType` over the URL. Default `dest` is the OS temp dir and may be cleaned up: use `dest: "workspace"` only when the user wants to keep the file. Executable extensions (.exe/.ps1/.sh/…) are refused, as are transfers past the size cap.',
  })
}

// ───────────────────────────── web_config tool ────────────────────────────

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
      // The card row needs more than the verb. It renders the live config the
      // call just read or wrote — secret-free by construction, because
      // `summarizeForModel()` drops `allowConfigEdit` (the model must not read
      // its own write gate), `githubToken` and every engine API key down to a
      // boolean — plus the field NAMES a `set` actually forwarded.
      //
      // `jsonSafeMeta` is what keeps that nested object lossless; see its doc
      // comment. `summarize()` emits `endpoint: undefined` for an engine with
      // no endpoint override, and `JSON.stringify` drops a nested undefined,
      // so persisting the summary raw would trip the harness's deep
      // round-trip check on the first call after such a config exists.
      presentationMeta: (args, value) => compactPresentation({
        status: value.status,
        action: value.action,
        error: value.error,
        persisted: value.persisted,
        config: jsonSafeMeta(value.config),
        // Only a patch that LANDED is a change. The safety gate and
        // applyCardSettings' own rejections both answer `status: 'error'` with
        // the live config untouched, so echoing the requested field names there
        // would draw edits that never happened.
        changes: value.action === 'set' && value.status === 'ok'
          ? Object.keys(pickConfigPatch(args.patch))
          : undefined,
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
      // response, but this also keeps them out of the write path. The card's
      // 变更 list names the same fields, so the filter has ONE home
      // (`pickConfigPatch`) rather than a copy per reader.
      const filtered = pickConfigPatch(patch)
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

// ─────────────────────────── web_sitemap tool ─────────────────────────────

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
      'Look up authoritative portals in a curated table of 178 commonly-useful domains (arxiv, MDN, crates.io, Stack Overflow, …). Returns matching entries with category, priority, language/region, and an optional pre-filled search URL when a domain and query are both given. Prefer this before web_search when you already know the topic kind (academic, code repo, package registry, Q&A, encyclopedia, vendor manual, …). If the table returns no useful entry, fall back to web_search.',
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
        status: value.status,
        count: Array.isArray(value.entries) ? value.entries.length : 0,
        // The card-side toolview (dsh/client.js WebSitemapToolview) lists
        // every matched portal as a row, plus any pre-filled search URL the
        // CLI resolved. The full entries / resolved objects ride along in
        // the meta envelope so the row can render without re-running the
        // tool call.
        entries: Array.isArray(value.entries)
          ? value.entries.slice(0, 20).map((entry) => ({
              domain: entry.domain,
              description: entry.description,
              category: entry.category,
              priority: entry.priority,
              hasSearchUrl: entry.hasSearchUrl === true,
              language: typeof entry.language === 'string' ? entry.language : '',
              region: typeof entry.region === 'string' ? entry.region : '',
              tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 12) : [],
            }))
          : [],
        resolved: Array.isArray(value.resolved) ? value.resolved.slice(0, 20) : [],
        resolvedCount: Array.isArray(value.resolved) ? value.resolved.length : 0,
        summary: typeof value.summary === 'string' ? value.summary : '',
        digest: typeof value.digest === 'string' ? value.digest : '',
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
      if (config.webSitemapTool === false) {
        throw new Error('web_sitemap is disabled by the network settings (网络 → 工具)')
      }
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

export {
  registerWebSearchTool,
  registerWebFetchTool,
  registerHttpRequestTool,
  registerWebConfigTool,
  registerWebSitemapTool,
  registerWebDownloadTool,
}
