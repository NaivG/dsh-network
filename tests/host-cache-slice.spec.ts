/**
 * Regression test: the server/CLI emits a six-field cacheSlice descriptor
 * ({offset, limit, start, end, total, more}) on paged (cacheId) responses,
 * while the host tool output schemas declare only {offset, limit, total}
 * with additionalProperties:false. execute() must narrow through
 * toHostCacheSlice() before the value reaches output validation —
 * otherwise every paged web_fetch / http_request call fails with
 * "value.cacheSlice.start is not a declared property".
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const hostSource = readFileSync(
  fileURLToPath(new URL('../dsh/index.js', import.meta.url)),
  'utf8',
)
const match = hostSource.match(/function toHostCacheSlice\(slice\)\s*\{[\s\S]*?\n\}/)
if (!match) {
  throw new Error('Could not locate toHostCacheSlice in dsh/index.js')
}
// eslint-disable-next-line no-new-func
const toHostCacheSlice = new Function(match[0] + '; return toHostCacheSlice;')()

describe('toHostCacheSlice (paged-response narrowing)', () => {
  it('narrows the six-field server slice to the documented three-field envelope', () => {
    const serverSlice = { offset: 1000, limit: 500, start: 1000, end: 1500, total: 25_000, more: true }
    expect(toHostCacheSlice(serverSlice)).toEqual({ offset: 1000, limit: 500, total: 25_000 })
  })

  it('returns exactly the keys the host output schemas declare', () => {
    const out = toHostCacheSlice({ offset: 0, limit: 20_000, start: 0, end: 20_000, total: 143_221, more: true })
    expect(Object.keys(out).sort()).toEqual(['limit', 'offset', 'total'])
  })
})
