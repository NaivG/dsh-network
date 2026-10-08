/**
 * Persistence tests for the dsh-network host plugin (dsh/persist.js +
 * dsh/index.js integration).
 *
 * Simulates the full durability flow without a real host:
 *
 *   1. unit: snapshot shape, atomic save/load round-trip, corrupt/missing
 *      file handling (dsh/persist.js);
 *   2. integration: apply() with a fake ctx + loopback route → PUT a change
 *      → "restart" (fresh apply) → GET shows the persisted value; secrets
 *      survive; a hand-written `enabled: false` file cannot kill the plugin
 *      (the kill-switch stays row-only); a corrupt file falls back to row
 *      config with a warning.
 *
 * Run: `node tests/persist.spec.mjs`
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Must be set BEFORE the first import of dsh/index.js: PERSIST_FILE is
// computed at module load from the environment.
const dir = mkdtempSync(join(tmpdir(), 'dsh-network-persist-'))
const configFile = join(dir, 'dsh-network.json')
process.env.DSH_NETWORK_CONFIG_FILE = configFile

const { apply } = await import('../dsh/index.js')
const {
  loadPersistedConfig,
  PERSIST_FILE,
  savePersistedConfig,
  snapshotForPersist,
} = await import('../dsh/persist.js')

// ───────────────────────── helpers ─────────────────────────
function makeFakeCtx() {
  const registrations = { routes: [], tools: [], searchProviders: [], fetchProviders: [], promptSections: [] }
  const ctx = {
    logger: { info() {}, warn() {} },
    web: {
      registerSearchProvider(p) { registrations.searchProviders.push(p) },
      registerFetchProvider(p) { registrations.fetchProviders.push(p) },
    },
    tools: { register(t) { registrations.tools.push(t) } },
    systemPrompt: { section(s) { registrations.promptSections.push(s) } },
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({ webServer: { register(route) { registrations.routes.push(route) } } })
      }
    },
  }
  return { ctx, registrations }
}

function findRoute(registrations) {
  return registrations.routes.find((r) => r.path === '/dsh-network/config')
}

function routeCall(route, method, headers, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  let i = 0
  const req = {
    method,
    headers: headers || {},
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { done: true }),
      }
    },
  }
  const res = { status: 0, headers: null, body: null }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (b) => { res.body = b }
  return route.handler(req, res).then(() => ({ status: res.status, body: res.body ? JSON.parse(res.body) : null }))
}

function getSummary(route) {
  return routeCall(route, 'GET', { host: '127.0.0.1:3080' }).then((r) => {
    assert.equal(r.status, 200, 'GET must succeed')
    return r.body.value
  })
}

const ROW_CONFIG = {
  enabled: true,
  allowlist: [],
  userAgent: 'Mozilla/5.0 (row seed)',
  fetchTimeoutMs: 25000,
  searchTimeoutMs: 15000,
  httpTimeoutMs: 25000,
  maxBodyChars: 3000000,
  maxRedirects: 3,
  searchEngines: ['bing', 'duckduckgo', 'baidu'],
  searchMaxResults: 10,
  webSearchTool: true,
  webFetchTool: true,
  httpRequestTool: true,
  httpMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
}

try {
  // ───────────────────────── 1. unit: snapshot shape ─────────────────────────
  const snapshot = snapshotForPersist({
    enabled: false, // must NOT be persisted (kill-switch stays row-only)
    fetchTimeoutMs: 42000,
    searchEngines: ['searxng', 'bing'],
    githubToken: 'ghp_secret',
    searchEngineApiKeys: { github: 'ghp_secret' },
    searchEngineConfigs: { searxng: { name: 'SearXNG', endpoint: 'http://127.0.0.1:8888', hasApiKey: false, options: {} } },
    ssrfProtection: false,
    redirectProtection: true,
    protocolLock: false,
    allowConfigEdit: true, // the web_config.set safety toggle (network settings → 安全)
    webSearchTool: false,
    httpMethods: ['GET'],
  })
  assert.equal('enabled' in snapshot, false, 'enabled must be excluded from the snapshot')
  assert.equal(snapshot.fetchTimeoutMs, 42000)
  assert.deepEqual(snapshot.searchEngines, ['searxng', 'bing'])
  assert.equal(snapshot.githubToken, 'ghp_secret', 'secrets must be persisted like settings.yaml does')
  assert.deepEqual(snapshot.searchEngineApiKeys, { github: 'ghp_secret' })
  assert.equal(snapshot.ssrfProtection, false, 'protection toggles must be persisted')
  assert.equal(snapshot.redirectProtection, true, 'protection toggles must be persisted')
  assert.equal(snapshot.protocolLock, false, 'protection toggles must be persisted')
  assert.equal(snapshot.allowConfigEdit, true, 'web_config safety toggle must be persisted')
  assert.equal('allowPrivateNetwork' in snapshot, false, 'the legacy inverted SSRF key must no longer be written')
  assert.equal(snapshot.webSearchTool, false)
  assert.deepEqual(snapshot.httpMethods, ['GET'])
  assert.deepEqual(snapshotForPersist(null), {}, 'garbage input must yield an empty snapshot')

  // ───────────────────────── 2. unit: atomic save/load ─────────────────────────
  assert.equal(loadPersistedConfig(configFile).value, null, 'missing file → no value, no error')
  const tmpPath = join(dir, 'unit.json')
  savePersistedConfig({ fetchTimeoutMs: 1, githubToken: 't' }, tmpPath)
  assert.equal(existsSync(`${tmpPath}.tmp`), false, 'atomic write must not leave a .tmp behind')
  const roundTrip = loadPersistedConfig(tmpPath)
  assert.equal(roundTrip.error, null)
  assert.equal(roundTrip.value.fetchTimeoutMs, 1)
  assert.equal(roundTrip.value.githubToken, 't')

  writeFileSync(tmpPath, '{broken json', 'utf8')
  const corrupt = loadPersistedConfig(tmpPath)
  assert.ok(corrupt.error instanceof Error, 'corrupt file must report the parse error')
  assert.equal(corrupt.value, null)
  writeFileSync(tmpPath, '[1,2,3]', 'utf8')
  assert.equal(loadPersistedConfig(tmpPath).value, null, 'non-object JSON must be rejected')
  rmSync(tmpPath)

  // ───────────────────────── 3. integration: save survives restart ─────────────────────────
  let { ctx, registrations } = makeFakeCtx()
  apply(ctx, ROW_CONFIG)
  let route = findRoute(registrations)
  assert.ok(route, 'config route must register')
  let summary = await getSummary(route)
  assert.equal(summary.fetchTimeoutMs, 25000, 'fresh start shows the row seed')
  assert.equal(summary.hasGithubToken, false)

  // UI save: bump the timeout + store a GitHub token + reorder engines.
  let put = await routeCall(route, 'PUT', { host: '127.0.0.1:3080' }, {
    fetchTimeoutMs: 42000,
    githubToken: 'ghp_persisted',
    githubIndexes: ['code'],
    searchEngines: ['searxng', 'bing'],
  })
  assert.equal(put.status, 200)
  assert.equal(put.body.persisted, true, 'PUT must report persistence')
  assert.equal(put.body.value.fetchTimeoutMs, 42000)
  assert.equal(existsSync(configFile), true, 'a save must write the persist file')

  // "Restart": a brand-new apply() with the same row config.
  ;({ ctx, registrations } = makeFakeCtx())
  apply(ctx, ROW_CONFIG)
  route = findRoute(registrations)
  summary = await getSummary(route)
  assert.equal(summary.fetchTimeoutMs, 42000, 'restart must reload the persisted timeout')
  assert.equal(summary.hasGithubToken, true, 'restart must reload the persisted GitHub token')
  assert.deepEqual(summary.searchEngines, ['searxng', 'bing'], 'restart must reload the persisted engine chain')
  assert.deepEqual(summary.githubIndexes, ['code'], 'restart must reload the persisted github indexes')

  // ───────────────────────── 4. integration: secrets round-trip via file ─────────────────────────
  const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
  assert.equal(onDisk.githubToken, 'ghp_persisted', 'the persist file must carry the token (write-only for the browser, durable for the host)')

  // ───────────────────────── 5. integration: kill-switch stays row-only ─────────────────────────
  // A hand-written file with enabled:false must NOT disable the plugin —
  // enabled is never read from the snapshot.
  writeFileSync(configFile, JSON.stringify({ ...onDisk, enabled: false }), 'utf8')
  ;({ ctx, registrations } = makeFakeCtx())
  apply(ctx, ROW_CONFIG)
  assert.equal(registrations.routes.length, 3, 'enabled:false in the file must be ignored — the plugin still applies (config + health + search routes)')
  assert.ok(registrations.routes.some((r) => r.path === '/dsh-network/health'), 'health route must be registered alongside the config route')

  // ───────────────────────── 6. integration: corrupt file falls back ─────────────────────────
  writeFileSync(configFile, ']]]not json[[[', 'utf8')
  const warnings = []
  ;({ ctx, registrations } = makeFakeCtx())
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  apply(ctx, ROW_CONFIG)
  route = findRoute(registrations)
  summary = await getSummary(route)
  assert.equal(summary.fetchTimeoutMs, 25000, 'corrupt file must fall back to the row seed')
  assert.equal(summary.hasGithubToken, false)
  assert.ok(warnings.some((w) => w.includes('unreadable config file')), 'corrupt file must be reported')

  // ───────────────────────── 7. integration: persisted overrides row config ─────────────────────────
  savePersistedConfig({ fetchTimeoutMs: 99000, searchMaxResults: 3 }, configFile)
  ;({ ctx, registrations } = makeFakeCtx())
  apply(ctx, { ...ROW_CONFIG, fetchTimeoutMs: 11111 })
  summary = await getSummary(findRoute(registrations))
  assert.equal(summary.fetchTimeoutMs, 99000, 'the persisted snapshot wins over the row config (last UI state)')
  assert.equal(summary.searchMaxResults, 3)

  // ──────────────────── 8. integration: legacy protection key migration ────────────────────
  // A persist file written by a pre-rename build carries the inverted
  // `allowPrivateNetwork` key; apply() must map it onto `ssrfProtection`
  // (true → off) and default the two new protections to ON.
  writeFileSync(configFile, JSON.stringify({ allowPrivateNetwork: true }), 'utf8')
  ;({ ctx, registrations } = makeFakeCtx())
  apply(ctx, ROW_CONFIG)
  summary = await getSummary(findRoute(registrations))
  assert.equal(summary.ssrfProtection, false, 'legacy allowPrivateNetwork:true must migrate to ssrfProtection:false')
  assert.equal(summary.redirectProtection, true, 'unset protections default ON')
  assert.equal(summary.protocolLock, true, 'unset protections default ON')

  // ──────────────────── 9. integration: web_config tool registers ────────────────────
  ;({ ctx, registrations } = makeFakeCtx())
  apply(ctx, ROW_CONFIG)
  const webConfigTool = registrations.tools.find((t) => t.name === 'web_config')
  assert.ok(webConfigTool, 'web_config tool must register')
  assert.equal(typeof webConfigTool.execute, 'function', 'web_config must expose execute()')
  assert.ok(webConfigTool.output && webConfigTool.output.schema, 'web_config must declare an output schema')

  // `get` always works. The toggle is HIDDEN from the model — both at
  // the top level and inside `config` — so the model can't even read
  // its own gate. The only way the model learns about the gate is
  // through the set-error message below.
  const toolGet = await webConfigTool.execute({ action: 'get' }, { signal: undefined })
  assert.equal(toolGet.status, 'ok')
  assert.equal(toolGet.action, 'get')
  assert.equal('allowConfigEdit' in toolGet, false, 'top-level allowConfigEdit must NOT leak to the model')
  assert.equal('allowConfigEdit' in toolGet.config, false, 'config.allowConfigEdit must NOT leak to the model')
  assert.equal(toolGet.config.fetchTimeoutMs, 25000)
  // The browser UI still sees it via the loopback route — only the
  // model's view strips it. Verify that the *route* still has it.
  const routeInitial = findRoute(registrations)
  const initialSummary = await routeCall(routeInitial, 'GET', { host: '127.0.0.1:3080' })
  assert.equal(initialSummary.body.value.allowConfigEdit, false, 'browser UI summary must still expose the toggle')

  // `set` is refused while the toggle is OFF — the model gets a soft
  // error, not a thrown exception, so it can react and ask the user to
  // enable the toggle.
  const toolSetRefused = await webConfigTool.execute(
    { action: 'set', patch: { fetchTimeoutMs: 99999 } },
    { signal: undefined },
  )
  assert.equal(toolSetRefused.status, 'error', 'set must refuse while the toggle is off')
  assert.equal('allowConfigEdit' in toolSetRefused, false, 'toggle must not leak on the error path either')
  assert.equal('allowConfigEdit' in toolSetRefused.config, false)
  assert.ok(/allow/i.test(toolSetRefused.error || ''), 'error must mention the toggle')
  // Crucially, the refused set must NOT have mutated the config.
  assert.equal(toolSetRefused.config.fetchTimeoutMs, 25000, 'a refused set must not change anything')

  // Flip the toggle on via the loopback route (the path a UI save
  // follows); then the same set call must succeed and write through.
  const routeNow = findRoute(registrations)
  const flip = await routeCall(routeNow, 'PUT', { host: '127.0.0.1:3080' }, { allowConfigEdit: true })
  assert.equal(flip.status, 200)
  assert.equal(flip.body.value.allowConfigEdit, true)

  const toolSetOk = await webConfigTool.execute(
    { action: 'set', patch: { fetchTimeoutMs: 99999, allowlist: ['*.example.com'] } },
    { signal: undefined },
  )
  assert.equal(toolSetOk.status, 'ok', 'set must succeed once the toggle is on')
  assert.equal(toolSetOk.config.fetchTimeoutMs, 99999)
  assert.deepEqual(toolSetOk.config.allowlist, ['*.example.com'])
  assert.equal('allowConfigEdit' in toolSetOk, false, 'toggle must not leak on the success path')
  assert.equal('allowConfigEdit' in toolSetOk.config, false, 'toggle must not leak in the post-set config either')
  assert.equal(toolSetOk.persisted, true, 'a successful set must persist to disk')

  // The model MUST NOT be able to flip the toggle off — even with the
  // toggle currently on, a patch carrying `allowConfigEdit: false`
  // must be silently filtered. This is the "model locks itself out"
  // footgun: a single botched batched patch would otherwise strand
  // the rest of the session.
  const toolAttemptSelfLock = await webConfigTool.execute(
    { action: 'set', patch: { allowConfigEdit: false, fetchTimeoutMs: 11111 } },
    { signal: undefined },
  )
  assert.equal(toolAttemptSelfLock.status, 'ok', 'set itself succeeds; the toggle is just filtered')
  assert.equal(toolAttemptSelfLock.config.fetchTimeoutMs, 11111, 'the legitimate field still goes through')
  // Verify the toggle is still ON in the browser view (i.e. the
  // model's attempt to flip it off was dropped).
  const summaryAfterAttempt = await routeCall(routeNow, 'GET', { host: '127.0.0.1:3080' })
  assert.equal(summaryAfterAttempt.body.value.allowConfigEdit, true, 'the model must NOT be able to flip the toggle off')

  // Secrets must NOT round-trip even with the toggle on: a model that
  // passes `githubToken` in the patch must have the field stripped
  // before it reaches the host config. The patch schema is whitelist-
  // only; `summarizeForModel()` then returns `hasGithubToken` only as a bool.
  const toolSecretAttempt = await webConfigTool.execute(
    { action: 'set', patch: { githubToken: 'ghp_evil' } },
    { signal: undefined },
  )
  assert.equal(toolSecretAttempt.status, 'ok', 'set must succeed (filtering is silent)')
  assert.equal(toolSecretAttempt.config.hasGithubToken, false, 'githubToken must not leak into the live config')

  // Unknown fields must also be stripped (no silent surprises from a
  // model passing arbitrary keys).
  const toolUnknown = await webConfigTool.execute(
    { action: 'set', patch: { notAField: 'x', searchTimeoutMs: 17000 } },
    { signal: undefined },
  )
  assert.equal(toolUnknown.status, 'ok')
  assert.equal(toolUnknown.config.searchTimeoutMs, 17000, 'valid fields still go through')
  assert.equal('notAField' in toolUnknown.config, false, 'unknown fields must be dropped, not echoed back')

  // ──────────────────── 10. integration: sidebar search route ────────────────────
  // The sidebar "网络搜索" panel drives /dsh-network/search. The route must
  // register, fence untrusted callers like the config route does, validate
  // its inputs WITHOUT touching the network, honor the web_search
  // kill-switch, and carry the engine chain through to the CLI invocation.
  ;({ ctx, registrations } = makeFakeCtx())
  apply(ctx, ROW_CONFIG)
  const searchRoute = registrations.routes.find((r) => r.path === '/dsh-network/search')
  assert.ok(searchRoute, 'search route must register alongside config + health')
  assert.equal(registrations.routes.length, 3, 'config + health + search routes register')

  // Untrusted (non-loopback Host) callers are fenced exactly like the
  // config route — this must reject BEFORE any input parsing.
  const untrusted = await routeCall(searchRoute, 'GET', { host: 'example.com:3080' })
  assert.equal(untrusted.status, 403, 'non-loopback Host must be refused')

  // Same-origin but missing query → 400 without any network I/O.
  const noQuery = await routeCall(searchRoute, 'GET', { host: '127.0.0.1:3080' })
  assert.equal(noQuery.status, 400, 'missing ?q must be a 400')

  // Out-of-range count → 400.
  const badCount = await routeCall(searchRoute, 'POST', { host: '127.0.0.1:3080' }, { query: 'x', count: 99 })
  assert.equal(badCount.status, 400, 'count outside [1, 20] must be a 400')

  // Wrong method → 405.
  const badMethod = await routeCall(searchRoute, 'DELETE', { host: '127.0.0.1:3080' })
  assert.equal(badMethod.status, 405, 'non-GET/POST must be a 405')

  // The web_search kill-switch gates the route dynamically: flip it off via
  // the config route (the exact path a settings save takes) and the search
  // route must refuse searches even for trusted callers.
  const configRouteForKill = findRoute(registrations)
  const killPut = await routeCall(configRouteForKill, 'PUT', { host: '127.0.0.1:3080' }, { webSearchTool: false })
  assert.equal(killPut.status, 200)
  const killed = await routeCall(searchRoute, 'POST', { host: '127.0.0.1:3080' }, { query: 'x' })
  assert.equal(killed.status, 403, 'the web_search kill-switch must gate the search route too')
  assert.ok(/disabled/i.test(killed.body.error || ''), 'the refusal must say the tool is disabled')
  // Flip it back on for good hygiene.
  await routeCall(configRouteForKill, 'PUT', { host: '127.0.0.1:3080' }, { webSearchTool: true })

  // The remaining tool toggles are live too: flipping one off makes the
  // matching tool's NEXT execute fail fast BEFORE any network I/O, so the
  // settings page's toggles actually do something between restarts.
  const webFetchTool = registrations.tools.find((t) => t.name === 'web_fetch')
  const httpRequestTool = registrations.tools.find((t) => t.name === 'http_request')
  const webSitemapTool = registrations.tools.find((t) => t.name === 'web_sitemap')
  assert.ok(webFetchTool && httpRequestTool && webSitemapTool, 'the three tools must be registered for the toggle checks')
  const togglePut = await routeCall(configRouteForKill, 'PUT', { host: '127.0.0.1:3080' }, { webFetchTool: false, httpRequestTool: false, webSitemapTool: false })
  assert.equal(togglePut.status, 200)
  await assert.rejects(
    () => webFetchTool.execute({ url: 'https://example.com/' }, { signal: undefined }),
    /disabled by the network settings/,
    'web_fetch must refuse while its toggle is off',
  )
  await assert.rejects(
    () => httpRequestTool.execute({ url: 'https://example.com/' }, { signal: undefined }),
    /disabled by the network settings/,
    'http_request must refuse while its toggle is off',
  )
  await assert.rejects(
    () => webSitemapTool.execute({ query: 'github' }, { signal: undefined }),
    /disabled by the network settings/,
    'web_sitemap must refuse while its toggle is off',
  )
  await routeCall(configRouteForKill, 'PUT', { host: '127.0.0.1:3080' }, { webFetchTool: true, httpRequestTool: true, webSitemapTool: true })

  console.log('persist-smoke: all assertions passed ✔')
  console.log(`persist file used: ${PERSIST_FILE}`)
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  process.exit(0) // force exit to avoid lingering timers from the host plugin
}
