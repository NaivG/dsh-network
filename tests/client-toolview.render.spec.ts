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

const PAGE = [
  '# Release notes',
  '',
  'Version 1.2.0 ships [the guide](https://example.com/guide).',
  '',
  '- faster startup',
  '- fewer retries',
].join('\n')

/** A settled `web_fetch` call the way the host persists it (see dsh/tools.js). */
function fetchBlock(meta = {}, args = { url: 'https://example.com/docs' }) {
  return {
    kind: 'tool-result',
    call: { name: 'web_fetch', argsRaw: JSON.stringify(args) },
    meta: {
      url: 'https://example.com/docs',
      statusCode: 200,
      contentType: 'text/html; charset=utf-8',
      format: 'markdown',
      contentPreview: PAGE,
      linksCount: 1,
      links: [{ text: 'Guide', url: 'https://example.com/guide' }],
      warnings: [],
      uncertainty: [],
      ...meta,
    },
  }
}

function renderFetchRow(views, ui, block = fetchBlock()) {
  const Row = views.WebFetchToolview(react, ui, { current: null })
  return renderToStaticMarkup(react.createElement(Row, { block }))
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

describe('web_fetch toolview row', () => {
  it('renders the page through the memo-wrapped MarkdownText primitive', () => {
    const { views } = createHarness()
    const html = renderFetchRow(views, primitivesWith())

    expect(html).toContain('data-markdown="real"')
    expect(html).toContain('data-labels="code,footnotes"')
    // The markdown source itself reaches the renderer…
    expect(html).toContain('# Release notes')
    // …and the row header carries the request the user actually issued.
    expect(html).toContain('https://example.com/docs')
    expect(html).toContain('页面抓取')
    // A settled fetch is open unless the user collapsed it — a `useState`
    // initializer alone cannot do that, because it runs while the call is
    // still running and the page would never show up.
    expect(html).toContain('aria-expanded="true"')
  })

  it('lists the outgoing links and reports their count in the header', () => {
    const { views } = createHarness()
    const html = renderFetchRow(views, primitivesWith())

    expect(html).toContain('dshn-links')
    expect(html).toContain('href="https://example.com/guide"')
    expect(html).toContain('1 个链接')
  })

  it('shows both URLs when a redirect changed the target', () => {
    const { views } = createHarness()
    const html = renderFetchRow(views, primitivesWith(), fetchBlock({ url: 'https://example.com/docs/en' }))

    expect(html).toContain('https://example.com/docs')
    expect(html).toContain('→ https://example.com/docs/en')
  })

  it('hints at paging with the ABSOLUTE next offset, not the slice length', () => {
    const { views } = createHarness()
    // A paged re-read: the slice starts at 20000 and shows 4000 chars, so a
    // slice-local hint (offset=4000) would rewind the next read to the top.
    const slice = 'z'.repeat(4000)
    const html = renderFetchRow(views, primitivesWith(), fetchBlock({
      contentPreview: slice,
      cacheId: 'abcdef1234567890',
      contentLength: 175432,
      cacheSlice: { offset: 20000, limit: 4000, total: 175432 },
    }))

    expect(html).toContain('offset=24000')
    expect(html).not.toContain('offset=4000')
    expect(html).toContain('cache:abcdef12')
  })

  it('detects a degraded preview from the trailing ellipsis alone', () => {
    const { views } = createHarness()
    const html = renderFetchRow(views, primitivesWith(), fetchBlock({
      contentPreview: 'y'.repeat(50) + '…',
      cacheId: 'abcdef1234567890',
      contentLength: 175432,
      cacheSlice: { offset: 0, limit: 20000, total: 175432 },
    }))

    // 50 real chars + the ellipsis the host's previewText added → offset 50.
    expect(html).toContain('offset=50')
  })

  it('keeps a raw body monospace instead of running it through MarkdownText', () => {
    const { views } = createHarness()
    const html = renderFetchRow(views, primitivesWith(), fetchBlock({
      format: 'raw',
      contentPreview: '{"ok":true}',
    }))

    expect(html).not.toContain('data-markdown="real"')
    expect(html).toContain('dshn-body-pre')
    expect(html).toContain('原文')
  })

  it('shows the error text of a throwing call instead of a stale running row', () => {
    const { views } = createHarness()
    const Row = views.WebFetchToolview(react, primitivesWith(), { current: null })
    const html = renderToStaticMarkup(react.createElement(Row, {
      block: {
        kind: 'tool-result',
        isError: true,
        call: { name: 'web_fetch', argsRaw: JSON.stringify({ url: 'https://example.com/docs' }) },
        content: [{ type: 'text', text: 'Error: web_fetch: unreachable (fetch: ETIMEDOUT)' }],
      },
    }))

    // The stub shimmer renders its wrapper unconditionally (the real one
    // animates on `active`), so assert the STATE instead: a settled row is
    // expandable and says "failed", never the running wording.
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('抓取中…')
    expect(html).toContain('请求失败')
    expect(html).toContain('web_fetch: unreachable (fetch: ETIMEDOUT)')
  })

  it('shimmers the running row with the fetch wording', () => {
    const { views } = createHarness()
    const Row = views.WebFetchToolview(react, primitivesWith(), { current: null })
    const html = renderToStaticMarkup(react.createElement(Row, {
      block: { call: { name: 'web_fetch', argsRaw: JSON.stringify({ url: 'https://example.com/docs' }) } },
    }))

    expect(html).toContain('data-shimmer="real"')
    expect(html).toContain('抓取中…')
  })

  it('falls back to raw text when the host has no MarkdownText at all', () => {
    const { views } = createHarness()
    const html = renderFetchRow(views, { Input: 'input' })

    expect(html).toContain('white-space:pre-wrap')
    expect(html).toContain('# Release notes')
  })
})

describe('web_config toolview row', () => {
  /**
   * The row can only read `block.meta` — dsh never hands it the tool's VALUE —
   * so this fixture is exactly what `web_config`'s `presentationMeta` persists
   * (see tests/persist-smoke.mjs, which drives the real registration): a
   * secret-free config snapshot plus the fields a landed `set` forwarded.
   */
  function configMeta(overrides: Record<string, unknown> = {}) {
    return {
      status: 'ok',
      action: 'get',
      config: {
        enabled: true,
        fetchTimeoutMs: 25000,
        searchTimeoutMs: 15000,
        httpTimeoutMs: 25000,
        maxBodyChars: 3000000,
        maxRedirects: 3,
        searchEngines: ['bing', 'duckduckgo', 'searxng', 'brave'],
        searchEngineConfigs: {
          searxng: { endpoint: 'http://127.0.0.1:8888', hasApiKey: false, options: {} },
          brave: { hasApiKey: true, options: { country: 'DE' } },
        },
        searchMaxResults: 20,
        userAgent: 'Mozilla/5.0 (row seed)',
        allowlist: ['*.example.com'],
        ssrfProtection: true,
        redirectProtection: true,
        protocolLock: false,
        httpMethods: ['GET', 'POST'],
        hasGithubToken: false,
        githubIndexes: [],
        githubSort: 'best',
        webSearchTool: true,
        webFetchTool: true,
        httpRequestTool: true,
        webSitemapTool: false,
      },
      ...overrides,
    }
  }

  function configBlock(meta = configMeta(), args: Record<string, unknown> = { action: 'get' }) {
    return {
      kind: 'tool-result',
      call: { name: 'web_config', argsRaw: JSON.stringify(args) },
      meta,
    }
  }

  /**
   * `react-dom/server` runs `useState` but drops event handlers, so a row that
   * starts COLLAPSED can never be expanded by a click in this harness. The rows
   * take `react` as a parameter, so this wraps it with a `useState` that forces
   * the disclosure open — the one way to inspect a collapsed row's body.
   */
  function reactForcedOpen() {
    return { ...react, useState: () => [true, () => {}] }
  }

  function renderConfigRow(views: Record<string, any>, uiInstance: unknown, block = configBlock(), open = false) {
    const Row = views.WebConfigToolview(open ? reactForcedOpen() : react, uiInstance, { current: null })
    return renderToStaticMarkup(react.createElement(Row, { block }))
  }

  it('keeps a read collapsed, like the native rows, and says what it read', () => {
    const { views } = createHarness()
    const html = renderConfigRow(views, primitivesWith())

    expect(html).toContain('网络配置')
    expect(html).toContain('读取配置')
    expect(html).toContain('4 个引擎')
    // A read is informational: its body waits for a click, so no config row is
    // in the DOM yet.
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('dshn-cfgrow')
  })

  it('renders the live config as labelled groups when expanded', () => {
    const { views } = createHarness()
    const html = renderConfigRow(views, primitivesWith(), configBlock(), true)

    // Engine chain, in fallback order, with the keyed engine marked — the key
    // chip is the user's proof that the CLI will send the auth header.
    expect(html).toContain('搜索引擎')
    expect(html).toContain('引擎链')
    expect(html).toContain('brave')
    expect(html).toContain('密钥')
    // Per-engine detail: searxng's endpoint and brave's options are what
    // separate "in the chain" from "called with country=DE".
    expect(html).toContain('http://127.0.0.1:8888')
    expect(html).toContain('country=DE')
    // …the rest of the surfaces, with the settings page's own wording.
    expect(html).toContain('主机白名单')
    expect(html).toContain('*.example.com')
    expect(html).toContain('Mozilla/5.0 (row seed)')
    expect(html).toContain('原始 JSON')
    expect(html).toContain('&quot;protocolLock&quot;: false')
    // `protocolLock: false` and `webSitemapTool: false` are the two switches
    // that read OFF; every other chip stays on.
    expect(html).toContain('data-state="off"')
    expect(html).toContain('data-state="on"')
    expect(html).toContain('data-state="key"')
  })

  it('opens a landed write by default and lists the STORED value per change', () => {
    const { views } = createHarness()
    // The model asked for searchMaxResults 50; the host clamped it to 20. The
    // card must show what was STORED — echoing the request would hide the clamp.
    const html = renderConfigRow(views, primitivesWith(), configBlock(
      configMeta({ action: 'set', persisted: true, changes: ['searchMaxResults', 'allowlist'] }),
      { action: 'set', patch: { searchMaxResults: 50, allowlist: ['*.example.com'] } },
    ))

    expect(html).toContain('修改配置')
    expect(html).toContain('2 项修改')
    expect(html).toContain('已写入磁盘')
    expect(html).toContain('变更 (2)')
    // A mutation is worth seeing without a click.
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('dshn-cfgname">searchMaxResults</span><span class="dshn-cfgvalue">20')
    expect(html).not.toContain('dshn-cfgvalue">50')
  })

  it('marks a memory-only write so a lost change is visible', () => {
    const { views } = createHarness()
    const html = renderConfigRow(views, primitivesWith(), configBlock(
      configMeta({ action: 'set', persisted: false, changes: ['userAgent'] }),
      { action: 'set', patch: { userAgent: 'curl/8' } },
    ))

    expect(html).toContain('仅内存')
    expect(html).not.toContain('已写入磁盘')
  })

  it('renders a refused write as a refusal, with no phantom changes', () => {
    const { views } = createHarness()
    const refusal = 'web_config: set is disabled. The user must enable the `allowConfigEdit` (允许修改设置) safety toggle in the network settings → 安全 section before the model can modify dsh-network configuration.'
    const html = renderConfigRow(views, primitivesWith(), configBlock(
      configMeta({ status: 'error', action: 'set', error: refusal }),
      { action: 'set', patch: { searchMaxResults: 50 } },
    ))

    expect(html).toContain('已被拒绝')
    expect(html).toContain('dshn-refused')
    expect(html).toContain('允许修改设置')
    // The gate answered with the config untouched, so there is nothing to list.
    expect(html).not.toContain('变更 (')
    // NOT a crash, and not hidden either: the refusal is amber, the row never
    // claims "failed", and the message the user must act on is on screen
    // without a click.
    expect(html).not.toContain('dshn-error')
    expect(html).toContain('aria-expanded="true"')
  })

  it('degrades to a note when the meta carries no config snapshot', () => {
    const { views } = createHarness()
    // A session recorded before the host started persisting `config` (or by an
    // older build) must still render its header instead of throwing.
    const html = renderConfigRow(views, primitivesWith(), configBlock({ status: 'ok', action: 'get' }), true)

    expect(html).toContain('读取配置')
    expect(html).toContain('无配置数据')
    expect(html).not.toContain('dshn-cfgrow')
  })

  it('shows the error text of a throwing call instead of a stale reading row', () => {
    const { views } = createHarness()
    const Row = views.WebConfigToolview(react, primitivesWith(), { current: null })
    const html = renderToStaticMarkup(react.createElement(Row, {
      block: {
        kind: 'tool-result',
        isError: true,
        call: { name: 'web_config', argsRaw: JSON.stringify({ action: 'set' }) },
        content: [{ type: 'text', text: 'Error: web_config: patch must be a JSON object' }],
      },
    }))

    expect(html).toContain('请求失败')
    expect(html).toContain('patch must be a JSON object')
    expect(html).not.toContain('读取配置中…')
  })

  it('shimmers the running row with the config wording', () => {
    const { views } = createHarness()
    const Row = views.WebConfigToolview(react, primitivesWith(), { current: null })
    const html = renderToStaticMarkup(react.createElement(Row, {
      block: { call: { name: 'web_config', argsRaw: JSON.stringify({ action: 'get' }) } },
    }))

    expect(html).toContain('data-shimmer="real"')
    expect(html).toContain('读取配置中…')
    // Nothing to expand while the call is in flight.
    expect(html).not.toContain('aria-expanded')
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
