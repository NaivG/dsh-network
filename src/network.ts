/**
 * Pure network helpers: URL parsing, redirect resolution, SSRF address checks,
 * host allowlist matching, request-header helpers.
 *
 * Originally lived in the host-side `http.js` as CommonJS and used both by the
 * curl driver and the undici driver. After the architecture change:
 *
 *   - These helpers are still pure and dependency-free; they unit-test in
 *     milliseconds and back every fetch / http_request path.
 *   - The plumbing moved: `client.ts` (`undici` IP-pinned dispatcher) and
 *     `http_request.ts` (undici direct) reuse these helpers and stop spawning
 *     `curl.exe` / `nslookup.exe` entirely.
 */

export interface ParsedHttpUrl {
  scheme: 'http' | 'https'
  host: string
  port: string
  /** Path, including the leading `/`, query, and fragment. */
  path: string
}

export class AbortError extends Error {
  override readonly name = 'AbortError'
  constructor(message = 'operation aborted') {
    super(message)
  }
}

export function isIpv4Literal(s: string): boolean {
  const parts = s.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

export function isPrivateIpv4(s: string): boolean {
  const parts = s.split('.').map(Number)
  const a = parts[0] ?? 0
  const b = parts[1] ?? 0
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a >= 224) return true
  return false
}

export function isPrivateIpv6Literal(host: string): boolean {
  const s = host.toLowerCase()
  if (s === '::1' || s === '::') return true
  if (s.startsWith('fc') || s.startsWith('fd')) return true
  if (s.startsWith('fe80')) return true
  return false
}

/**
 * True when the host is a loopback / private / reserved target the SSRF
 * guard would block: `localhost`, private IPv4 literals, private IPv6
 * literals. Hostnames that merely *resolve* privately are not knowable
 * without DNS, so this stays a static check — callers that need that
 * case (e.g. the SearXNG engine's configured endpoint) resolve at
 * request time and rely on the per-request allow-private flag.
 */
export function isPrivateHost(host: string): boolean {
  const h = String(host).toLowerCase()
  if (h === 'localhost' || h === '[::1]') return true
  if (isIpv4Literal(h)) return isPrivateIpv4(h)
  if (h.includes(':')) return isPrivateIpv6Literal(h)
  return false
}

/**
 * RFC 2544 benchmarking space (198.18/15) used by transparent proxies and
 * Clash / Surge's fake-IP DNS. Non-routable, so it is not an SSRF target;
 * pinning a connection would point it at the proxy's fake IP.
 */
export function isFakeIpv4(s: string): boolean {
  const parts = s.split('.').map(Number)
  return parts[0] === 198 && (parts[1] ?? 0) >= 18 && (parts[1] ?? 0) <= 19
}

export function parseHttpUrl(raw: string): ParsedHttpUrl {
  const s = String(raw).trim()
  if (s.length === 0) throw new Error('url must not be empty')
  if (/\s/.test(s)) throw new Error('url must not contain whitespace')
  let rest = s
  let scheme: 'http' | 'https' = 'http'
  if (rest.toLowerCase().startsWith('https://')) {
    scheme = 'https'
    rest = rest.slice(8)
  } else if (rest.toLowerCase().startsWith('http://')) {
    scheme = 'http'
    rest = rest.slice(7)
  } else {
    throw new Error('url scheme must be http:// or https://')
  }
  const slash = rest.search(/[/?#]/)
  const authority = slash === -1 ? rest : rest.slice(0, slash)
  const tail = slash === -1 ? '' : rest.slice(slash)
  const at = authority.lastIndexOf('@')
  const bare = at >= 0 ? authority.slice(at + 1) : authority
  let host = bare
  let port = ''
  if (bare.startsWith('[')) {
    const close = bare.indexOf(']')
    if (close < 0) throw new Error('invalid IPv6 host in url')
    host = bare.slice(1, close)
    const after = bare.slice(close + 1)
    if (after.startsWith(':')) port = after.slice(1)
    else if (after.length > 0) throw new Error('invalid host in url')
  } else {
    const colon = bare.lastIndexOf(':')
    if (colon >= 0) {
      host = bare.slice(0, colon)
      port = bare.slice(colon + 1)
      if (port.length > 0 && !/^\d+$/.test(port)) throw new Error('invalid port in url')
    }
  }
  if (!host) throw new Error('url has no host')
  return { scheme, host, port, path: tail || '/' }
}

export function hostPortOf(parsed: ParsedHttpUrl): string {
  return parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host
}

export function resolveRedirect(base: string, ref: string): string {
  if (/^https?:\/\//i.test(ref)) return ref
  if (ref.startsWith('//')) {
    const p = parseHttpUrl(base)
    return `${p.scheme}:${ref}`
  }
  const p = parseHttpUrl(base)
  if (ref.startsWith('/')) return `${p.scheme}://${hostPortOf(p)}${ref}`
  const dir = p.path.slice(0, p.path.lastIndexOf('/') + 1) || '/'
  return `${p.scheme}://${hostPortOf(p)}${dir}${ref}`
}

/**
 * Redirect protection: true when `base` and `next` stay on the SAME domain
 * (hostname, case-insensitive; port differences are allowed — a port change
 * is not a domain change). Any parse failure (e.g. a non-http(s) redirect
 * target) yields false so the caller blocks the hop.
 */
export function sameRedirectDomain(base: string, next: string): boolean {
  try {
    const a = parseHttpUrl(base)
    const b = parseHttpUrl(next)
    return a.host.toLowerCase() === b.host.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Protocol lock: true when `base` and `next` use the SAME scheme (http or
 * https). Redirects may neither downgrade (https → http) nor upgrade
 * (http → https) while the lock is on. Parse failures yield false.
 */
export function sameRedirectProtocol(base: string, next: string): boolean {
  try {
    const a = parseHttpUrl(base)
    const b = parseHttpUrl(next)
    return a.scheme === b.scheme
  } catch {
    return false
  }
}

/** Tessera-style allowlist: '*', '*.suffix', or exact host. */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase()
  for (const raw of patterns) {
    const p = String(raw).trim().toLowerCase()
    if (!p) continue
    if (p === '*') return true
    if (p.startsWith('*.')) {
      const suffix = p.slice(1)
      if (h.endsWith(suffix) && h.length > suffix.length) return true
    } else if (p === h) {
      return true
    }
  }
  return false
}

export function appendQuery(url: string, query: unknown): string {
  if (!query || typeof query !== 'object') return url
  const entries = Object.entries(query as Record<string, unknown>).filter(
    ([, v]) => v !== undefined && v !== null,
  )
  if (entries.length === 0) return url
  const qs = entries
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'string' ? v : String(v)))
    .join('&')
  return url + (url.includes('?') ? '&' : '?') + qs
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const needle = String(name).toLowerCase()
  return Object.keys(headers).some((k) => k.toLowerCase() === needle)
}

/** Standard error mapping for `undici` / Node fetch — replace the netcap vocabulary. */
export function classifyFetchError(err: unknown): { message: string; code: string } {
  if (err instanceof AbortError) return { code: 'ABORTED', message: err.message }
  if (err instanceof Error) {
    const name = (err as { name?: string }).name ?? 'Error'
    const code = (err as { code?: string }).code
    if (name === 'TimeoutError') return { code: 'TIMEOUT', message: `request timed out (${err.message})` }
    if (name === 'AbortError') return { code: 'ABORTED', message: err.message }
    if (code === 'ECONNREFUSED') return { code: 'CONNECTION_REFUSED', message: `connection refused: ${err.message}` }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code: 'DNS_FAILED', message: `DNS resolution failed: ${err.message}` }
    if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN')
      return { code: 'TLS_CERT', message: `TLS certificate problem: ${err.message}` }
    if (code === 'ECONNRESET') return { code: 'CONNECTION_RESET', message: `connection reset: ${err.message}` }
    if (code === 'ERR_TLS_HANDSHAKE' || code === 'EPROTO') return { code: 'TLS_HANDSHAKE', message: `TLS handshake failed (often a corporate proxy blocking the SNI): ${err.message}` }
    return { code: name, message: err.message }
  }
  return { code: 'UNKNOWN', message: String(err) }
}
