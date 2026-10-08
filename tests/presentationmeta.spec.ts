/**
 * Regression test for the `presentationMeta returned non-lossless JSON`
 * harness failure.
 *
 * The host's tool output `presentationMeta` is round-tripped through
 * `JSON.parse(JSON.stringify(meta))` for a strict lossless check, and
 * `JSON.stringify` silently drops keys whose value is `undefined`. Any
 * tool that emits an optional field as `undefined` (rather than omitting
 * it) trips the check.
 *
 * `compactPresentation()` in `dsh/index.js` is the single helper that
 * keeps every `presentationMeta` shape lossless — this test pins both
 * the helper's contract and the five production shapes it must handle.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The host side is split across modules; compactPresentation lives in
// dsh/evidence.js. Scan all of them so a future move keeps this green.
const HOST_FILES = ['index.js', 'schemas.js', 'cli-runner.js', 'evidence.js', 'providers.js', 'tools.js', 'routes.js', 'config-summary.js']
const hostSource = HOST_FILES.map((file) =>
  readFileSync(fileURLToPath(new URL(`../dsh/${file}`, import.meta.url)), 'utf8'),
).join('\n')
const match = hostSource.match(/function compactPresentation\(meta\)\s*\{[\s\S]*?\n\}/)
if (!match) {
  throw new Error('Could not locate compactPresentation in the dsh host modules')
}
// eslint-disable-next-line no-new-func
const compactPresentation = new Function(match[0] + '; return compactPresentation;')()

/** Strict lossless check: every key in `meta` must survive a JSON round-trip. */
function assertLossless(meta: Record<string, unknown>): void {
  const wrapped = compactPresentation(meta)
  const j = JSON.stringify(wrapped)
  const back = JSON.parse(j) as Record<string, unknown>
  for (const k of Object.keys(wrapped)) {
    expect(wrapped[k], `key "${k}" should not be undefined after compactPresentation`).toBeDefined()
    expect(back, `key "${k}" missing after JSON round-trip`).toHaveProperty(k)
    expect(JSON.stringify(back[k])).toBe(JSON.stringify(wrapped[k]))
  }
}

describe('compactPresentation', () => {
  it('drops undefined values but preserves null', () => {
    const out = compactPresentation({ a: null, b: undefined, c: 1 })
    expect(out).toEqual({ a: null, c: 1 })
    expect('b' in out).toBe(false)
  })

  it('returns an empty object for empty input', () => {
    expect(compactPresentation({})).toEqual({})
  })

  it('keeps falsy values that are not undefined', () => {
    expect(compactPresentation({ z: 0, s: '', b: false, n: null, u: undefined })).toEqual({
      z: 0, s: '', b: false, n: null,
    })
  })
})

describe('presentationMeta shapes (must survive JSON round-trip)', () => {
  it('web_search — execute guarantees array fields', () => {
    assertLossless({
      status: 'ok',
      engine: 'bing',
      sources: [],
      truncated: false,
      uncertainty: [],
      warnings: [],
      attempts: [],
    })
  })

  it('web_fetch — cacheId/contentLength/cacheSlice optional', () => {
    assertLossless({
      url: 'https://example.com',
      statusCode: 200,
      truncated: false,
      contentType: 'text/html',
      engine: 'undici',
      warnings: [],
      uncertainty: [],
      linksCount: 0,
      cacheId: undefined,
      contentLength: undefined,
      cacheSlice: undefined,
    })
  })

  it('web_fetch — cache paging fields present', () => {
    assertLossless({
      url: 'https://example.com',
      statusCode: 200,
      truncated: true,
      contentType: 'text/html',
      engine: 'undici',
      warnings: ['body truncated at 20000 chars'],
      uncertainty: [],
      linksCount: 3,
      cacheId: 'abc123',
      contentLength: 175432,
      cacheSlice: { offset: 0, limit: 20000, total: 175432 },
    })
  })

  it('http_request — cache fields optional', () => {
    assertLossless({
      url: 'https://example.com',
      method: 'GET',
      statusCode: 200,
      statusText: 'OK',
      contentType: 'text/html',
      bodyPreview: '',
      headers: [],
      truncated: false,
      cacheId: undefined,
      contentLength: undefined,
      cacheSlice: undefined,
    })
  })

  it('http_request — error/cache fields populated', () => {
    assertLossless({
      url: 'https://example.com',
      method: 'POST',
      statusCode: 200,
      statusText: 'OK',
      contentType: 'application/json',
      bodyPreview: '{"ok":true}',
      headers: [{ name: 'content-type', value: 'application/json' }],
      truncated: false,
      cacheId: 'def456',
      contentLength: 4096,
      cacheSlice: { offset: 0, limit: 4000, total: 4096 },
    })
  })

  it('web_config — error/persisted optional on the ok+get happy path', () => {
    assertLossless({
      status: 'ok',
      action: 'get',
      error: undefined,
      persisted: undefined,
    })
  })

  it('web_config — error populated when set fails the safety gate', () => {
    assertLossless({
      status: 'error',
      action: 'set',
      error: 'web_config: set is disabled. The user must enable …',
      persisted: undefined,
    })
  })

  it('web_sitemap — execute guarantees array fields', () => {
    assertLossless({
      engine: 'web_sitemap',
      status: 'ok',
      count: 0,
      entries: [],
      resolved: [],
      resolvedCount: 0,
      summary: '',
      digest: '',
      uncertainty: [],
      warnings: [],
    })
  })

  it('web_sitemap — entries + resolved populated', () => {
    assertLossless({
      engine: 'web_sitemap',
      status: 'ok',
      count: 1,
      entries: [{
        domain: 'github.com',
        description: 'Git 托管',
        category: 'code-repos',
        priority: 10,
        hasSearchUrl: true,
        language: 'multi',
        region: '',
        tags: ['git', 'github'],
      }],
      resolved: [{ domain: 'github.com', query: 'react', url: 'https://github.com/search?q=react' }],
      resolvedCount: 1,
      summary: 'GitHub 命中',
      digest: '',
      uncertainty: [],
      warnings: [],
    })
  })
})