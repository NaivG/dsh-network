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
import { jsonSafeMeta, previewText, RENDER_CONTENT_CAP } from '../dsh/evidence.js'
import { defaultConfig, summarizeForModel } from '../dsh/config-summary.js'

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

/** Every key path at EVERY depth. `compactPresentation` only scrubs the top
 *  level, and `toEqual` ignores `undefined` properties — so a NESTED drop is
 *  only observable as a missing path. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => keyPaths(item, `${prefix}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).flatMap((key) =>
      keyPaths((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key))
  }
  return [prefix]
}

/**
 * The harness's REAL check — a deep `JSON.parse(JSON.stringify(meta))`
 * comparison against the original, which is why `assertLossless` above (top
 * level only) is not enough for a meta that carries a nested object.
 */
function assertDeepLossless(meta: Record<string, unknown>): void {
  const wrapped = compactPresentation(meta)
  const back = JSON.parse(JSON.stringify(wrapped)) as Record<string, unknown>
  expect(keyPaths(back).sort()).toEqual(keyPaths(wrapped).sort())
  expect(JSON.stringify(back)).toBe(JSON.stringify(wrapped))
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

describe('previewText (the clip marker the card rows read)', () => {
  it('leaves a body within the cap untouched', () => {
    expect(previewText('# Title\n\nbody')).toBe('# Title\n\nbody')
    expect(previewText('')).toBe('')
    expect(previewText(undefined)).toBe('')
  })

  it('cuts at the cap and marks the cut with a single trailing ellipsis', () => {
    // The web_fetch / web_request rows decide "is this preview truncated?"
    // from that one character, so both tools must clip through this helper
    // rather than each slicing the body inline.
    const clipped = previewText('x'.repeat(RENDER_CONTENT_CAP + 500))
    expect(clipped).toHaveLength(RENDER_CONTENT_CAP + 1)
    expect(clipped.endsWith('…')).toBe(true)
    expect(previewText('y'.repeat(RENDER_CONTENT_CAP))).not.toContain('…')
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
      contentPreview: '# Example\n\nbody',
      format: 'markdown',
      warnings: [],
      uncertainty: [],
      linksCount: 0,
      links: [],
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
      contentPreview: '# Example…',
      format: 'markdown',
      warnings: ['body truncated at 20000 chars'],
      uncertainty: [],
      linksCount: 3,
      links: [{ text: 'Docs', url: 'https://example.com/docs' }],
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
      // `changes` is a set-action-only key: a get must leave it out entirely.
      changes: undefined,
      config: undefined,
    })
  })

  it('web_config — error populated when set fails the safety gate', () => {
    assertLossless({
      status: 'error',
      action: 'set',
      error: 'web_config: set is disabled. The user must enable …',
      persisted: undefined,
      changes: undefined,
    })
  })

  it('web_config — the card meta carries the config snapshot and the landed change list', () => {
    // The row never sees the tool VALUE, only `block.meta`, so the config the
    // card renders has to ride the meta — deep-safe, one level down included.
    assertDeepLossless({
      status: 'ok',
      action: 'set',
      persisted: true,
      config: {
        enabled: true,
        searchEngines: ['bing', 'searxng'],
        searchEngineConfigs: {
          searxng: { endpoint: 'http://127.0.0.1:8888', hasApiKey: false, options: {} },
        },
        allowlist: ['*.example.com'],
        httpMethods: ['GET', 'POST'],
        hasGithubToken: false,
        githubIndexes: [],
      },
      changes: ['searchMaxResults', 'allowlist'],
    })
  })

  it('web_config — the snapshot survives a NESTED undefined that the raw summary does not', () => {
    // The trap `jsonSafeMeta` exists for: `summarize()` writes
    // `endpoint: undefined` for an engine with no endpoint override, and
    // `JSON.stringify` drops exactly that key. Every TOP-level key still
    // survives, so the shallow check above stays green — the harness's deep
    // comparison is what rejects the call.
    const raw = summarizeForModel(defaultConfig({
      searchEngines: ['bing', 'brave'],
      searchEngineConfigs: { brave: { hasApiKey: true } },
    })) as Record<string, unknown>
    const engineConfigs = raw.searchEngineConfigs as Record<string, Record<string, unknown>>
    expect('endpoint' in engineConfigs.brave).toBe(true)
    expect(engineConfigs.brave.endpoint).toBeUndefined()
    // Raw → the harness would refuse the whole call.
    expect(keyPaths(JSON.parse(JSON.stringify(raw))).sort()).not.toEqual(keyPaths(raw).sort())
    // Through jsonSafeMeta → the same value is lossless.
    assertDeepLossless({ status: 'ok', action: 'get', config: jsonSafeMeta(raw) as Record<string, unknown> })
  })

  it('jsonSafeMeta — drops undefined at every depth and keeps every JSON-safe value', () => {
    expect(jsonSafeMeta({ a: 1, b: undefined, c: null, d: false, e: '', f: 0, g: [], h: {}, i: [[undefined, 1]] }))
      .toEqual({ a: 1, c: null, d: false, e: '', f: 0, g: [], h: {}, i: [[null, 1]] })
  })

  it('jsonSafeMeta — collapses what JSON cannot carry', () => {
    // `JSON.stringify` turns NaN / Infinity into null and drops functions,
    // symbols and bigint, so a meta carrying them would fail the round-trip.
    expect(jsonSafeMeta({ n: NaN, i: Infinity, fn: () => 1, sym: Symbol('x'), big: 1n })).toEqual({ n: null, i: null })
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