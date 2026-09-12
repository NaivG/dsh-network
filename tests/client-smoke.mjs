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
  if (node === null || node === undefined || typeof node !== 'object' || Array.isArray(node)) return undefined
  if (predicate(node)) return node
  for (const child of node.children || []) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

/** Collect every element matching a predicate (depth-first). */
function collectNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object' || Array.isArray(node)) return out
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
