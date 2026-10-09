/**
 * Regression test: the browser half's toolview rows must render the search
 * answer as MARKDOWN, not as raw text.
 *
 * The defect this pins: `SearchToolview` / `HttpRequestToolview` /
 * `WebSitemapToolview` / `SearchPanelPage` picked their markdown renderer with
 * `typeof ui.MarkdownText === 'function'`, but dsh ships `MarkdownText` (and
 * `TextShimmer`) through `React.memo`, so the SHIPPED export is a memo object
 * (`{ $$typeof: Symbol(react.memo), type, compare }`) — never a function.
 * The guard therefore evaluated false on every dsh build and every answer fell
 * through to the raw-text `<pre>` fallback: the card showed literal `###`,
 * `[title](url)` and `&nbsp;` in a proportional font, while the plain icons
 * (real functions) kept working, so the row *looked* wired up.
 *
 * The harness below materializes the REAL `dsh/client.js` entry and the REAL
 * `dsh/client.toolviews.js` chunk through a faithful mock of
 * `@deepseek-ai/dsh-client-modules` (same `window.__ModuleLoader__.load`
 * protocol, same "factory return value becomes the record exports" rule), with
 * `react` as the only seed word, and renders the row with `react-dom/server`.
 * No network, no dsh install, no jsdom: `react` and `react-dom` are the only
 * devDependencies it needs.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import react from 'react'
import serverRenderer from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { renderToStaticMarkup } = serverRenderer
const nodeRequire = createRequire(import.meta.url)

const ENTRY = fileURLToPath(new URL('../dsh/client.js', import.meta.url))
const TOOLVIEWS = fileURLToPath(new URL('../dsh/client.toolviews.js', import.meta.url))

/** Materialize the plugin factories the way the dsh client module system does. */
function createHarness() {
  const registrations = new Map()
  const records = new Map()

  globalThis.window = globalThis
  globalThis.document = {
    documentElement: { lang: 'zh-CN' },
    head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, style: {}, content: '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: null,
  }
  // Node 24 exposes `navigator` as a getter-only global; only stub it when a
  // runtime lacks one entirely (the entry reads `navigator.language`).
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
  }
  globalThis.__ModuleLoader__ = {
    load(row) {
      registrations.set(row.chunk || row.id, row)
    },
  }

  const seed = new Map([
    ['react', nodeRequire('react')],
    ['react/jsx-runtime', nodeRequire('react/jsx-runtime')],
  ])

  function require(spec) {
    if (seed.has(spec)) return seed.get(spec)
    if (records.has(spec)) return records.get(spec)
    const row = registrations.get(spec) || registrations.get(spec.replace(/^\.\//, ''))
    if (!row) throw new Error(`client harness: require("${spec}") missed the module table`)
    return materialize(row, spec)
  }
  require.async = async (spec) => require(spec)

  function materialize(row, key) {
    // Same contract as `ClientModuleSystem.materialize`: the factory's RETURN
    // value is the record exports (the entry returns `module.exports`).
    const module = { exports: {} }
    const out = row.factory(require)
    const value = out === undefined ? module.exports : out
    records.set(key, value)
    return value
  }

  // The plugin bundle is a plain script: it registers itself on window.
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'console', readFileSync(ENTRY, 'utf8'))(globalThis, globalThis.document, console)
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'console', readFileSync(TOOLVIEWS, 'utf8'))(globalThis, globalThis.document, console)

  const entry = materialize(registrations.get('dsh-network'), 'dsh-network')
  const views = materialize(registrations.get('client.toolviews.js'), 'client.toolviews.js')
  return { entry, views }
}

/** A memo-shaped React component, exactly how dsh ships MarkdownText. */
function memoComponent(render) {
  return { $$typeof: Symbol.for('react.memo'), type: render, compare: null }
}

/** The primitives surface the rows read, with a memo-wrapped MarkdownText. */
function primitivesWith(overrides) {
  return Object.assign(
    {
      MarkdownText: memoComponent(function MarkdownTextStub(props) {
        return react.createElement(
          'div',
          { 'data-markdown': 'real', 'data-labels': Object.keys(props.labels || {}).join(',') },
          props.text,
        )
      }),
      TextShimmer: memoComponent(function TextShimmerStub(props) {
        return react.createElement('span', { 'data-shimmer': 'real' }, props.children)
      }),
    },
    overrides,
  )
}

const ANSWER = [
  '### dsh-network plugin github',
  '',
  '8 sources from bing',
  '',
  '1. [GitHub - kriskite/dsh-network-proxy](https://github.com/kriskite/dsh-network-proxy)  ',
  '    Aug 19, 2026&nbsp;&#0183;&#32;DeepSeek Harness plugin to manage network proxy.',
].join('\n')

function searchBlock() {
  return {
    kind: 'tool-result',
    call: {
      name: 'web_search',
      argsRaw: JSON.stringify({ queries: ['dsh-network plugin github', 'dsh network plugin'] }),
    },
    meta: {
      answer: ANSWER,
      sources: [
        { url: 'https://github.com/kriskite/dsh-network-proxy', title: 'GitHub - kriskite/dsh-network-proxy' },
      ],
      truncated: true,
    },
  }
}

function renderSearchRow(views, ui) {
  const Row = views.SearchToolview(react, ui, { current: null })
  return renderToStaticMarkup(react.createElement(Row, { block: searchBlock() }))
}

describe('web_search toolview markdown rendering', () => {
  it('renders the answer through the memo-wrapped MarkdownText primitive', () => {
    const { views } = createHarness()
    const html = renderSearchRow(views, primitivesWith())

    expect(html).toContain('data-markdown="real"')
    // …and the answer really travels to that renderer: the raw markdown source
    // plus the label seats dsh's renderer requires (a code fence reads
    // `labels.code.copyLabel`, a footnote reads `labels.footnotes`).
    expect(html).toContain('data-labels="code,footnotes"')
    expect(html).toContain('### dsh-network plugin github')
    // The raw-text fallback is exactly what the defect produced.
    expect(html).not.toContain('white-space:pre-wrap')
  })

  it('still renders the answer when a host hands in the degraded { Input } surface', () => {
    const { views } = createHarness()
    const html = renderSearchRow(views, { Input: 'input' })

    expect(html).toContain('white-space:pre-wrap')
    expect(html).toContain('### dsh-network plugin github')
  })

  it('uses TextShimmer for the row while a call is still running', () => {
    const { views } = createHarness()
    const Row = views.SearchToolview(react, primitivesWith(), { current: null })
    const html = renderToStaticMarkup(
      react.createElement(Row, {
        block: { call: { name: 'web_search', argsRaw: JSON.stringify({ queries: ['a', 'b'] }) } },
      }),
    )

    expect(html).toContain('data-shimmer="real"')
    expect(html).toContain('\u641c\u7d22\u4e2d\u2026')
  })
})

describe('isRenderable (memo-aware component test)', () => {
  it('accepts functions, memo objects, forwardRef objects and lazy payloads', () => {
    const { entry } = createHarness()
    const { isRenderable } = entry

    expect(isRenderable(function Plain() {})).toBe(true)
    expect(isRenderable(() => null)).toBe(true)
    expect(isRenderable(memoComponent(() => null))).toBe(true)
    expect(isRenderable({ $$typeof: Symbol.for('react.forward_ref'), render: () => null })).toBe(true)
    expect(isRenderable({ $$typeof: Symbol.for('react.lazy'), _payload: {} })).toBe(true)
  })

  it('rejects null, plain objects and strings', () => {
    const { entry } = createHarness()
    const { isRenderable } = entry

    expect(isRenderable(null)).toBe(false)
    expect(isRenderable(undefined)).toBe(false)
    expect(isRenderable('div')).toBe(false)
    expect(isRenderable({})).toBe(false)
    expect(isRenderable({ title: 'not a component' })).toBe(false)
  })
})

describe('browser half bootstrap', () => {
  beforeAll(() => {
    // The entry probes the host's config route; a 404 means "headless profile,
    // stay silent" and keeps this test free of any host half.
    vi.stubGlobal('fetch', async () => ({ status: 404, ok: false, json: async () => ({}) }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exposes the chunk-shared surface the chunks require', () => {
    const { entry } = createHarness()

    for (const key of ['apply', 'labelText', 'isRenderable', 'markdownLabels', 'noteFrom', 'fetchConfig']) {
      expect(typeof entry[key], `entry.${key}`).toBe('function')
    }
    expect(entry.markdownLabels({ current: null })).toHaveProperty('code.copyLabel')
    expect(entry.markdownLabels({ current: null })).toHaveProperty('footnotes')
  })
})
