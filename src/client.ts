/**
 * dsh-network HTTP client — the low-level transport layer.
 *
 * This file owns exactly one job: talking to a remote HTTP(S) server and
 * returning the RAW response. It never formats, never parses markup, never
 * extracts links or visible text — the caller (web_fetch, the search
 * engines, the http_request tool) decides how to interpret the raw body.
 *
 * Responsibilities:
 *   - One HTTP/1.1 request to one URL with one set of headers and an
 *     optional body.
 *   - Per-redirect SSRF guarantees: every hop is re-validated against the
 *     allowlist + private-IP rules BEFORE the connection happens, and the
 *     socket is then pinned to the validated IP via an undici dispatcher.
 *   - Redirect protection (on by default): a hop may only stay on the same
 *     domain as the previous hop.
 *   - Protocol lock (on by default): a hop may not switch between http and
 *     https (no downgrade, no upgrade).
 *   - The body cap, redirect cap, and overall timeout are enforced from
 *     one `AbortSignal`, so a slow body cannot hang past the deadline.
 *   - Plain text + a known set of text-like MIME types come through;
 *     binary content is refused with the same vocabulary the netcap
 *     plugin used.
 *
 * What this file deliberately does not own:
 *   - HTML → Markdown, link extraction, visible-text extraction. See
 *     `fetch.ts` (web_fetch formatting) and `html-extract.ts`.
 *   - Search engines. See `engines/*` and `cli.ts`.
 *   - The low-level http_request tool plumbing (custom method, body,
 *     response headers). See `http_request.ts`, which reuses the SSRF
 *     primitives from this file.
 */
import { Agent, type Dispatcher } from 'undici'
import { promises as dns } from 'node:dns'
import {
  classifyFetchError,
  hasHeader,
  hostAllowed,
  isFakeIpv4,
  isIpv4Literal,
  isPrivateIpv4,
  isPrivateIpv6Literal,
  parseHttpUrl,
  resolveRedirect,
  sameRedirectDomain,
  sameRedirectProtocol,
  type ParsedHttpUrl,
} from './network.ts'
import { BROWSER_FETCH_BASE } from './engines/header-profiles.ts'

export interface FetchOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  contentType?: string
  timeoutMs?: number
  maxBytes?: number
  maxChars?: number
  maxRedirects?: number
  userAgent?: string
  allowlist?: readonly string[]
  /** When true, allow loopback / private / reserved ranges. Off by default. */
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
  /** Override Node's own DNS lookup with this function (test seam). */
  lookup?: (host: string, options: { all?: boolean }, callback: LookupCallback) => void
}

export interface PinnedTarget {
  address: string
  family: 4 | 6
  url: URL
  parsed: ParsedHttpUrl
}

export type LookupCallback =
  | ((err: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void)
  | ((err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: 4 | 6 }>) => void)

/**
 * Default User-Agent and Accept for non-engine `runClientFetch` calls.
 * Pulled from `engines/header-profiles.ts` so the bare client path
 * carries the same Firefox-shaped headers the search chain does —
 * static sites that gate on Sec-Fetch-* behave the same way for both.
 */
const DEFAULT_USER_AGENT = String(BROWSER_FETCH_BASE['User-Agent'] ?? '')
const DEFAULT_ACCEPT = String(BROWSER_FETCH_BASE.Accept ?? '')
const DEFAULT_TIMEOUT_MS = 25_000
const DEFAULT_MAX_BYTES = 7 * 1024 * 1024
const DEFAULT_MAX_CHARS = 100_000
const DEFAULT_MAX_REDIRECTS = 3

export async function resolveLookup(
  hostname: string,
  lookup: FetchOptions['lookup'] | undefined,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (lookup) {
    return new Promise((resolve, reject) => {
      const cb: LookupCallback = (err, ...rest) => {
        if (err) {
          reject(err)
          return
        }
        if (Array.isArray(rest[0])) {
          resolve(rest[0])
        } else {
          resolve([{ address: rest[0] as string, family: rest[1] as 4 | 6 }])
        }
      }
      try {
        lookup(hostname, { all: true }, cb)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  // Node's default DNS, all records so we can pick a non-RFC-2544 / non-private IP.
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  return records.map((r) => ({ address: r.address, family: r.family as 4 | 6 }))
}

/**
 * Verify the URL is safe to fetch: parses, enforces allowlist, resolves all
 * addresses, refuses private/reserved ranges, and returns one pinned IP.
 *
 * The contract: a successful return means the next call to `undici` against
 * `pinned.url` with a dispatcher using `pinned.address`/`pinned.family`
 * will land on this validated endpoint, even if DNS later changes.
 */
export async function assertSafeRemoteTarget(
  urlString: string,
  allowPrivate: boolean,
  allowlist: readonly string[] = [],
  lookup?: FetchOptions['lookup'],
): Promise<PinnedTarget> {
  const parsed = parseHttpUrl(urlString)
  const url = new URL(parsed.scheme + '://' + (parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host) + parsed.path)

  if (allowlist.length > 0 && !hostAllowed(parsed.host, allowlist)) {
    throw classBlocked(`Domain "${parsed.host}" is not in the dsh-network allowlist (SSRF protection)`)
  }

  if (isIpv4Literal(parsed.host)) {
    if (!allowPrivate && isPrivateIpv4(parsed.host)) {
      throw classBlocked(`dsh-network denied: ${parsed.host} is a private/reserved address (SSRF protection)`)
    }
    return { address: parsed.host, family: 4, url, parsed }
  }
  if (parsed.host.includes(':')) {
    if (!allowPrivate && isPrivateIpv6Literal(parsed.host)) {
      throw classBlocked(`dsh-network denied: ${parsed.host} is a private/reserved address (SSRF protection)`)
    }
    return { address: parsed.host, family: 6, url, parsed }
  }

  const records = await resolveLookup(parsed.host, lookup).catch((error) => {
    throw classBlocked(`DNS resolution failed for "${parsed.host}": ${(error as Error).message}`)
  })
  if (records.length === 0) {
    throw classBlocked(`DNS resolution failed for "${parsed.host}" (no usable addresses)`)
  }
  if (!allowPrivate) {
    for (const r of records) {
      if (r.family === 4 && isPrivateIpv4(r.address)) {
        throw classBlocked(`dsh-network denied: "${parsed.host}" resolves to private/reserved address ${r.address} (SSRF protection)`)
      }
      if (r.family === 6 && isPrivateIpv6Literal(r.address)) {
        throw classBlocked(`dsh-network denied: "${parsed.host}" resolves to private/reserved address ${r.address} (SSRF protection)`)
      }
    }
  }
  const first = records[0]!
  // Skip the pin when the IP is RFC 2544 fake-IP (198.18/15). Pinning would
  // connect to the proxy's fake address; we must let the real DNS play.
  if (first.family === 4 && isFakeIpv4(first.address)) return { address: first.address, family: 4, url, parsed }
  return first.family === 6 ? { address: first.address, family: 6, url, parsed } : { address: first.address, family: 4, url, parsed }
}

/** Throws a tagged Error carrying the `WEB_FETCH_BLOCKED` fingerprint for callers. */
export function classBlocked(message: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.code = 'WEB_FETCH_BLOCKED'
  return error
}

function isTextLikeContentType(contentTypeHeader: string): boolean {
  const t = (contentTypeHeader || '').trim().toLowerCase()
  if (!t) return true
  if (t.startsWith('text/')) return true
  return (
    t.includes('json') ||
    t.includes('xml') ||
    t.includes('html') ||
    t.includes('javascript') ||
    t.includes('x-www-form-urlencoded')
  )
}

function isBinaryContentType(contentTypeHeader: string): boolean {
  const t = (contentTypeHeader || '').split(';')[0]!.trim().toLowerCase()
  return (
    t.startsWith('image/') ||
    t.startsWith('audio/') ||
    t.startsWith('video/') ||
    t.startsWith('font/') ||
    t === 'application/zip' ||
    t === 'application/octet-stream' ||
    t === 'application/x-tar' ||
    t === 'application/x-bzip2' ||
    t === 'application/x-7z-compressed' ||
    t === 'application/x-rar-compressed' ||
    t === 'application/x-msdownload' ||
    t === 'application/x-msi' ||
    t === 'application/x-shockwave-flash'
  )
}

/**
 * Document MIME types that web_fetch parses through `officeparser` to
 * Markdown. These are deliberately NOT in `isBinaryContentType` above —
 * the transport layer hands them back as a raw `Uint8Array` so the
 * formatting layer can run a real document parser on them.
 *
 * OOXML mimes share the `application/vnd.openxmlformats-officedocument.*`
 * prefix; ODF family shares `application/vnd.oasis.opendocument.*`.
 */
function isDocumentContentType(contentTypeHeader: string): boolean {
  const t = (contentTypeHeader || '').split(';')[0]!.trim().toLowerCase()
  if (!t) return false
  if (t === 'application/pdf') return true
  if (t === 'application/epub+zip') return true
  if (t.startsWith('application/vnd.openxmlformats-officedocument.')) return true
  if (t.startsWith('application/vnd.oasis.opendocument.')) return true
  return false
}

function parseCharset(contentTypeHeader: string): string | null {
  const matched = /charset=([^;\s]+)/i.exec(contentTypeHeader)
  return matched && matched[1] ? matched[1].trim().toLowerCase().replace(/^"|"$/g, '') : null
}

/**
 * Build an undici dispatcher whose DNS lookup is hard-wired to one pinned IP.
 *
 * `minVersion: 'TLSv1.3'` is not optional: undici's default TLS stack
 * produces a ClientHello fingerprint (BoringSSL / NSS-style extension
 * order) that Engine's anti-bot recognises as a non-browser client and
 * answers with off-topic results for the same query that a real browser
 * gets answered correctly.
 */
export function pinnedDispatcherLike(pinned: PinnedTarget): Dispatcher {
  return new Agent({
    connect: {
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      lookup: ((_hostname: string, options: { all?: boolean } | undefined, callback: LookupCallback) => {
        const record = { address: pinned.address, family: pinned.family }
        if (options && options.all) {
          callback(null, [record])
        } else {
          const single = callback as unknown as (err: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void
          single(null, pinned.address, pinned.family)
        }
      }) as unknown as Dispatcher['connect']['lookup'],
    },
  })
}

export interface ClientResult {
  url: string
  finalUrl: string
  status: number
  statusText: string
  contentType: string
  /**
   * Response headers (lowercased names). Exposed so callers can read
   * rate-limit metadata (e.g. GitHub's `x-ratelimit-*`) without a second
   * request. Absent from older callers' expectations: always populated
   * for successful text responses, `{}` otherwise.
   */
  headers: Record<string, string>
  /**
   * The raw decoded response body, trimmed to `maxChars`. For HTML/XML
   * responses this is the raw markup (tags intact); for plain text it is
   * the raw text. Never tag-stripped, never whitespace-collapsed — that
   * is the caller's job.
   *
   * Empty for document responses (see `bodyBuffer`); text callers should
   * branch on `isDocument` first.
   */
  body: string
  /**
   * Raw bytes for document responses (PDF / OOXML / ODF / EPUB). The
   * text-decoding path would corrupt these payloads, so the transport
   * skips charset decoding and returns the bytes verbatim. `undefined`
   * for non-document responses.
   */
  bodyBuffer?: Uint8Array
  /** True when the response content type is HTML/XML markup. */
  isHtml: boolean
  /**
   * True when the response content type is a document format that
   * web_fetch parses through `officeparser` (PDF / DOCX / PPTX / XLSX
   * / ODT / ODP / ODS / EPUB). Callers should read `bodyBuffer`,
   * not `body`.
   */
  isDocument: boolean
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
    engine: string
  }
}

/**
 * Fetch one URL and return the raw body plus transport metadata.
 * Pure transport: no formatting, no markup parsing, no link extraction.
 */
export async function runClientFetch(options: FetchOptions): Promise<ClientResult> {
  const url = options.url
  const method = (options.method ?? 'GET').toUpperCase()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  const allowlist = options.allowlist ?? []
  const allowPrivateNetwork = options.allowPrivateNetwork ?? false
  const redirectProtection = options.redirectProtection ?? true
  const protocolLock = options.protocolLock ?? true

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid timeoutMs.')
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Invalid maxBytes.')
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new Error('Invalid maxChars.')
  if (!Number.isFinite(maxRedirects) || maxRedirects < 0) throw new Error('Invalid maxRedirects.')

  const engine = 'local'
  const headers: Record<string, string> = { 'user-agent': userAgent, accept: DEFAULT_ACCEPT }
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      headers[k.toLowerCase()] = v
    }
  }
  if (options.body !== undefined) {
    if (options.contentType && !hasHeader(headers, 'content-type')) {
      headers['content-type'] = options.contentType
    }
  }

  let currentUrl = url
  const redirectChain: string[] = []
  const deadline = AbortSignal.timeout(timeoutMs)
  const dispatchers: Dispatcher[] = []

  try {
    for (let i = 0; i <= maxRedirects; i++) {
      const pinned = await assertSafeRemoteTarget(currentUrl, allowPrivateNetwork, allowlist, options.lookup)
      const dispatcher = pinnedDispatcherLike(pinned)
      dispatchers.push(dispatcher)

      const accept = headers['accept'] ?? DEFAULT_ACCEPT
      const reqHeaders: Record<string, string> = { ...headers, accept }
      const reqInit: RequestInit & { dispatcher?: Dispatcher; body?: BodyInit | null } = {
        method,
        headers: reqHeaders,
        signal: deadline,
        redirect: 'manual',
        dispatcher,
      }
      if (options.body !== undefined) {
        reqInit.body = typeof options.body === 'string' ? options.body : new TextDecoder('utf-8').decode(options.body)
      }
      const response = await fetch(pinned.url, reqInit).catch((err) => {
        const cls = classifyFetchError(err)
        if (cls.code === 'TIMEOUT') throw new Error(`Request timed out after ${timeoutMs} ms.`)
        throw new Error(`Request failed for ${pinned.url.toString()}: ${cls.message}`)
      })

      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location = response.headers.get('location')
        if (!location) throw new Error(`Redirect response (${response.status}) missing location header.`)
        if (i === maxRedirects) throw new Error(`Too many redirects. Max redirects: ${maxRedirects}.`)
        const nextUrl = resolveRedirect(currentUrl, location)
        // Redirect protection: the hop must stay on the same domain.
        if (redirectProtection && !sameRedirectDomain(currentUrl, nextUrl)) {
          throw classBlocked(`Redirect protection: cross-domain redirect blocked (${currentUrl} → ${nextUrl})`)
        }
        // Protocol lock: no http ↔ https switch on redirect hops.
        if (protocolLock && !sameRedirectProtocol(currentUrl, nextUrl)) {
          throw classBlocked(`Protocol lock: http/https switch blocked (${currentUrl} → ${nextUrl})`)
        }
        redirectChain.push(currentUrl)
        currentUrl = nextUrl
        continue
      }

      const contentType = response.headers.get('content-type') || ''
      if (isDocumentContentType(contentType)) {
        // Documents bypass the text decoder — pass the raw bytes through
        // to `bodyBuffer` so the formatting layer can run officeparser.
        const body = await readBodyWithLimit(response, maxBytes, timeoutMs)
        const truncated = body.length >= maxBytes
        return {
          url: url,
          finalUrl: currentUrl,
          status: response.status,
          statusText: response.statusText,
          contentType,
          headers: Object.fromEntries(response.headers.entries()),
          body: '',
          bodyBuffer: body,
          isHtml: false,
          isDocument: true,
          meta: {
            fetchedAt: new Date().toISOString(),
            bytes: body.length,
            truncated,
            redirectChain,
            timeoutMs,
            maxBytes,
            maxChars,
            privateNetworkAllowed: allowPrivateNetwork,
            redirectProtection,
            protocolLock,
            engine,
          },
        }
      }
      if (isBinaryContentType(contentType)) {
        throw new Error(`Refusing non-text content-type "${contentType.split(';')[0]}"; binary content is not returned.`)
      }
      if (!isTextLikeContentType(contentType) && contentType !== '') {
        throw new Error(`Unsupported content-type: ${contentType}. Only text-like content is allowed.`)
      }

      const body = await readBodyWithLimit(response, maxBytes, timeoutMs)
      const charset = parseCharset(contentType) ?? 'utf-8'
      let decoded: string
      try {
        decoded = new TextDecoder(charset).decode(body)
      } catch {
        decoded = new TextDecoder('utf-8').decode(body)
      }
      const trimmed = trimToMaxChars(decoded, maxChars)

      return {
        url: url,
        finalUrl: currentUrl,
        status: response.status,
        statusText: response.statusText,
        contentType,
        headers: Object.fromEntries(response.headers.entries()),
        body: trimmed.text,
        isHtml: /html|xml/i.test(contentType.split(';')[0] ?? ''),
        isDocument: false,
        meta: {
          fetchedAt: new Date().toISOString(),
          bytes: body.length,
          truncated: trimmed.truncated,
          redirectChain,
          timeoutMs,
          maxBytes,
          maxChars,
          privateNetworkAllowed: allowPrivateNetwork,
          redirectProtection,
          protocolLock,
          engine,
        },
      }
    }
    throw new Error('Failed to fetch target URL.')
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
    if (Number.isFinite(v) && v > maxBytes) {
      throw new Error(`Response body exceeds max size ${maxBytes} bytes.`)
    }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read().catch((err) => {
      const cls = classifyFetchError(err)
      if (cls.code === 'TIMEOUT') throw new Error(`Request timed out after ${timeoutMs} ms while reading the body.`)
      throw err
    })
    if (done) break
    if (!value) continue
    total += value.length
    if (total > maxBytes) throw new Error(`Response body exceeds max size ${maxBytes} bytes.`)
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

function trimToMaxChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}
