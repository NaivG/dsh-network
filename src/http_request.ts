/**
 * Low-level HTTP request path for the `http_request` tool.
 *
 * Different from the web_fetch formatting layer (`fetch.ts`):
 *   - The tool exposes arbitrary methods (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS),
 *     custom headers, JSON or raw bodies, and the full response headers.
 *   - It never converts to Markdown, never strips scripts, and never rejects
 *     text-only MIME types: this is for "use the API", not "read the page".
 *   - It returns a richer structure (`headers[]` is faithfully preserved)
 *     because the canonical value lives in `tool/result.meta` and feeds the
 *     dedicated block renderer.
 *
 * SSRF guarantees are the same: per-redirect target re-validation + pinned
 * dispatcher, identical to `client.ts`. Reusing `assertSafeRemoteTarget`
 * keeps the two paths consistent. Redirect protection (same-domain hops)
 * and the protocol lock (no http ↔ https switch) apply here too.
 */
import type { Dispatcher } from 'undici'
import { classifyFetchError, appendQuery, hasHeader, parseHttpUrl, sameRedirectDomain, sameRedirectProtocol } from './network.ts'
import { assertSafeRemoteTarget, classBlocked, pinnedDispatcherLike } from './client.ts'

export interface HttpRequestOptions {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  contentType?: string
  timeoutMs: number
  followRedirects?: boolean
  maxBytes?: number
  maxChars?: number
  userAgent?: string
  allowlist?: readonly string[]
  allowPrivateNetwork?: boolean
  /**
   * Redirect protection: only same-domain redirect hops are followed.
   * On by default.
   */
  redirectProtection?: boolean
  /**
   * Protocol lock: redirect hops may not switch between http and https.
   * On by default.
   */
  protocolLock?: boolean
}

export interface HttpRequestResult {
  url: string
  finalUrl: string
  method: string
  status: number
  statusText: string
  contentType: string
  headers: Array<{ name: string; value: string }>
  body: string
  meta: {
    fetchedAt: string
    bytes: number
    truncated: boolean
    redirectChain: string[]
    timeoutMs: number
    maxBytes: number
    maxChars: number
    privateNetworkAllowed: boolean
    redirectProtection: boolean
    protocolLock: boolean
    engine: 'undici-direct'
  }
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_CHARS = 100_000
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0'

/**
 * Build the final URL: parses the base, attaches query params, returns the
 * canonical URL. Pure function; mirrors the original `appendQuery` use case.
 */
export function buildRequestUrl(base: string, query: unknown): string {
  return appendQuery(base, query)
}

/** Convenience re-export with a stable name for the tests + client renderer. */
export const htmlRequestUrl = buildRequestUrl

export async function runHttpRequest(options: HttpRequestOptions): Promise<HttpRequestResult> {
  const url = options.url
  const method = options.method.toUpperCase()
  const timeoutMs = options.timeoutMs
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  const followRedirects = options.followRedirects !== false
  const allowlist = options.allowlist ?? []
  const allowPrivate = options.allowPrivateNetwork ?? false
  const redirectProtection = options.redirectProtection ?? true
  const protocolLock = options.protocolLock ?? true

  if (!/^https?:\/\//i.test(url)) throw new Error(`http_request: URL must start with http:// or https://`)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('http_request: invalid timeoutMs')

  const requestHeaders: Record<string, string> = { 'user-agent': userAgent }
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      requestHeaders[k.toLowerCase()] = v
    }
  }
  if (options.body !== undefined) {
    if (options.contentType && !hasHeader(requestHeaders, 'content-type')) {
      requestHeaders['content-type'] = options.contentType
    }
  }

  let currentUrl = url
  const redirectChain: string[] = []
  const deadline = AbortSignal.timeout(timeoutMs)
  const dispatchers: Dispatcher[] = []

  try {
    let hops = 0
    while (true) {
      const parsed = parseHttpUrl(currentUrl)
      const u = new URL(parsed.scheme + '://' + (parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host) + parsed.path)
      const pinned = await assertSafeRemoteTarget(currentUrl, allowPrivate, allowlist)
      const dispatcher: Dispatcher = pinnedDispatcherLike(pinned)
      dispatchers.push(dispatcher)

      const reqInit: RequestInit & { dispatcher?: Dispatcher; body?: BodyInit | null } = {
        method,
        headers: requestHeaders,
        signal: deadline,
        redirect: 'manual',
        dispatcher,
      }
      if (options.body !== undefined) reqInit.body = options.body
      const response = await fetch(u, reqInit).catch((err) => {
        const msg = (err as { message?: string }).message ?? String(err)
        throw new Error(`http_request failed for ${u.toString()}: ${msg}`)
      })

      if (
        followRedirects &&
        response.status >= 300 &&
        response.status < 400 &&
        response.status !== 304
      ) {
        const location = response.headers.get('location')
        if (!location) throw new Error(`http_request: redirect response (${response.status}) missing location header.`)
        hops += 1
        if (hops > 10) throw new Error('http_request: too many redirects.')
        const next = new URL(location, currentUrl).toString()
        // Redirect protection: the hop must stay on the same domain.
        if (redirectProtection && !sameRedirectDomain(currentUrl, next)) {
          throw classBlocked(`Redirect protection: cross-domain redirect blocked (${currentUrl} → ${next})`)
        }
        // Protocol lock: no http ↔ https switch on redirect hops.
        if (protocolLock && !sameRedirectProtocol(currentUrl, next)) {
          throw classBlocked(`Protocol lock: http/https switch blocked (${currentUrl} → ${next})`)
        }
        redirectChain.push(currentUrl)
        currentUrl = next
        continue
      }

      const headerRecord: Array<{ name: string; value: string }> = []
      response.headers.forEach((value, name) => headerRecord.push({ name, value }))

      const bodyBytes = await readBodyWithLimit(response, maxBytes, timeoutMs)
      const ct = response.headers.get('content-type') || ''
      const charsetMatch = /charset=([^;\s]+)/i.exec(ct)
      const charset = charsetMatch && charsetMatch[1] ? charsetMatch[1].toLowerCase() : 'utf-8'
      let decoded: string
      try {
        decoded = new TextDecoder(charset).decode(bodyBytes)
      } catch {
        decoded = new TextDecoder('utf-8').decode(bodyBytes)
      }
      const capped = decoded.length > maxChars
      const body = capped ? decoded.slice(0, maxChars) : decoded

      return {
        url,
        finalUrl: currentUrl,
        method,
        status: response.status,
        statusText: response.statusText,
        contentType: ct,
        headers: headerRecord,
        body,
        meta: {
          fetchedAt: new Date().toISOString(),
          bytes: bodyBytes.length,
          truncated: capped,
          redirectChain,
          timeoutMs,
          maxBytes,
          maxChars,
          privateNetworkAllowed: allowPrivate,
          redirectProtection,
          protocolLock,
          engine: 'undici-direct',
        },
      }
    }
  } finally {
    await Promise.allSettled(dispatchers.map((d) => d.close().catch(() => {})))
  }
}

async function readBodyWithLimit(response: Response, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  const body = response.body
  if (!body) return new Uint8Array()
  const contentLength = response.headers.get('content-length')
  if (contentLength) {
    const v = Number.parseInt(contentLength, 10)
    if (Number.isFinite(v) && v > maxBytes) throw new Error(`http_request: response body exceeds max size ${maxBytes} bytes.`)
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read().catch((err) => {
      const cls = classifyFetchError(err)
      if (cls.code === 'TIMEOUT') throw new Error(`http_request timed out after ${timeoutMs} ms while reading the body.`)
      throw err
    })
    if (done) break
    if (!value) continue
    total += value.length
    if (total > maxBytes) throw new Error(`http_request: response body exceeds max size ${maxBytes} bytes.`)
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}
