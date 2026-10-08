/**
 * Node smoke test for the dsh-network browser half (dsh/client.js).
 *
 * Simulates the dsh web loader surface (`window.__ModuleLoader__.load` with a
 * `factory(require)` invocation), a minimal React, and a stub slot registry,
 * then asserts:
 *
 *   1. the factory receives a working `require` (the bug that silently
 *      skipped every registration before);
 *   2. the dedicated `settings.section` ("网络"/"Network") is registered with
 *      the right id/order and localized label;
 *   3. the Plugins-tab card + tool block renderers register once the host
 *      route probe succeeds;
 *   4. the section page renders the config form and the save flow PUTs the
 *      expected payload back through the loopback route.
 *
 * Run: `node tests/client-smoke.mjs`
 */
import assert from 'node:assert/strict'

// ───────────────────────── loader + DOM stubs ─────────────────────────
let capturedRegistration = null
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      capturedRegistration = registration
    },
  },
}
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' },
  configurable: true,
  writable: true,
})
globalThis.document = { documentElement: { lang: 'zh-CN' } }

// ───────────────────────── fetch stub (loopback route) ─────────────────────────
let revision = 1
let configSummary = {
  enabled: true,
  fetchTimeoutMs: 25000,
  searchTimeoutMs: 15000,
  httpTimeoutMs: 25000,
  maxBodyChars: 3000000,
  maxRedirects: 3,
  searchEngines: ['bing', 'duckduckgo', 'baidu'],
  searchMaxResults: 10,
  userAgent: 'Mozilla/5.0 (test)',
  allowlist: [],
  ssrfProtection: true,
  redirectProtection: true,
  protocolLock: true,
  httpMethods: ['GET', 'POST', 'PUT'],
  webSearchTool: true,
  webFetchTool: true,
  httpRequestTool: true,
}
const putCalls = []
const healthCalls = []
const searchCalls = []
let searchFailure = null // { status, error } — set to exercise the error path
const fakeSearchResult = {
  query: 'dsh sidebar search',
  status: 'ok',
  engine: 'bing',
  summary: '这是引擎摘要。',
  items: [
    { url: 'https://example.com/one', title: 'Example Result', snippet: 'example snippet', published_at: '2026-01-02' },
    { url: 'https://example.org/two', title: 'Second Result', snippet: '' },
  ],
  uncertainty: ['仅单一引擎确认'],
  warnings: ['bing 返回缓慢'],
  attempts: [{ engine: 'bing', error: 'ok' }],
  elapsedMs: 1234,
}
globalThis.fetch = (url, opts) => {
  const method = opts && opts.method ? opts.method : 'GET'
  if (String(url).endsWith('/dsh-network/health')) {
    healthCalls.push({ method })
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, pid: 12345, uptimeMs: 1000, cache: { size: 0, totalChars: 0, hits: 0 } }),
    })
  }
  if (String(url).endsWith('/dsh-network/search')) {
    // The panel POSTs { query, count, engine } as JSON.
    searchCalls.push(method === 'POST' ? JSON.parse(opts.body) : null)
    if (searchFailure) {
      const failure = searchFailure
      return Promise.resolve({
        ok: false,
        status: failure.status,
        json: () => Promise.resolve({ error: failure.error }),
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fakeSearchResult) })
  }
  if (method === 'PUT') {
    const patch = JSON.parse(opts.body)
    putCalls.push(patch)
    revision += 1
    configSummary = { ...configSummary, ...patch }
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ value: configSummary, revision }),
  })
}

// ───────────────────────── fake React ─────────────────────────
function createFakeReact() {
  const state = { values: [], cursor: 0, effects: [], cleanups: [], hookCounts: [], initialised: false }
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const index = state.cursor++
      if (!(index in state.values)) state.values[index] = initial
      const set = (next) => {
        state.values[index] = typeof next === 'function' ? next(state.values[index]) : next
      }
      return [state.values[index], set]
    },
    useEffect(fn) {
      state.effects.push(fn)
    },
    useRef(initial) {
      const index = state.cursor++
      if (!(index in state.values)) state.values[index] = { current: initial }
      return state.values[index]
    },
    _reset() {
      state.cursor = 0
      state.effects = []
      // Keep `values` so re-renders reuse the same slots; only the
      // cursor resets. This mirrors how React preserves state across
      // re-renders of the same fiber.
      state.initialised = false
    },
    _enterRender() {
      // Called at the start of each top-level render — record the
      // hook count after the first render and throw on mismatch.
      state.cursor = 0
      state.effects = []
    },
    _exitRender() {
      const count = state.cursor + state.effects.length
      if (!state.initialised) {
        state.hookCounts.push(count)
        state.initialised = true
      } else {
        const first = state.hookCounts[0]
        if (count !== first) {
          throw new Error(
            `React: Rendered ${count} hooks, but the previous render recorded ${first}. ` +
            `This is the same error React raises in dev mode when a hook appears ` +
            `after an early return or conditional branch.`
          )
        }
      }
    },
    _runEffects() {
      const effects = state.effects.splice(0)
      for (const fn of effects) {
        const cleanup = fn()
        if (typeof cleanup === 'function') state.cleanups.push(cleanup)
      }
    },
    /** Simulate React unmount: run every queued cleanup, then drop all state
     *  so the next render starts a fresh fiber with `useState(null)` again. */
    _unmount() {
      const cleanups = state.cleanups.splice(0)
      for (const fn of cleanups) {
        try { fn() } catch { /* ignore — test only cares about post-remount render */ }
      }
      state.values = []
      state.cursor = 0
      state.effects = []
      state.hookCounts = []
      state.initialised = false
    },
  }
}

const react = createFakeReact()

/** Collect every string leaf of an element tree (labels, values, notes). */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  for (const child of node.children || []) collectText(child, out)
  return out
}

/** Find one element matching a predicate (depth-first). */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  // Array children (createElement(type, props, someMapResult)) are descended
  // too, mirroring collectText/collectNodes.
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children || []) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

/** Collect every element matching a predicate (depth-first). */
function collectNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  // Children passed as a single array argument (createElement(type, props,
  // someMapResult)) must be descended too — collectText already treats
  // arrays that way, and the search panel's result cards are exactly such
  // an array child.
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) collectNodes(child, predicate, out)
  return out
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// ───────────────────────── load the client bundle ─────────────────────────
await import(new URL('../dsh/client.js', import.meta.url).href)
assert.ok(capturedRegistration, 'window.__ModuleLoader__.load must be called')
assert.equal(capturedRegistration.id, 'dsh-network')

const required = []
const requireStub = (spec) => {
  required.push(spec)
  if (spec === 'react') return react
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Input: 'input' }
  throw new Error(`unexpected require: ${spec}`)
}

const mod = capturedRegistration.factory(requireStub)
assert.ok(mod && typeof mod.apply === 'function', 'factory must export apply')
assert.ok(mod.__card && typeof mod.__card.NetworkSection === 'function', 'factory must expose NetworkSection for tests')

// ───────────────────────── fake ctx + slot registry ─────────────────────────
const locale = { active: 'zh-CN' }
const injected = [] // { name, fn }
const registrations = [] // { options, component }
const registeredDicts = [] // ns passed to locale.register
const ctx = {
  inject(names, callback) {
    if (names.includes('slots')) {
      callback({
        slots: {
          inject(name, fn) {
            injected.push({ name, fn })
          },
          register(options, component) {
            registrations.push({ options, component })
            return () => {}
          },
        },
      })
    }
    if (names.includes('locale')) {
      callback({
        locale: {
          getSnapshot: () => ({ active: locale.active }),
          register(ns, dicts) {
            registeredDicts.push({ ns, dicts })
          },
          bind() {
            return (key) => key
          },
        },
        effect() {},
      })
    }
  },
}

mod.apply(ctx)
assert.deepEqual(
  required.sort(),
  ['@deepseek-ai/dsh-client-ui-primitives', 'react'],
  'factory require must reach react + primitives (the loader passes require as the first factory argument)',
)

/** Execute every recorded slot inject (generator or plain fn) and collect registrations. */
function drainSlotInjections() {
  while (injected.length > 0) {
    const { name, fn } = injected.shift()
    const result = fn()
    if (result && typeof result.next === 'function') {
      for (let step = result.next(); !step.done; step = result.next()) {
        // generator yields the register() result
      }
    }
  }
}

drainSlotInjections()

// ── 1. settings.section registration ──
const sectionReg = registrations.find((r) => r.options.name === 'settings.section')
assert.ok(sectionReg, 'settings.section must be registered')
assert.equal(sectionReg.options.id, 'dsh-network')
assert.equal(sectionReg.options.order, 25)
assert.equal(sectionReg.options.locale, 'dsh-network', 'section must be locale-tagged for re-render on language switch')
assert.equal(typeof sectionReg.options.label, 'function')
assert.equal(sectionReg.options.label(), '网络', 'zh label must be 网络')
locale.active = 'en'
assert.equal(sectionReg.options.label(), 'Network', 'en label must be Network')
locale.active = 'zh-CN'
assert.equal(registeredDicts.length, 1, 'the dsh-network locale dictionaries must be registered once')
assert.equal(registeredDicts[0].ns, 'dsh-network')
assert.equal(registeredDicts[0].dicts.zh.nav, '网络')
assert.equal(registeredDicts[0].dicts.en.nav, 'Network')

// ── 2. Plugins-tab card + renderers appear after the route probe ──
await flush()
drainSlotInjections()
const pluginItem = registrations.find((r) => r.options.name === 'settings.plugin.item')
assert.ok(pluginItem, 'settings.plugin.item card must register once the route probe succeeds')
assert.equal(pluginItem.options.key, 'dsh-network')
const toolWeb = registrations.find((r) => r.options.name === 'tool.web.item')
const toolFetch = registrations.find((r) => r.options.name === 'tool.web.fetch.item')
assert.ok(toolWeb, 'tool.web.item renderer must register')
assert.ok(toolFetch, 'tool.web.fetch.item renderer must register')
// dsh 0.2.x dispatches tool rows through tool.call.toolview keyed by tool
// name; without this key the multi-query search card falls back to the native
// renderer (empty per-query headings + one interleaved, capped source list).
const toolView = registrations.find((r) => r.options.name === 'tool.call.toolview')
assert.ok(toolView, 'tool.call.toolview renderer must register')
assert.equal(toolView.options.key, 'web_search', 'the web_search key must be claimed so our row replaces the native one')
assert.ok(
  toolView.options.priority < 0,
  `the row must claim a priority below dsh's native 0 (got ${toolView.options.priority}); ` +
    'a keyed slot renders only the lowest-priority entry and THROWS when key+priority is taken',
)

// ── 2b. the search row renders each query's own hits ──
// dsh's tool-web persists `{ answer, sources, truncated }` on the block; the
// answer holds one `### <query>` section per query, so the row must show
// those sections and must NOT re-render the pooled source list underneath.
// Each scenario gets its OWN fake React: the fake keeps `useState` values in
// a fiber-shaped store, so one shared instance would leak the previous row's
// open/closed state into the next scenario (real React gives every row its
// own fiber).
function makeRow() {
  const rowReact = createFakeReact()
  const Row = mod.__card.SearchToolview(rowReact, {}, { current: { getSnapshot: () => ({ active: locale.active }) } })
  return {
    render(props) {
      rowReact._enterRender()
      const tree = Row(props)
      rowReact._exitRender()
      return tree
    },
  }
}
const multiQueryBlock = {
  call: { args: { queries: ['Python 3.13 新特性', 'Tokyo ikea ikea store hours'] } },
  meta: {
    // 2 hits per query in the answer (4 total), while meta.sources holds only
    // dsh's pooled list already cut to the call cap (2) — the exact shape of a
    // two-query call whose pooled list dropped half the hits.
    answer: '### Python 3.13 新特性\n8 sources from bing\n\n1. [python.org](https://docs.python.org/3.13/)\n2. [python.org whatsnew](https://docs.python.org/dev/whatsnew/3.13.html)\n\n### Tokyo ikea ikea store hours\n8 sources from bing\n\n1. [ikea.com](https://www.ikea.com/jp/en/stores/tokyo-bay/)\n2. [ikea stores](https://www.ikea.com/jp/ja/stores/)',
    sources: [
      { url: 'https://docs.python.org/3.13/', title: 'python.org', snippet: 'python snippet' },
      { url: 'https://www.ikea.com/jp/en/stores/tokyo-bay/', title: 'ikea.com', snippet: 'ikea snippet' },
    ],
    truncated: true,
  },
}
const multiRow = makeRow()
const rowText = collectText(multiRow.render({ block: multiQueryBlock })).join('\n')
assert.ok(rowText.includes('网络搜索'), 'row header must name the tool')
assert.ok(rowText.includes('2 个查询'), 'a multi-query call must open expanded and report its query count')
assert.ok(
  rowText.includes('4 条来源') && !rowText.includes('2 条来源'),
  `the header must count the 4 hits the answer renders, not the 2-entry capped pooled list (got: ${rowText.replace(/\n/g, ' ')})`,
)
assert.ok(rowText.includes('Python 3.13 新特性'), 'the per-query answer section must stay visible')
assert.ok(rowText.includes('ikea.com'), 'each query keeps its own hits')
assert.ok(!rowText.includes('python snippet'), 'the pooled source list must not be re-rendered under the answer')
assert.ok(rowText.includes('结果已按上限截断'), 'the truncation note must survive')

// The REAL dsh block shape: a settled call carries its arguments ONLY as the
// raw JSON string `call.argsRaw` — the native rows JSON.parse it and there is
// no pre-parsed `call.args` object. Reading `call.args` alone is exactly what
// hid the "N 个查询" bit from the header before ("网络搜索 · 16 个来源").
const argsRawBlock = {
  call: { argsRaw: JSON.stringify({ queries: ['Python 3.13 新特性', 'Tokyo ikea ikea store hours'] }) },
  meta: multiQueryBlock.meta,
}
const argsRawRow = makeRow()
const argsRawText = collectText(argsRawRow.render({ block: argsRawBlock })).join('\n')
assert.ok(
  argsRawText.includes('2 个查询'),
  `the query count must be parsed from call.argsRaw (got: ${argsRawText.replace(/\n/g, ' ')})`,
)
assert.ok(argsRawText.includes('4 条来源'), 'the hit count still describes the answer sections under the argsRaw shape')

// A settled call with a meta object but zero hits must NOT read as running.
const emptySettledText = collectText(makeRow().render({
  block: { call: { argsRaw: JSON.stringify({ queries: ['q'] }) }, meta: { answer: '', sources: [], truncated: false } },
})).join('\n')
assert.ok(!emptySettledText.includes('搜索中…'), 'a settled zero-hit call must not show the running placeholder')

// collapsed by default for a single-query call, expandable on click
const singleBlock = {
  call: { args: { queries: ['one query'] } },
  meta: { answer: '8 sources from bing', sources: [], truncated: false },
}
const singleRow = makeRow()
assert.ok(
  !collectText(singleRow.render({ block: singleBlock })).join('\n').includes('8 sources from bing'),
  'a single-query row stays collapsed like the native card',
)
const toggle = findNode(singleRow.render({ block: singleBlock }), (n) => n.type === 'button' && n.props && n.props['aria-expanded'] === false)
assert.ok(toggle, 'the row header must be a toggle button')
toggle.props.onClick()
assert.ok(
  collectText(singleRow.render({ block: singleBlock })).join('\n').includes('8 sources from bing'),
  'clicking the header expands the row',
)

// unsettled block: no meta yet → running placeholder, header not expandable
const runningRow = makeRow()
const runningText = collectText(runningRow.render({ block: { call: { args: { queries: ['q'] } } } })).join('\n')
assert.ok(runningText.includes('搜索中…'), 'a call without a settled result shows the running placeholder')

// our own web_search meta (no answer) falls back to the source list
const ownBlock = {
  call: { args: { query: 'single' } },
  meta: { engine: 'bing', status: 'ok', sources: [{ url: 'https://example.com/', title: 'example', snippet: 'excerpt' }], truncated: false },
}
const ownRow = makeRow()
const ownHeader = collectText(ownRow.render({ block: ownBlock })).join('\n')
assert.ok(ownHeader.includes('engine: bing'), 'the plugin-own meta shape must keep its engine badge')
findNode(ownRow.render({ block: ownBlock }), (n) => n.type === 'button' && n.props && n.props['aria-expanded'] === false).props.onClick()
assert.ok(
  collectText(ownRow.render({ block: ownBlock })).join('\n').includes('excerpt'),
  'the plugin-own meta shape must fall back to the source list',
)

// ── 2c. the sidebar search panel registers behind the route probe ──
// The panel contributes TWO registrations under one shared id: the rail icon
// (sidebar.panellist) and the page it opens (layout `main`, keyed by the same
// id) — the exact protocol the built-in plugins (order 0) and schedules
// (order 10) panels use.
const panelIconReg = registrations.find((r) => r.options.name === 'sidebar.panellist')
assert.ok(panelIconReg, 'sidebar.panellist icon must register once the host route exists')
assert.equal(panelIconReg.options.id, mod.__card.SEARCH_PANEL_ID, 'icon id must be the shared panel id')
assert.equal(panelIconReg.options.order, 20, 'the panel sorts after plugins(0) and schedules(10)')
assert.equal(panelIconReg.options.locale, 'dsh-network')
assert.equal(typeof panelIconReg.options.label, 'function')
assert.equal(panelIconReg.options.label(), '网络搜索', 'zh sidebar label must be 网络搜索')
locale.active = 'en'
assert.equal(panelIconReg.options.label(), 'Web Search', 'en sidebar label must be Web Search')
locale.active = 'zh-CN'
const panelIconEl = panelIconReg.component({ size: 18, active: false })
assert.ok(panelIconEl, 'the rail icon must render an element at the requested size')
const mainPanelReg = registrations.find((r) => r.options.name === 'main')
assert.ok(mainPanelReg, 'layout main panel must register for the search page')
assert.equal(mainPanelReg.options.key, mod.__card.SEARCH_PANEL_ID, 'the main key must match the sidebar id so selectPanel(id) opens the page')

// ── 2d. the search page renders engine-style results ──
const panelReact = createFakeReact()
const SearchPanel = mod.__card.SearchPanelPage(panelReact, { Input: 'input' }, { current: { getSnapshot: () => ({ active: locale.active }) } })
function renderPanel() {
  panelReact._enterRender()
  const tree = SearchPanel({})
  panelReact._exitRender()
  return { tree, effects: () => panelReact._runEffects() }
}
let pv = renderPanel()
assert.ok(collectText(pv.tree).some((t) => t.includes('网络搜索')), 'panel header must name the panel')
pv.effects() // mount effect: fetches the live engine chain from /dsh-network/config
await flush()
pv = renderPanel()
const searchInput = findNode(pv.tree, (n) => n.type === 'input')
assert.ok(searchInput, 'search page must render the query input')
const engineSelect = findNode(pv.tree, (n) => n.type === 'select')
assert.ok(engineSelect, 'search page must render the engine picker')
searchInput.props.onChange({ target: { value: 'dsh sidebar search' } })
pv = renderPanel()
const searchForm = findNode(pv.tree, (n) => n.type === 'form')
assert.ok(searchForm, 'search page must wrap the controls in a form')
searchForm.props.onSubmit({ preventDefault() {} })
await flush()
pv = renderPanel()
assert.equal(searchCalls.length, 1, 'submitting the form must POST /dsh-network/search once')
assert.deepEqual(
  searchCalls[0],
  { query: 'dsh sidebar search', count: 10 },
  'the POST body must carry the trimmed query, count, and (empty engine omitted)',
)
const panelText = collectText(pv.tree).join('\n')
assert.ok(panelText.includes('Example Result'), 'the first hit title must render as a card')
assert.ok(panelText.includes('example.com'), 'the first hit host must render')
assert.ok(panelText.includes('example snippet'), 'the snippet must render')
assert.ok(panelText.includes('2026-01-02'), 'the published date must render')
assert.ok(panelText.includes('2 条结果'), 'the status line must count the hits')
assert.ok(panelText.includes('bing'), 'the status line must name the answering engine')
assert.ok(panelText.includes('1.2 秒'), 'the status line must report the elapsed time')
assert.ok(panelText.includes('引擎摘要'), 'the engine summary must render')
assert.ok(panelText.includes('警告: bing 返回缓慢'), 'warnings must render as notes')
assert.ok(panelText.includes('不确定项: 仅单一引擎确认'), 'uncertainty must render as notes')
const hitLinks = collectNodes(pv.tree, (n) => n.type === 'a' && n.props && String(n.props.href || '').startsWith('https://'))
assert.ok(hitLinks.length >= 2, 'every hit must render as a link')
assert.ok(hitLinks.every((n) => n.props.target === '_blank' && n.props.rel === 'noreferrer'), 'hit links must open in a new tab')

// Recent-search chips rerun a query without retyping it.
pv = renderPanel()
const recentChip = findNode(pv.tree, (n) => n.type === 'button' && collectText(n).includes('dsh sidebar search') && n.props.type === 'button')
assert.ok(recentChip, 'a recent-search chip must render after a successful search')
searchCalls.length = 0
recentChip.props.onClick()
await flush()
pv = renderPanel()
assert.equal(searchCalls.length, 1, 'clicking a recent chip must re-run the query')

// Failed searches render the error card with the failure detail.
searchFailure = { status: 502, error: 'dsh-network could not reach the requested source (bing: timeout)' }
searchCalls.length = 0
const errInput = findNode(pv.tree, (n) => n.type === 'input')
errInput.props.onChange({ target: { value: 'will fail' } })
pv = renderPanel()
findNode(pv.tree, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} })
await flush()
pv = renderPanel()
assert.equal(searchCalls[0].query, 'will fail', 'the failed attempt must still hit the route')
assert.ok(collectText(pv.tree).join('\n').includes('搜索失败'), 'the error card must render')
assert.ok(collectText(pv.tree).join('\n').includes('bing: timeout'), 'the engine error detail must surface')
searchFailure = null

// Panel state survives unmount/remount: the last result (not the typed
// query) is restored from the module cache on the next mount.
panelReact._unmount()
pv = renderPanel()
pv.effects()
await flush()
pv = renderPanel()
const remountText = collectText(pv.tree).join('\n')
assert.ok(
  remountText.includes('Example Result') && remountText.includes('will fail') === false,
  'after remount the last successful result set must persist, with no stale error',
)

// ── 3. the section page renders the config form ──
const Section = mod.__card.NetworkSection(react, { Input: 'input' }, { current: { getSnapshot: () => ({ active: locale.active }) } })

function renderSection() {
  react._enterRender()
  const tree = Section({})
  react._exitRender()
  return { tree, effects: () => react._runEffects() }
}

let view = renderSection()
assert.ok(collectText(view.tree).some((t) => t.includes('加载中')), 'first paint shows loading')
view.effects()
await flush()
// React strict-mode invariant: the hook count must match across every
// re-render, including the draft=null → draft-loaded transition that
// previously hid an early-return bug. _exitRender throws if the second
// render records a different hook count from the first.
assert.doesNotThrow(() => { view = renderSection() }, 'hook count must be stable across the loading → loaded transition')
const text = collectText(view.tree).join('\n')
for (const expected of [
  '网络 (dsh-network)',
  '让 Deepseek Harness 无感访问互联网。',
  'web_fetch 超时（毫秒）',
  'web_search 单引擎超时（毫秒）',
  'http_request 超时（毫秒）',
  '搜索结果上限',
  '重定向最大跳数',
  '最大响应字符',
  'User-Agent',
  '主机白名单',
  '搜索引擎',
  'bing',
  'duckduckgo',
  'baidu',
  'SSRF 保护',
  '重定向保护',
  '协议锁定保护',
  '网络搜索',
  '页面抓取',
  'HTTP 请求',
]) {
  assert.ok(text.includes(expected), `section must render "${expected}"`)
}

// ── 3b. loopback server test section ──
assert.ok(text.includes('测试'), 'section must render the test section header')
assert.ok(text.includes('测试 loopback 服务器'), 'section must render the loopback test button')
const testButton = findNode(
  view.tree,
  (n) => n.type === 'button' && collectText(n).some((t) => t.includes('测试 loopback 服务器')),
)
if (!testButton) {
  // (debug block removed)
}
assert.ok(testButton, 'loopback test button element must exist')
testButton.props.onClick()
view = renderSection()
assert.ok(collectText(view.tree).some((t) => t.includes('测试中')), 'clicking test button shows the running state')
await flush()
view = renderSection()
assert.ok(healthCalls.length >= 1, 'loopback test must call /dsh-network/health')
assert.ok(collectText(view.tree).some((t) => t.includes('服务器正常')), 'loopback test must report OK')

// ── 4. auto-save flow: mutate a field → debounced PUT → saved note ──
// Auto-save coalesces typing into one round-trip via a 500ms debounce; we
// fast-forward by stepping through render + flush cycles.
const fetchTimeoutInput = findNode(
  view.tree,
  (n) => n.type === 'input' && n.props && n.props.type === 'number' && String(n.props.value) === '25000',
)
assert.ok(fetchTimeoutInput, 'fetchTimeout field must render with the loaded value')
fetchTimeoutInput.props.onChange({ target: { value: '30000' } })
// debounce window: wait > 500ms for the timer to fire
await new Promise((resolve) => setTimeout(resolve, 600))
await flush()
view = renderSection()
assert.ok(collectText(view.tree).some((t) => t.includes('已保存')), 'auto-save must report 已保存')
assert.ok(putCalls.length >= 1, 'the debounced PUT must fire')
const lastPut = putCalls[putCalls.length - 1]
assert.equal(lastPut.fetchTimeoutMs, 30000, 'PUT must carry the edited timeout')
assert.deepEqual(lastPut.searchEngines, ['bing', 'duckduckgo', 'baidu'], 'PUT must carry the engine chain')
assert.equal(lastPut.ssrfProtection, true, 'PUT must carry the SSRF protection toggle (default on)')
assert.equal(lastPut.redirectProtection, true, 'PUT must carry the redirect protection toggle (default on)')
assert.equal(lastPut.protocolLock, true, 'PUT must carry the protocol lock toggle (default on)')

// ── 4b. add-engine dialog: picking a category inside the dialog is local
// draft state — it must NOT fire a PUT; only the 添加 confirm commits the
// chain (one debounced save), and the dialog closes afterwards.
const putsBeforeAdd = putCalls.length
const addButton = findNode(view.tree, (n) => n.type === 'button' && collectText(n).some((t) => t.includes('添加到链')))
assert.ok(addButton, 'engines section must render the add-to-chain button')
addButton.props.onClick()
view = renderSection()
// Function components are not expanded by the fake React tree walker, so
// invoke AddEngineDialog manually to inspect its rendered DOM.
let addDlgEl = findNode(view.tree, (n) => n.type && n.type.name === 'AddEngineDialog')
assert.ok(addDlgEl, 'add dialog must open after clicking 添加到链')
let addDlgTree = addDlgEl.type(addDlgEl.props)
const ghOption = findNode(addDlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t.includes('github')))
assert.ok(ghOption, 'add dialog must list the available github category')
ghOption.props.onClick()
assert.equal(putCalls.length, putsBeforeAdd, 'picking a category must NOT trigger auto-save')
view = renderSection()
addDlgEl = findNode(view.tree, (n) => n.type && n.type.name === 'AddEngineDialog')
assert.ok(addDlgEl, 'add dialog must stay open while picking a category')
addDlgTree = addDlgEl.type(addDlgEl.props)
const confirmBtn = findNode(addDlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t.includes('添加')) && n.props.disabled !== true)
assert.ok(confirmBtn, 'add confirm must be enabled after picking a category')
confirmBtn.props.onClick()
view = renderSection()
assert.equal(findNode(view.tree, (n) => n.type && n.type.name === 'AddEngineDialog'), undefined, 'add dialog must close after confirm')
await new Promise((resolve) => setTimeout(resolve, 600))
await flush()
view = renderSection()
assert.ok(putCalls.length > putsBeforeAdd, 'confirming the add must fire one debounced PUT')
assert.deepEqual(
  putCalls[putCalls.length - 1].searchEngines,
  ['bing', 'duckduckgo', 'baidu', 'github'],
  'PUT must carry the extended engine chain',
)
// The SearXNG catalog entry means one category is still available — the
// add dialog must list it (searxng stays addable, endpoint editable).
assert.ok(
  collectText(view.tree).some((t) => t.includes('添加到链')),
  'add-to-chain button must stay available while categories remain',
)
addButton.props.onClick()
view = renderSection()
addDlgEl = findNode(view.tree, (n) => n.type && n.type.name === 'AddEngineDialog')
assert.ok(addDlgEl, 'add dialog must open again for the remaining searxng category')
addDlgTree = addDlgEl.type(addDlgEl.props)
const sxOption = findNode(addDlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t.includes('searxng')))
assert.ok(sxOption, 'add dialog must list the available searxng category')
// cancel for now; the searxng add runs after the github dialog flow (4d)
findNode(addDlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t.includes('取消')) && n.props.disabled !== true).props.onClick()
view = renderSection()
assert.equal(
  findNode(view.tree, (n) => n.type && n.type.name === 'AddEngineDialog'),
  undefined,
  'add dialog must close after cancel',
)

// ── 4c. engine edit dialog: built-in endpoint is locked and the github
// dialog carries token / indexes / sort, committed on save ──
const editButtons = collectNodes(
  view.tree,
  (n) => n.type === 'button' && n.props && n.props.title === '编辑搜索引擎',
)
assert.equal(editButtons.length, 4, 'each engine row must render an edit button')
const githubEdit = editButtons[editButtons.length - 1] // github is last in the chain
githubEdit.props.onClick()
view = renderSection()
let dlgEl = findNode(view.tree, (n) => n.type && n.type.name === 'EngineDialog')
assert.ok(dlgEl, 'engine dialog must open after clicking edit')
let dlgTree = dlgEl.type(dlgEl.props)
const ghTokenInput = findNode(dlgTree, (n) => n.type === 'input' && n.props && n.props.type === 'password')
assert.ok(ghTokenInput, 'github dialog must render the write-only token input')
const ghIndexChips = collectNodes(dlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t === 'Repositories' || t === 'Code' || t === 'Issues' || t === 'Users'))
assert.equal(ghIndexChips.length, 4, 'github dialog must render all four index chips')
const ghSortChips = collectNodes(dlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t === '最佳匹配' || t === 'Star 数' || t === '最近更新'))
assert.equal(ghSortChips.length, 3, 'github dialog must render all three sort chips')
const ghEndpoint = findNode(dlgTree, (n) => n.type === 'input' && n.props && n.props.value === 'https://api.github.com/search')
assert.ok(ghEndpoint, 'github dialog must show the built-in endpoint')
assert.equal(ghEndpoint.props.readOnly, true, 'built-in endpoint must be read-only')
assert.ok(collectText(dlgTree).some((t) => t.includes('内置引擎的 Endpoint 固定')), 'locked endpoint must carry the hint')
// type a token, pick Code index + stars sort, then save (re-render between
// each interaction so the dialog tree carries the freshest closures)
function rerenderDialog() {
  view = renderSection()
  const el = findNode(view.tree, (n) => n.type && n.type.name === 'EngineDialog')
  assert.ok(el, 'engine dialog must stay open while editing github fields')
  return el.type(el.props)
}
ghTokenInput.props.onChange({ target: { value: 'ghp_test_token' } })
dlgTree = rerenderDialog()
findNode(dlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t === 'Code')).props.onClick()
dlgTree = rerenderDialog()
findNode(dlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t === 'Star 数')).props.onClick()
dlgTree = rerenderDialog()
const dlgSave = findNode(dlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t.includes('保存')) && n.props.disabled !== true)
assert.ok(dlgSave, 'dialog save button must be enabled')
dlgSave.props.onClick()
view = renderSection()
assert.equal(findNode(view.tree, (n) => n.type && n.type.name === 'EngineDialog'), undefined, 'engine dialog must close after save')
await new Promise((resolve) => setTimeout(resolve, 600))
await flush()
view = renderSection()
const githubPut = putCalls[putCalls.length - 1]
assert.equal(githubPut.githubToken, 'ghp_test_token', 'github save must PUT the typed token')
assert.deepEqual(githubPut.githubIndexes, ['code'], 'github save must PUT the picked index')
assert.equal(githubPut.githubSort, 'stars', 'github save must PUT the picked sort')

// ── 4d. add searxng → full chain → the empty-hint state ──
const addButton2 = findNode(view.tree, (n) => n.type === 'button' && collectText(n).some((t) => t.includes('添加到链')))
assert.ok(addButton2, 'add-to-chain button must still be available')
addButton2.props.onClick()
view = renderSection()
addDlgEl = findNode(view.tree, (n) => n.type && n.type.name === 'AddEngineDialog')
assert.ok(addDlgEl, 'add dialog must open for the searxng category')
addDlgTree = addDlgEl.type(addDlgEl.props)
const sxOption2 = findNode(addDlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t.includes('searxng')))
assert.ok(sxOption2, 'add dialog must list searxng')
sxOption2.props.onClick()
view = renderSection()
addDlgEl = findNode(view.tree, (n) => n.type && n.type.name === 'AddEngineDialog')
addDlgTree = addDlgEl.type(addDlgEl.props)
findNode(addDlgTree, (n) => n.type === 'button' && collectText(n).some((t) => t.includes('添加')) && n.props.disabled !== true).props.onClick()
view = renderSection()
assert.equal(
  findNode(view.tree, (n) => n.type && n.type.name === 'AddEngineDialog'),
  undefined,
  'add dialog must close after confirming searxng',
)
await new Promise((resolve) => setTimeout(resolve, 600))
await flush()
view = renderSection()
assert.deepEqual(
  putCalls[putCalls.length - 1].searchEngines,
  ['bing', 'duckduckgo', 'baidu', 'github', 'searxng'],
  'PUT must carry the searxng-extended engine chain',
)
assert.ok(
  collectText(view.tree).some((t) => t.includes('至少保留一个搜索引擎')),
  'with no categories left the empty hint must show',
)

// ── 5. page-switch round-trip: edit → save → unmount → remount ─ must
// re-fetch from the host and show the saved value, not the initial default.
// This guards against the "切换页面后设置恢复" bug where a remounted
// NetworkSettingsPage would either cache the old draft or skip the fetch.
react._unmount()
view = renderSection()
view.effects()
await flush()
view = renderSection()
const remountInput = findNode(
  view.tree,
  (n) => n.type === 'input' && n.props && n.props.type === 'number' && String(n.props.value) === '30000',
)
assert.ok(
  remountInput,
  'after remount the page must show the saved fetchTimeoutMs (30000), proving the fetch on mount ' +
    're-reads the live host value rather than restoring the default',
)

// ── 6. the Plugins-tab card still renders its accordion header ──
const cardReact = createFakeReact()
const Card = mod.__card.ConfigCard(cardReact, { Input: 'input' }, { current: { getSnapshot: () => ({ active: locale.active }) } })
function renderCard() {
  cardReact._enterRender()
  const tree = Card({})
  cardReact._exitRender()
  return { tree, effects: () => cardReact._runEffects() }
}
let cardView = renderCard()
assert.ok(collectText(cardView.tree).some((t) => t.includes('网络')), 'card header must render')
cardView.effects()
// open the accordion
const headerButton = findNode(cardView.tree, (n) => n.type === 'button' && n.props['aria-expanded'] !== undefined)
assert.ok(headerButton, 'card must render its toggle button')
headerButton.props.onClick()
cardView = renderCard() // open=true → load effect fires
cardView.effects()
await flush()
cardView = renderCard()
const cardText = collectText(cardView.tree).join('\n')
assert.ok(cardText.includes('工具'), 'opened card must render the new tools section')
assert.ok(cardText.includes('搜索引擎'), 'opened card must render the new engines section')

console.log('client-smoke: all assertions passed ✔')
