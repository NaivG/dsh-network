/**
 * dsh-network — config projection + mutation (host side).
 *
 * The JSON-safe views the browser and the model see (summarize /
 * summarizeForModel), the live-config patcher shared by the loopback
 * route and web_config.set (applyCardSettings), the loopback request
 * fence (isTrustedRequest / isLoopbackHost), and the row-config resolver
 * (defaultConfig). Split out of index.js.
 */
import { GITHUB_INDEX_IDS, GITHUB_SORTS } from './schemas.js'

function summarize(config) {
  // Build a JSON-safe view of the resolved config; never echo API keys —
  // only the `hasApiKey` boolean that the editor card needs to render its
  // status dot.
  const allowlist = Array.isArray(config.allowlist) ? config.allowlist : []
  const engines = Array.isArray(config.searchEngines) ? config.searchEngines : []
  const cfgMap = config.searchEngineConfigs && typeof config.searchEngineConfigs === 'object' ? config.searchEngineConfigs : {}
  const searchEngineConfigs = {}
  // Iterate over the chain AND any engine that already carries settings. An
  // engine is normally configured BEFORE it joins the chain (you paste the
  // Brave key while it is still only in the "add engine" list), so keying
  // this loop off the chain alone dropped that engine from the summary —
  // the settings dialog then reopened as "no API key configured" even
  // though the key was stored, and any later edit wrote `hasApiKey: false`
  // back over it.
  for (const id of new Set([...engines, ...Object.keys(cfgMap)])) {
    const entry = cfgMap[id]
    if (!entry || typeof entry !== 'object') continue
    searchEngineConfigs[id] = {
      endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : undefined,
      hasApiKey: !!entry.hasApiKey,
      options: entry.options && typeof entry.options === 'object' ? entry.options : {},
    }
  }
  return {
    enabled: config.enabled !== false,
    fetchTimeoutMs: config.fetchTimeoutMs,
    searchTimeoutMs: config.searchTimeoutMs,
    httpTimeoutMs: config.httpTimeoutMs,
    maxBodyChars: config.maxBodyChars,
    maxRedirects: config.maxRedirects,
    searchEngines: engines,
    searchEngineConfigs,
    searchMaxResults: config.searchMaxResults,
    userAgent: config.userAgent,
    allowlist,
    // The three network protections, all defaulting to ON. The legacy
    // `allowPrivateNetwork` view (inverted SSRF toggle) is kept for
    // browser bundles that predate the rename.
    ssrfProtection: config.ssrfProtection !== false,
    redirectProtection: config.redirectProtection !== false,
    protocolLock: config.protocolLock !== false,
    allowPrivateNetwork: config.ssrfProtection === false,
    httpMethods: config.httpMethods,
    // GitHub: the token itself never leaves the host — the browser only
    // sees whether one is configured (write-only, like engine API keys).
    hasGithubToken: typeof config.githubToken === 'string' && config.githubToken !== '',
    githubIndexes: Array.isArray(config.githubIndexes) ? config.githubIndexes : [],
    githubSort: GITHUB_SORTS.includes(config.githubSort) ? config.githubSort : 'best',
    webSearchTool: config.webSearchTool !== false,
    webFetchTool: config.webFetchTool !== false,
    httpRequestTool: config.httpRequestTool !== false,
    webSitemapTool: config.webSitemapTool !== false,
    webConfigTool: config.webConfigTool !== false,
    // Safety toggle that gates web_config.set (see SafetyFields in
    // dsh/client.js). The browser UI renders the corresponding switch
    // in the 网络 → 安全 section; the model NEVER sees this field —
    // it would let the model toggle its own write gate and the
    // "model locked itself out" footgun is exactly what we are trying
    // to avoid. web_config.set returning a soft error is how the model
    // learns the gate exists.
    allowConfigEdit: config.allowConfigEdit === true,
  }
}

/**
 * Model-facing view of the config. Same shape as `summarize()`, minus
 * the user-only fields. `allowConfigEdit` is stripped because the
 * model must not be able to read its own gate — otherwise a single
 * `set` that happens to include `allowConfigEdit: false` would lock
 * the model out for the rest of the session. `webConfigTool` is
 * stripped too for symmetry: the model can't toggle whether its own
 * tool is registered, and exposing the field would only invite
 * confusion.
 *
 * Secrets are already filtered by `summarize()` (no `githubToken`
 * leak; only `hasGithubToken`).
 */
function summarizeForModel(config) {
  const { allowConfigEdit: _allowConfigEdit, ...rest } = summarize(config)
  void _allowConfigEdit
  return rest
}

function applyCardSettings(config, patch) {
  if (patch === null || typeof patch !== 'object') {
    return { ok: false, error: 'expected a JSON object body' }
  }
  // Live-mutate the config object the caller owns. Settings are read at
  // call time, so this takes effect immediately.
  if (typeof patch.fetchTimeoutMs === 'number' && patch.fetchTimeoutMs >= 1) {
    config.fetchTimeoutMs = Math.floor(patch.fetchTimeoutMs)
  }
  if (typeof patch.searchTimeoutMs === 'number' && patch.searchTimeoutMs >= 1) {
    config.searchTimeoutMs = Math.floor(patch.searchTimeoutMs)
  }
  if (typeof patch.httpTimeoutMs === 'number' && patch.httpTimeoutMs >= 1) {
    config.httpTimeoutMs = Math.floor(patch.httpTimeoutMs)
  }
  if (typeof patch.maxBodyChars === 'number' && patch.maxBodyChars >= 1) {
    config.maxBodyChars = Math.floor(patch.maxBodyChars)
  }
  if (typeof patch.maxRedirects === 'number' && patch.maxRedirects >= 0) {
    config.maxRedirects = Math.floor(patch.maxRedirects)
  }
  if (Array.isArray(patch.searchEngines)) {
    config.searchEngines = patch.searchEngines.filter((s) => typeof s === 'string')
  }
  if (patch.searchEngineConfigs && typeof patch.searchEngineConfigs === 'object') {
    const next = config.searchEngineConfigs && typeof config.searchEngineConfigs === 'object' ? config.searchEngineConfigs : {}
    const nextKeys = config.searchEngineApiKeys && typeof config.searchEngineApiKeys === 'object' ? config.searchEngineApiKeys : {}
    for (const id of Object.keys(patch.searchEngineConfigs)) {
      const incoming = patch.searchEngineConfigs[id]
      if (!incoming || typeof incoming !== 'object') continue
      const prev = next[id] && typeof next[id] === 'object' ? next[id] : {}
      // The browser dialog ships the real API key only when the user typed
      // a non-empty value; empty / missing means "keep whatever was stored".
      // The key itself never leaves the host (browser only sees hasApiKey).
      if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim() !== '') {
        nextKeys[id] = incoming.apiKey
      }
      next[id] = {
        endpoint: typeof incoming.endpoint === 'string' ? incoming.endpoint : prev.endpoint,
        hasApiKey: typeof incoming.apiKey === 'string' && incoming.apiKey.trim() !== ''
          ? true
          : typeof incoming.hasApiKey === 'boolean'
            ? incoming.hasApiKey
            : prev.hasApiKey === true,
        options: incoming.options && typeof incoming.options === 'object'
          ? incoming.options
          : prev.options && typeof prev.options === 'object' ? prev.options : {},
      }
    }
    config.searchEngineConfigs = next
    config.searchEngineApiKeys = nextKeys
  }
  if (typeof patch.searchMaxResults === 'number' && patch.searchMaxResults >= 1) {
    config.searchMaxResults = Math.min(20, Math.floor(patch.searchMaxResults))
  }
  if (typeof patch.userAgent === 'string') {
    config.userAgent = patch.userAgent
  }
  if (Array.isArray(patch.allowlist)) {
    config.allowlist = patch.allowlist.filter((s) => typeof s === 'string')
  }
  // The three network protections. `ssrfProtection` (positive framing,
  // ON by default) supersedes the legacy inverted `allowPrivateNetwork`
  // key: when both arrive in one patch, the new key wins.
  if (typeof patch.ssrfProtection === 'boolean') {
    config.ssrfProtection = patch.ssrfProtection
  } else if (typeof patch.allowPrivateNetwork === 'boolean') {
    config.ssrfProtection = !patch.allowPrivateNetwork
  }
  if (typeof patch.redirectProtection === 'boolean') {
    config.redirectProtection = patch.redirectProtection
  }
  if (typeof patch.protocolLock === 'boolean') {
    config.protocolLock = patch.protocolLock
  }
  if (Array.isArray(patch.httpMethods)) {
    config.httpMethods = patch.httpMethods.filter((m) => /^[A-Z]+$/.test(String(m).toUpperCase()))
  }
  // GitHub engine settings. The token is write-only: a non-empty string
  // stores the key, an explicit empty string clears it, and an absent
  // field keeps whatever was stored. The browser never reads it back.
  if (typeof patch.githubToken === 'string') {
    config.githubToken = patch.githubToken
  }
  if (Array.isArray(patch.githubIndexes)) {
    config.githubIndexes = patch.githubIndexes.filter((s) => typeof s === 'string' && GITHUB_INDEX_IDS.includes(s))
  }
  if (typeof patch.githubSort === 'string' && GITHUB_SORTS.includes(patch.githubSort)) {
    config.githubSort = patch.githubSort
  }
  // Safety toggle: gate the web_config tool's set action. The browser UI
  // can flip it; the model itself only writes it through web_config.set,
  // which is itself gated by the existing value of this flag (so the
  // model cannot escalate from off to on — it would have to ask the
  // user to flip it from the settings page).
  if (typeof patch.allowConfigEdit === 'boolean') {
    config.allowConfigEdit = patch.allowConfigEdit
  }
  // Tool toggles (网络 → 工具). The settings page edits them and the persist
  // layer round-trips them; the live value is read at every tool call and by
  // the sidebar search route, so a flip takes effect without a reload.
  // `enabled` deliberately has no patch path — the row config is the only
  // kill-switch that can take the whole plugin down.
  if (typeof patch.webSearchTool === 'boolean') {
    config.webSearchTool = patch.webSearchTool
  }
  if (typeof patch.webFetchTool === 'boolean') {
    config.webFetchTool = patch.webFetchTool
  }
  if (typeof patch.httpRequestTool === 'boolean') {
    config.httpRequestTool = patch.httpRequestTool
  }
  if (typeof patch.webSitemapTool === 'boolean') {
    config.webSitemapTool = patch.webSitemapTool
  }
  if (typeof patch.webConfigTool === 'boolean') {
    config.webConfigTool = patch.webConfigTool
  }
  return { ok: true }
}

function isLoopbackHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ───────────────────────── row-config resolution ─────────────────────────

function defaultConfig(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {}
  const searchEngines = Array.isArray(c.searchEngines) && c.searchEngines.length > 0
    ? c.searchEngines.filter((s) => typeof s === 'string')
    : ['bing', 'duckduckgo', 'baidu']
  const searchEngineConfigs = {}
  if (c.searchEngineConfigs && typeof c.searchEngineConfigs === 'object') {
    for (const id of Object.keys(c.searchEngineConfigs)) {
      const entry = c.searchEngineConfigs[id]
      if (!entry || typeof entry !== 'object') continue
      searchEngineConfigs[id] = {
        endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : undefined,
        hasApiKey: entry.hasApiKey === true,
        options: entry.options && typeof entry.options === 'object' ? entry.options : {},
      }
    }
  }
  // SearXNG is self-hosted, so its endpoint is part of the config surface
  // (editable in the settings UI, injected into the CLI as
  // DSH_NETWORK_SEARXNG_URL). Seed the loopback default so the UI shows it
  // SearXNG is self-hosted, so its endpoint is part of the config surface
  // (editable in the settings UI, injected into the CLI as
  // DSH_NETWORK_SEARXNG_URL). Seed the loopback default so the UI shows it
  // pre-filled even when the row config carries no searchEngineConfigs.
  if (!searchEngineConfigs.searxng) {
    searchEngineConfigs.searxng = {
      endpoint: 'http://127.0.0.1:8888',
      hasApiKey: false,
      options: {},
    }
  }
  return {
    enabled: c.enabled !== false,
    userAgent: typeof c.userAgent === 'string' && c.userAgent
      ? c.userAgent
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0',
    allowlist: Array.isArray(c.allowlist) ? c.allowlist.filter((s) => typeof s === 'string') : [],
    // All three protections default ON. `ssrfProtection` supersedes the
    // legacy `allowPrivateNetwork` key (which was the inverted toggle):
    // an explicit new key wins, otherwise a persisted `allowPrivateNetwork:
    // true` maps to protection off, and absent keys mean ON.
    ssrfProtection:
      c.ssrfProtection !== undefined ? c.ssrfProtection !== false : c.allowPrivateNetwork !== true,
    redirectProtection: c.redirectProtection !== false,
    protocolLock: c.protocolLock !== false,
    fetchTimeoutMs: Number.isInteger(c.fetchTimeoutMs) && c.fetchTimeoutMs > 0 ? c.fetchTimeoutMs : 25_000,
    searchTimeoutMs: Number.isInteger(c.searchTimeoutMs) && c.searchTimeoutMs > 0 ? c.searchTimeoutMs : 15_000,
    httpTimeoutMs: Number.isInteger(c.httpTimeoutMs) && c.httpTimeoutMs > 0 ? c.httpTimeoutMs : 25_000,
    maxBodyChars: Number.isInteger(c.maxBodyChars) && c.maxBodyChars > 0 ? c.maxBodyChars : 3_000_000,
    maxRedirects: Number.isInteger(c.maxRedirects) && c.maxRedirects >= 0 ? c.maxRedirects : 3,
    searchEngines,
    searchEngineConfigs,
    // Carried through from the seed (row config or the persisted snapshot):
    // the loopback route stores engine API keys here, and without this the
    // keys would be rebuilt as `{}` on every restart even though the rest of
    // the config survived.
    searchEngineApiKeys:
      c.searchEngineApiKeys && typeof c.searchEngineApiKeys === 'object'
        ? { ...c.searchEngineApiKeys }
        : {},
    searchMaxResults: Number.isInteger(c.searchMaxResults) && c.searchMaxResults > 0 ? c.searchMaxResults : 10,
    githubToken: typeof c.githubToken === 'string' ? c.githubToken : '',
    githubIndexes: Array.isArray(c.githubIndexes)
      ? c.githubIndexes.filter((s) => typeof s === 'string' && GITHUB_INDEX_IDS.includes(s))
      : [],
    githubSort: GITHUB_SORTS.includes(c.githubSort) ? c.githubSort : 'best',
    webSearchTool: c.webSearchTool !== false,
    webFetchTool: c.webFetchTool !== false,
    httpRequestTool: c.httpRequestTool !== false,
    webSitemapTool: c.webSitemapTool !== false,
    // web_config exposes the live config to the model. The set action is
    // gated by this safety toggle (network settings → 安全 → "允许修改设置"
    // / "Allow the model to modify settings"); off by default so the
    // user has to opt in before the model can write. get always works.
    allowConfigEdit: c.allowConfigEdit === true,
    // The tool registration itself is gated by this flag (default ON, in
    // line with the other tools) so deployments that want to drop the
    // web_config surface entirely can do so via the cordis row config.
    webConfigTool: c.webConfigTool !== false,
    httpMethods: Array.isArray(c.httpMethods) && c.httpMethods.length > 0
      ? c.httpMethods.map((m) => String(m).toUpperCase()).filter((m) => /^[A-Z]+$/.test(m))
      : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  }
}

export {
  summarize,
  summarizeForModel,
  applyCardSettings,
  isLoopbackHost,
  isTrustedRequest,
  defaultConfig,
}
