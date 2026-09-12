/**
 * Unit tests for the server-side result cache (src/cache.ts).
 *
 * Pure, network-free: verifies INLINE_CAP degrade, cacheId slicing, dedup,
 * LRU eviction, and the slice helpers. No socket is ever opened.
 */
import { describe, expect, it } from 'vitest'
import {
  CACHE_MAX_ENTRIES,
  INLINE_CAP,
  SLICE_DEFAULT_LIMIT,
  SLICE_MAX_LIMIT,
  ResultCache,
  applyCacheToFetch,
  applyCacheToHttp,
  serveCachedEntry,
  sliceInfo,
} from '../src/cache.ts'

describe('ResultCache store / get', () => {
  it('stores a body and returns its id + length', () => {
    const cache = new ResultCache()
    const { id, length, cached } = cache.store({
      kind: 'fetch',
      key: 'fetch|markdown|https://example.com/',
      url: 'https://example.com/',
      contentType: 'text/markdown',
      content: 'hello world',
    })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThanOrEqual(12)
    expect(length).toBe(11)
    expect(cached).toBe(false)
    expect(cache.size).toBe(1)
    expect(cache.get(id)?.content).toBe('hello world')
  })

  it('dedupes by key within TTL: same id returned, no duplicate', () => {
    const cache = new ResultCache()
    const key = 'fetch|markdown|https://example.com/'
    const first = cache.store({ kind: 'fetch', key, url: 'u', contentType: 't', content: 'abc' })
    const second = cache.store({ kind: 'fetch', key, url: 'u', contentType: 't', content: 'abc' })
    expect(second.id).toBe(first.id)
    expect(second.cached).toBe(true)
    expect(cache.size).toBe(1)
  })

  it('getByKey hits and bumps the counter', () => {
    const cache = new ResultCache()
    const key = 'http|GET|https://api.example.com/x'
    const { id } = cache.store({ kind: 'http', key, url: 'u', contentType: 't', content: 'data' })
    const hit = cache.getByKey(key)
    expect(hit?.id).toBe(id)
    expect(hit?.hits).toBe(2)
  })

  it('unknown id returns undefined; slice returns null', () => {
    const cache = new ResultCache()
    expect(cache.get('nope')).toBeUndefined()
    expect(cache.slice('nope')).toBeNull()
  })
})

describe('ResultCache slice', () => {
  const body = '0123456789'

  it('slices with default offset 0 and default limit', () => {
    const cache = new ResultCache()
    const { id } = cache.store({ kind: 'fetch', key: 'k', url: 'u', contentType: 't', content: body })
    const { body: got, slice } = cache.slice(id)!
    expect(got).toBe('0123456789')
    expect(slice.offset).toBe(0)
    expect(slice.limit).toBe(SLICE_DEFAULT_LIMIT)
    expect(slice.total).toBe(10)
    expect(slice.more).toBe(false)
  })

  it('slices an explicit window and reports more', () => {
    const cache = new ResultCache()
    const { id } = cache.store({ kind: 'fetch', key: 'k', url: 'u', contentType: 't', content: body })
    const { body: got, slice } = cache.slice(id, 4, 3)!
    expect(got).toBe('456')
    expect(slice).toEqual({ offset: 4, limit: 3, start: 4, end: 7, total: 10, more: true })
  })

  it('clamps limit to [1, SLICE_MAX_LIMIT] and offset to >= 0', () => {
    const cache = new ResultCache()
    const big = 'x'.repeat(SLICE_MAX_LIMIT + 100)
    const { id } = cache.store({ kind: 'fetch', key: 'k', url: 'u', contentType: 't', content: big })
    const over = cache.slice(id, 0, 999999)!
    expect(over.slice.limit).toBe(SLICE_MAX_LIMIT)
    expect(over.body.length).toBe(SLICE_MAX_LIMIT)
    const neg = cache.slice(id, -5, 0)!
    expect(neg.slice.offset).toBe(0)
    expect(neg.slice.limit).toBe(1)
  })
})

describe('applyCacheToFetch / applyCacheToHttp degrade', () => {
  it('keeps full content when under INLINE_CAP', () => {
    const cache = new ResultCache()
    const entry = { content: 'short', contentType: 'text/plain', finalUrl: 'u', warnings: [] }
    const out = applyCacheToFetch(entry, cache, 'k')
    expect(out.content).toBe('short')
    expect(out.cacheId).toBeUndefined()
    expect(out.contentLength).toBeUndefined()
    expect(entry.warnings?.length).toBe(0)
  })

  it('degrades to preview + cacheId when over INLINE_CAP', () => {
    const cache = new ResultCache()
    const full = 'y'.repeat(INLINE_CAP + 10)
    const entry = { content: full, contentType: 'text/markdown', finalUrl: 'https://e.com/', warnings: [] }
    const out = applyCacheToFetch(entry, cache, 'fetch|markdown|https://e.com/')
    expect(out.content.length).toBe(INLINE_CAP)
    expect(out.cacheId).toBeTruthy()
    expect(out.contentLength).toBe(full.length)
    expect(entry.warnings?.some((w) => w.includes('cacheId'))).toBe(true)
    // the full body is retrievable via cacheId
    const sliced = cache.slice(out.cacheId!, INLINE_CAP, 100)!
    expect(sliced.body).toBe(full.slice(INLINE_CAP))
  })

  it('applyCacheToHttp mirrors the fetch behavior on the body field', () => {
    const cache = new ResultCache()
    const full = 'z'.repeat(INLINE_CAP + 5)
    const entry = { body: full, contentType: 'application/json', finalUrl: 'https://a.com/x', warnings: [] }
    const out = applyCacheToHttp(entry, cache, 'http|GET|https://a.com/x')
    expect(out.body.length).toBe(INLINE_CAP)
    expect(out.cacheId).toBeTruthy()
    expect(out.contentLength).toBe(full.length)
  })

  it('is a no-op without a cache (single-shot CLI behavior)', () => {
    const full = 'q'.repeat(INLINE_CAP + 5)
    const out = applyCacheToFetch({ content: full }, undefined, 'k')
    expect(out.content).toBe(full)
    expect(out.cacheId).toBeUndefined()
  })
})

describe('ResultCache eviction', () => {
  it('caps total entries at maxEntries (LRU-ish oldest-out)', () => {
    const cache = new ResultCache({ maxEntries: 3, maxTotalChars: 10_000 })
    for (let i = 0; i < 6; i++) {
      cache.store({ kind: 'fetch', key: `k${i}`, url: `u${i}`, contentType: 't', content: `body${i}` })
    }
    expect(cache.size).toBeLessThanOrEqual(3)
    expect(cache.getByKey('k0')).toBeUndefined()
    expect(cache.getByKey('k5')?.content).toBe('body5')
  })

  it('caps total characters', () => {
    const cache = new ResultCache({ maxEntries: 100, maxTotalChars: 50 })
    for (let i = 0; i < 10; i++) {
      cache.store({ kind: 'fetch', key: `k${i}`, url: `u${i}`, contentType: 't', content: '0123456789' })
    }
    expect(cache.totalChars).toBeLessThanOrEqual(50)
    expect(cache.size).toBeLessThanOrEqual(5)
  })
})

describe('serveCachedEntry (dedup-hit degrade)', () => {
  it('serves an under-cap hit verbatim, flagged not degraded', () => {
    const cache = new ResultCache()
    const stored = cache.store({ kind: 'fetch', key: 'k', url: 'u', contentType: 't', content: 'abc' })
    const cached = cache.get(stored.id)
    const warnings: string[] = []
    const out = serveCachedEntry(cached!, warnings)
    expect(out.content).toBe('abc')
    expect(out.contentLength).toBe(3)
    expect(out.degraded).toBe(false)
    expect(warnings.some((w) => /Served from server cache/.test(w))).toBe(true)
  })

  it('degrades an over-cap hit to preview + paging warning (regression: full body inline)', () => {
    const cache = new ResultCache()
    const full = 'y'.repeat(INLINE_CAP + 123)
    const stored = cache.store({ kind: 'http', key: 'k2', url: 'u', contentType: 't', content: full })
    const cached = cache.get(stored.id)
    const warnings: string[] = []
    const out = serveCachedEntry(cached!, warnings)
    expect(out.content.length).toBe(INLINE_CAP)
    expect(out.contentLength).toBe(full.length)
    expect(out.degraded).toBe(true)
    expect(warnings.some((w) => w.includes(`cacheId="${stored.id}"`))).toBe(true)
    expect(warnings.some((w) => /Served from server cache/.test(w))).toBe(true)
  })
})

describe('sliceInfo', () => {
  it('returns a shallow copy', () => {
    const slice = { offset: 1, limit: 2, start: 1, end: 3, total: 10, more: true }
    const copy = sliceInfo(slice)
    expect(copy).toEqual(slice)
    expect(copy).not.toBe(slice)
  })
})
