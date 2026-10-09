/**
 * Durable config store for the dsh-network host plugin.
 *
 * The UI ("网络" settings section) edits the live config object through the
 * loopback route; without a durable layer every change died with the host
 * process. This module snapshots the config to a JSON file in the harness
 * home (`~/.dsh/dsh-network.json`, override with `DSH_NETWORK_CONFIG_FILE`)
 * and reloads it at `apply()` time, so UI edits survive restarts.
 *
 * Design notes:
 *
 *   - Plain ESM, `node:*` built-ins only — the host stays dependency-free
 *     (same rule as `dsh/index.js`).
 *   - JSON, not YAML: the host has no yaml dependency, and hand-rolling a
 *     YAML emitter for arbitrary strings is how config files get corrupted.
 *   - Atomic write: write `<file>.tmp` then rename over the target, so a
 *     crash mid-save never leaves a truncated document.
 *   - The snapshot deliberately EXCLUDES `enabled`: that flag stays the
 *     cordis row's kill-switch (a persisted `enabled: false` could disable
 *     the plugin permanently — `apply()` returns before the route that could
 *     re-enable it is ever registered). Delete the file to reset everything
 *     else to the row config / defaults.
 *   - Secrets (`githubToken`, `searchEngineApiKeys`) are persisted like the
 *     rest of the snapshot. They already live in plaintext in the host's
 *     memory and alongside the API keys other plugins store in
 *     `~/.dsh/settings.yaml`; the file sits in the same user-home trust
 *     domain.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PERSIST_FILE =
  process.env.DSH_NETWORK_CONFIG_FILE || join(homedir(), '.dsh', 'dsh-network.json')

/**
 * JSON-safe view of the live config for storage. Every field the browser
 * form edits, in the same flat shape the loopback route accepts — except
 * `enabled` (see header note).
 */
export function snapshotForPersist(config) {
  if (config === null || typeof config !== 'object') return {}
  return {
    userAgent: typeof config.userAgent === 'string' ? config.userAgent : '',
    allowlist: Array.isArray(config.allowlist) ? config.allowlist : [],
    // The three network protections, all defaulting to ON. `allowPrivateNetwork`
    // (the legacy inverted SSRF toggle) is no longer written; old files keep
    // their key and are mapped at apply() time.
    ssrfProtection: config.ssrfProtection !== false,
    redirectProtection: config.redirectProtection !== false,
    protocolLock: config.protocolLock !== false,
    fetchTimeoutMs: config.fetchTimeoutMs,
    searchTimeoutMs: config.searchTimeoutMs,
    httpTimeoutMs: config.httpTimeoutMs,
    maxBodyChars: config.maxBodyChars,
    maxRedirects: config.maxRedirects,
    searchEngines: Array.isArray(config.searchEngines) ? config.searchEngines : [],
    searchEngineConfigs:
      config.searchEngineConfigs && typeof config.searchEngineConfigs === 'object'
        ? config.searchEngineConfigs
        : {},
    searchEngineApiKeys:
      config.searchEngineApiKeys && typeof config.searchEngineApiKeys === 'object'
        ? config.searchEngineApiKeys
        : {},
    searchMaxResults: config.searchMaxResults,
    githubToken: typeof config.githubToken === 'string' ? config.githubToken : '',
    githubIndexes: Array.isArray(config.githubIndexes) ? config.githubIndexes : [],
    githubSort: typeof config.githubSort === 'string' ? config.githubSort : 'best',
    webSearchTool: config.webSearchTool !== false,
    webFetchTool: config.webFetchTool !== false,
    httpRequestTool: config.httpRequestTool !== false,
    webSitemapTool: config.webSitemapTool !== false,
    webConfigTool: config.webConfigTool !== false,
    // web_download's opt-in rides the same snapshot as every other toggle:
    // the user flipped it once in the browser, so it must survive a restart.
    // It is NOT a "default on like the others" field — the snapshot carries
    // whatever the user chose, and an absent key means off (defaultConfig).
    downloadTool: config.downloadTool === true,
    // Safety toggle that gates web_config.set (see defaultConfig() in
    // dsh/index.js). Persisted so a UI flip survives restarts, just
    // like the other protections.
    allowConfigEdit: config.allowConfigEdit === true,
    httpMethods: Array.isArray(config.httpMethods) ? config.httpMethods : [],
  }
}

/**
 * Read the persisted snapshot. Never throws:
 *
 *   - missing file            → `{ file, value: null, error: null }`
 *   - parse failure / garbage → `{ file, value: null, error }`
 *   - valid object            → `{ file, value: <parsed>, error: null }`
 */
export function loadPersistedConfig(file = PERSIST_FILE) {
  if (!existsSync(file)) return { file, value: null, error: null }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const value =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    return { file, value, error: null }
  } catch (error) {
    return { file, value: null, error }
  }
}

/**
 * Atomically persist a snapshot of `config`. Throws on failure so the caller
 * can warn; a failed save must not silently pretend durability.
 */
export function savePersistedConfig(config, file = PERSIST_FILE) {
  const json = JSON.stringify(snapshotForPersist(config), null, 2) + '\n'
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, json, 'utf8')
  renameSync(tmp, file)
  return file
}
