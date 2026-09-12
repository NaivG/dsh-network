/**
 * dsh-network server-side result cache.
 *
 * The persistent loopback server keeps the full body of every fetch / http
 * response in memory so the host↔server channel only ever carries compact
 * payloads. This solves the "分块" (chunking) problem in both directions:
 *
 *   - Cross-process: a multi-megabyte body no longer has to travel through a
 *     child-process stdout pipe (the Windows subprocess-output truncation
 *     failure mode, dsh-handbook #717). It stays in the server's memory; the
 *     host gets a small inline preview plus a `cacheId`.
 *   - Model-facing: a body larger than `INLINE_CAP` is returned as a preview
 *     + `cacheId`, and the model pages through the rest with
 *     `--cache-id <id> --offset <n> --limit <n>`. No single tool result ever
 *     exceeds `INLINE_CAP` characters.
 *
 * The cache also dedupes repeated fetches of the same URL+format within a TTL
 * (the server process follows dsh's lifecycle, so the cache is warm across
 * tool calls within one dsh session).
 *
 * This module is pure and network-free: `ResultCache` is a plain in-memory
 * store, and the degrade/slice helpers are plain functions, so the whole file
 * is unit-testable without a socket.
 */
import { randomBytes } from 'node:crypto'

/** Body length at which a fetch/http result stops being inlined. */
export const INLINE_CAP = 20_000

/** Default slice length returned for a cache paging request. */
export const SLICE_DEFAULT_LIMIT = 4_000

/** Upper bound on a single slice (also the max a caller may request). */
export const SLICE_MAX_LIMIT = 20_000

/** Soft cap on the number of cached bodies (LRU eviction beyond it). */
export const CACHE_MAX_ENTRIES = 48

/** Soft cap on total cached characters (LRU eviction beyond it). */
export const CACHE_MAX_TOTAL_CHARS = 16 * 1024 * 1024

/** How long a deduped body is considered fresh, in milliseconds. */
export const CACHE_TTL_MS = 5 * 60_000

export type CacheKind = 'fetch' | 'http'

export interface CachedBody {
  /** Opaque handle the host hands back to the model for paging. */
  id: string
  kind: CacheKind
  /** Dedup key: `kind|format|url` (or `kind|method|url` for http). */
  key: string
  url: string
  contentType: string
  /** Full body, stored server-side only. */
  content: string
  createdAt: number
  hits: number
}

export interface CacheSlice {
  offset: number
  limit: number
  start: number
  end: number
  total: number
  more: boolean
}

export interface StoreOptions {
  kind: CacheKind
  key: string
  url: string
  contentType: string
  content: string
}

export class ResultCache {
  private readonly byId = new Map<string, CachedBody>()
  private readonly byKey = new Map<string, string>()
  private readonly maxEntries: number
  private readonly maxTotalChars: number
  private _totalChars = 0

  constructor(opts?: { maxEntries?: number; maxTotalChars?: number }) {
    this.maxEntries = opts?.maxEntries ?? CACHE_MAX_ENTRIES
    this.maxTotalChars = opts?.maxTotalChars ?? CACHE_MAX_TOTAL_CHARS
  }

  get size(): number {
    return this.byId.size
  }

  get totalChars(): number {
    return this._totalChars
  }

  /** Number of cache hits so far (for `/health` telemetry). */
  get hits(): number {
    let n = 0
    for (const body of this.byId.values()) n += body.hits
    return n
  }

  get(id: string): CachedBody | undefined {
    const body = this.byId.get(id)
    if (!body) return undefined
    body.hits += 1
    return body
  }

  getByKey(key: string): CachedBody | undefined {
    const id = this.byKey.get(key)
    if (!id) return undefined
    const body = this.byId.get(id)
    if (!body) return undefined
    body.hits += 1
    return body
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** Drop every cached body (used by `/shutdown` teardown and tests). */
  clear(): void {
    this.byId.clear()
    this.byKey.clear()
    this._totalChars = 0
  }

  /**
   * Store a full body and return its handle. Deduplication: when `key` is
   * already present (within TTL), the existing entry is refreshed and reused
   * instead of storing a second copy.
   */
  store(opts: StoreOptions): { id: string; length: number; cached: boolean } {
    const existingId = this.byKey.get(opts.key)
    const existing = existingId ? this.byId.get(existingId) : undefined
    if (existing && Date.now() - existing.createdAt < CACHE_TTL_MS) {
      existing.hits += 1
      return { id: existing.id, length: existing.content.length, cached: true }
    }
    const id = randomBytes(12).toString('hex')
    const body: CachedBody = {
      id,
      kind: opts.kind,
      key: opts.key,
      url: opts.url,
      contentType: opts.contentType,
      content: opts.content,
      createdAt: Date.now(),
      hits: 1,
    }
    if (existing) {
      // Same key expired: drop the stale copy before inserting the fresh one.
      this.byId.delete(existing.id)
      this._totalChars -= existing.content.length
    }
    this.byId.set(id, body)
    this.byKey.set(opts.key, id)
    this._totalChars += opts.content.length
    this.evict()
    return { id, length: opts.content.length, cached: false }
  }

  /**
   * Return one slice of a cached body.
   *
   * @returns the slice body plus bookkeeping, or `null` when the id is
   *   unknown. `offset`/`limit` are clamped: offset ≥ 0, limit in
   *   [1, SLICE_MAX_LIMIT].
   */
  slice(
    id: string,
    offset?: number,
    limit?: number,
  ): { body: string; slice: CacheSlice } | null {
    const body = this.get(id)
    if (!body) return null
    const start = Math.max(0, Math.floor(offset ?? 0))
    const size = Math.min(SLICE_MAX_LIMIT, Math.max(1, Math.floor(limit ?? SLICE_DEFAULT_LIMIT)))
    const total = body.content.length
    const end = Math.min(total, start + size)
    return {
      body: body.content.slice(start, end),
      slice: {
        offset: start,
        limit: size,
        start,
        end,
        total,
        more: end < total,
      },
    }
  }

  /** LRU-ish eviction: drop oldest entries until both caps hold. */
  private evict(): void {
    while (this.byId.size > this.maxEntries || this.totalChars > this.maxTotalChars) {
      let oldestId: string | undefined
      let oldestAt = Infinity
      for (const [id, body] of this.byId) {
        if (body.createdAt < oldestAt) {
          oldestAt = body.createdAt
          oldestId = id
        }
      }
      if (oldestId === undefined) break
      const removed = this.byId.get(oldestId)
      this.byId.delete(oldestId)
      if (removed) {
        if (this.byKey.get(removed.key) === removed.id) this.byKey.delete(removed.key)
        this._totalChars -= removed.content.length
      }
    }
  }
}

/**
 * Degrade a fetch entry: when its body exceeds INLINE_CAP, store the full
 * body in the cache and replace `content` with an inline preview + cacheId.
 * Mutates and returns `entry`. Without a cache (single-shot CLI) this is a
 * no-op — the full body is returned as before.
 */
export function applyCacheToFetch(
  entry: {
    content: string
    contentType?: string
    finalUrl?: string
    warnings?: string[]
  },
  cache: ResultCache | undefined,
  key: string,
): {
  content: string
  cacheId?: string
  contentLength?: number
} {
  const full = entry.content ?? ''
  if (!cache || full.length <= INLINE_CAP) return { content: full }
  const stored = cache.store({
    kind: 'fetch',
    key,
    url: entry.finalUrl ?? '',
    contentType: entry.contentType ?? '',
    content: full,
  })
  const preview = full.slice(0, INLINE_CAP)
  const warnings = Array.isArray(entry.warnings) ? entry.warnings : []
  warnings.push(
    `Content is ${full.length.toLocaleString()} chars — previewed here; read the rest with web_fetch cacheId="${stored.id}" (offset/limit).`,
  )
  entry.warnings = warnings
  return {
    content: preview,
    cacheId: stored.id,
    contentLength: full.length,
  }
}

/** Same as {@link applyCacheToFetch} but for the http_request body field. */
export function applyCacheToHttp(
  entry: {
    body: string
    contentType?: string
    finalUrl?: string
    warnings?: string[]
  },
  cache: ResultCache | undefined,
  key: string,
): {
  body: string
  cacheId?: string
  contentLength?: number
} {
  const full = entry.body ?? ''
  if (!cache || full.length <= INLINE_CAP) return { body: full }
  const stored = cache.store({
    kind: 'http',
    key,
    url: entry.finalUrl ?? '',
    contentType: entry.contentType ?? '',
    content: full,
  })
  const preview = full.slice(0, INLINE_CAP)
  const warnings = Array.isArray(entry.warnings) ? entry.warnings : []
  warnings.push(
    `Body is ${full.length.toLocaleString()} chars — previewed here; read the rest with http_request cacheId="${stored.id}" (offset/limit).`,
  )
  entry.warnings = warnings
  return {
    body: preview,
    cacheId: stored.id,
    contentLength: full.length,
  }
}

/**
 * Shape a warm dedup hit into the same envelope the degrade path produces.
 *
 * The dedup paths in `runFetch_` / `runHttp` used to return
 * `cached.content` verbatim, which reinstates the full multi-hundred-KB body
 * the first call had degraded (regression: the second fetch of a big URL blew
 * the inline budget the cache exists to protect). Over-cap entries are
 * therefore served as preview + cacheId + paging warning, exactly like
 * {@link applyCacheToFetch}; under-cap entries pass through unchanged.
 */
export function serveCachedEntry(
  cached: CachedBody,
  warnings: string[],
): { content: string; contentLength: number; degraded: boolean } {
  warnings.push(
    `Served from server cache (${cached.content.length.toLocaleString()} chars, cacheId ${cached.id}).`,
  )
  if (cached.content.length <= INLINE_CAP) {
    return { content: cached.content, contentLength: cached.content.length, degraded: false }
  }
  warnings.push(
    `Content is ${cached.content.length.toLocaleString()} chars — previewed here; read the rest with cacheId="${cached.id}" (offset/limit).`,
  )
  return {
    content: cached.content.slice(0, INLINE_CAP),
    contentLength: cached.content.length,
    degraded: true,
  }
}

/** Describe a slice for callers that need the metadata in the envelope. */
export function sliceInfo(slice: CacheSlice): CacheSlice {
  return { ...slice }
}
