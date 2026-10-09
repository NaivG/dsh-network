/**
 * Pins the HOST → CLI credential/options handoff for keyed search engines.
 *
 * Defect this guards: `searchEngineApiKeys` was collected by the settings
 * page, persisted to ~/.dsh/dsh-network.json, and asserted by the persist
 * smoke test — while `configToEnv()` never put it on the /invoke snapshot
 * and the CLI never read it. Every engine therefore saw `hasApiKey: false`
 * and the browser's "API Key" field rendered for no engine at all. A keyed
 * engine (Brave) could be configured from the UI and still never
 * authenticate, with no error anywhere to explain it.
 *
 * Two halves, tested as one contract:
 *   - `configToEnv()` (dsh/serverClient.js) builds the env snapshot the host
 *     POSTs on every /invoke;
 *   - `readEngineEnvOptions()` (src/engines/types.ts) is what an engine uses
 *     to read its options back out of that same snapshot.
 * The env var NAMES are the contract — a rename on one side only would be
 * silent (the CLI would just see an unset var), so they are asserted here.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configToEnv } from '../dsh/serverClient.js'
import { readEngineEnvOptions } from '../src/engines/types.ts'

const KEYS_ENV = 'DSH_NETWORK_SEARCH_ENGINE_API_KEYS'
const OPTIONS_ENV = 'DSH_NETWORK_ENGINE_OPTIONS'

// summarize() lives in dsh/config-summary.js, whose only import is
// schemas.js (a data module). Extract the function and re-bind the two
// vocabularies it reads, the same way search-source-format.spec.ts extracts
// renderSearchSourceItem.
const configSummarySource = readFileSync(
  fileURLToPath(new URL('../dsh/config-summary.js', import.meta.url)),
  'utf8',
)
const summarizeMatch = configSummarySource.match(/function summarize\(config\)\s*\{[\s\S]*?\n\}/)
if (!summarizeMatch) throw new Error('Could not locate summarize in dsh/config-summary.js')
const schemasSource = readFileSync(fileURLToPath(new URL('../dsh/schemas.js', import.meta.url)), 'utf8')
const githubSortsDecl = schemasSource.match(/^const GITHUB_SORTS = .*$/m)
if (!githubSortsDecl) throw new Error('Could not locate GITHUB_SORTS in dsh/schemas.js')
const githubIndexIdsDecl = schemasSource.match(/^const GITHUB_INDEX_IDS = .*$/m)
if (!githubIndexIdsDecl) throw new Error('Could not locate GITHUB_INDEX_IDS in dsh/schemas.js')
// eslint-disable-next-line no-new-func
const summarize = new Function(
  `${githubSortsDecl[0]}\n${summarizeMatch[0]}\nreturn summarize;`,
)() as (config: Record<string, unknown>) => Record<string, any>
// applyCardSettings is the WRITE half of the same contract: the browser PUT
// lands here, and it is the only place `config.searchEngineApiKeys` is ever
// filled. It is extracted the same way (its only free names are the two
// schema vocabularies) so the test drives the real host code.
const applyMatch = configSummarySource.match(/function applyCardSettings\(config, patch\)\s*\{[\s\S]*?\n\}/)
if (!applyMatch) throw new Error('Could not locate applyCardSettings in dsh/config-summary.js')
// eslint-disable-next-line no-new-func
const applyCardSettings = new Function(
  `${githubSortsDecl[0]}\n${githubIndexIdsDecl[0]}\n${applyMatch[0]}\nreturn applyCardSettings;`,
)() as (config: Record<string, any>, patch: Record<string, any>) => { ok: boolean; error?: string }

describe('configToEnv — keyed-engine snapshot', () => {
  it('carries engine API keys to the CLI', () => {
    const env = configToEnv({
      searchEngineApiKeys: { brave: 'bsa-secret', searxng: 'unused' },
      searchEngineConfigs: { brave: { hasApiKey: true, options: { country: 'DE', freshness: 'pw' } } },
    })
    expect(JSON.parse(env[KEYS_ENV])).toEqual({ brave: 'bsa-secret', searxng: 'unused' })
    expect(JSON.parse(env[OPTIONS_ENV])).toEqual({ brave: { country: 'DE', freshness: 'pw' } })
  })

  it('folds the legacy githubToken into the same keys map', () => {
    const env = configToEnv({ githubToken: 'ghp_x' })
    expect(JSON.parse(env[KEYS_ENV])).toEqual({ github: 'ghp_x' })
    // …and keeps the dedicated var for CLI-side back-compat.
    expect(env.DSH_NETWORK_GITHUB_TOKEN).toBe('ghp_x')
  })

  it('omits both maps entirely when nothing is configured', () => {
    const env = configToEnv({ searchEngines: ['bing'] })
    expect(KEYS_ENV in env).toBe(false)
    expect(OPTIONS_ENV in env).toBe(false)
  })

  it('drops empty keys, non-string keys, and empty option objects', () => {
    const env = configToEnv({
      searchEngineApiKeys: { brave: '', other: '   ', bogus: 42 },
      searchEngineConfigs: {
        brave: { options: {} },
        searxng: { options: { language: 'zh' } },
        junk: { options: 'not an object' },
      },
    })
    expect(KEYS_ENV in env).toBe(false)
    expect(JSON.parse(env[OPTIONS_ENV])).toEqual({ searxng: { language: 'zh' } })
  })

  it('round-trips through the engine-side reader', () => {
    const env = configToEnv({
      searchEngineConfigs: { brave: { options: { country: 'JP', offset: '3' } } },
    })
    // The engine reads its slice out of the same snapshot the host built.
    expect(readEngineEnvOptions('brave', env)).toEqual({ country: 'JP', offset: '3' })
    expect(readEngineEnvOptions('bing', env)).toEqual({})
  })
})

/**
 * The hop BELOW configToEnv: the browser's PUT. The engine dialog types the
 * key into `searchEngineConfigs[id].apiKey` and this is the only code that
 * moves it into `config.searchEngineApiKeys` — the map configToEnv ships.
 * If that write ever disappears, the whole chain below still "works" (the
 * summary shows a configured key, the flag is true) while the CLI receives
 * an empty map and no keyed engine can ever authenticate. That is the exact
 * half that was broken: `hasApiKey: true` was stored, the secret was not.
 */
describe('applyCardSettings — the browser PUT fills searchEngineApiKeys', () => {
  it('stores the typed key and flips hasApiKey', () => {
    const config: Record<string, any> = {}
    expect(applyCardSettings(config, {
      searchEngineConfigs: { brave: { endpoint: 'https://api.search.brave.com/res/v1/web/search', apiKey: 'bsa-secret', options: {} } },
    })).toEqual({ ok: true })
    expect(config.searchEngineApiKeys).toEqual({ brave: 'bsa-secret' })
    expect(config.searchEngineConfigs.brave.hasApiKey).toBe(true)
    // …and the map is what the CLI actually receives.
    expect(JSON.parse(configToEnv(config)[KEYS_ENV])).toEqual({ brave: 'bsa-secret' })
  })

  it('keeps the stored key when the dialog reports an empty/absent field', () => {
    // The input is write-only: reopening the dialog shows an empty box, and
    // "save without typing" must NOT wipe a key the host already holds.
    const config: Record<string, any> = { searchEngineApiKeys: { brave: 'bsa-secret' } }
    applyCardSettings(config, { searchEngineConfigs: { brave: { apiKey: '', hasApiKey: true, options: {} } } })
    expect(config.searchEngineApiKeys).toEqual({ brave: 'bsa-secret' })
    applyCardSettings(config, { searchEngineConfigs: { brave: { hasApiKey: true, options: {} } } })
    expect(config.searchEngineApiKeys).toEqual({ brave: 'bsa-secret' })
    // An unrelated engine's save must not disturb it either.
    applyCardSettings(config, { searchEngineConfigs: { searxng: { endpoint: 'http://127.0.0.1:8888', hasApiKey: false, options: {} } } })
    expect(config.searchEngineApiKeys).toEqual({ brave: 'bsa-secret' })
  })

  it('round-trips a retyped key without leaking the old one', () => {
    const config: Record<string, any> = { searchEngineApiKeys: { brave: 'old' } }
    applyCardSettings(config, { searchEngineConfigs: { brave: { apiKey: 'new', hasApiKey: true, options: {} } } })
    expect(config.searchEngineApiKeys).toEqual({ brave: 'new' })
  })

  it('never returns the key to the browser', () => {
    const config: Record<string, any> = {}
    applyCardSettings(config, { searchEngineConfigs: { brave: { apiKey: 'bsa-secret', hasApiKey: true, options: {} } } })
    expect(JSON.stringify(summarize(config))).not.toContain('bsa-secret')
  })

  it('repairs a drifted flag: hasApiKey true with no stored key reads as false', () => {
    // The live shape of the bug in a real profile: the browser reported a
    // configured key (so the row badge was green) while the map the CLI reads
    // was empty, so Brave was short-circuited as "no credential" with no
    // error anywhere. The badge is a view of the map, never a stored claim.
    const config: Record<string, any> = {
      searchEngineConfigs: { brave: { endpoint: 'https://api.search.brave.com/res/v1/web/search', hasApiKey: true, options: {} } },
    }
    expect(summarize(config).searchEngineConfigs.brave.hasApiKey).toBe(false)
    expect(KEYS_ENV in configToEnv(config)).toBe(false)

    // Re-saving the engine without typing a key heals the snapshot instead of
    // preserving the lie…
    applyCardSettings(config, { searchEngineConfigs: { brave: { hasApiKey: true, endpoint: 'https://api.search.brave.com/res/v1/web/search', options: {} } } })
    expect(config.searchEngineConfigs.brave.hasApiKey).toBe(false)
    // …and a real key turns it on from the map alone.
    applyCardSettings(config, { searchEngineConfigs: { brave: { apiKey: 'bsa-secret', options: {} } } })
    expect(summarize(config).searchEngineConfigs.brave.hasApiKey).toBe(true)
    expect(JSON.parse(configToEnv(config)[KEYS_ENV])).toEqual({ brave: 'bsa-secret' })
  })

  it('surfaces an engine that holds a key but no settings entry', () => {
    // The row is only reachable through the view, so an engine saved straight
    // into the key map (row config / hand-written config.yaml) would be
    // invisible until it also got a searchEngineConfigs entry.
    const view = summarize({ searchEngines: ['bing'], searchEngineApiKeys: { brave: 'bsa-secret' } })
    expect(view.searchEngineConfigs.brave.hasApiKey).toBe(true)
    expect(JSON.stringify(view)).not.toContain('bsa-secret')
  })
})

describe('readEngineEnvOptions — malformed input never throws', () => {
  it('degrades to {} for unset / non-JSON / non-object / wrong-engine values', () => {
    expect(readEngineEnvOptions('brave', {})).toEqual({})
    expect(readEngineEnvOptions('brave', { [OPTIONS_ENV]: 'not json' })).toEqual({})
    expect(readEngineEnvOptions('brave', { [OPTIONS_ENV]: '[1,2]' })).toEqual({})
    expect(readEngineEnvOptions('brave', { [OPTIONS_ENV]: JSON.stringify({ brave: 'x' }) })).toEqual({})
    expect(readEngineEnvOptions('brave', { [OPTIONS_ENV]: JSON.stringify({ brave: [1] }) })).toEqual({})
  })
})

describe('summarize — a configured engine outside the chain still reports its key', () => {
  it('surfaces searchEngineConfigs for engines not yet in searchEngines', () => {
    // The real order of operations: the user pastes the Brave key in the
    // engine dialog BEFORE adding Brave to the chain. Summarizing the chain
    // alone hid that entry, so the dialog reopened as "no API key
    // configured" and the next save wrote hasApiKey:false over a stored key.
    const view = summarize({
      searchEngines: ['bing', 'duckduckgo'],
      searchEngineConfigs: {
        brave: { endpoint: 'https://api.search.brave.com/res/v1/web/search', hasApiKey: true, options: { country: 'DE' } },
      },
      searchEngineApiKeys: { brave: 'bsa-secret' },
    })
    expect(view.searchEngineConfigs.brave).toEqual({
      endpoint: 'https://api.search.brave.com/res/v1/web/search',
      hasApiKey: true,
      options: { country: 'DE' },
    })
    // The key ITSELF must never reach the browser — only the boolean.
    expect(JSON.stringify(view)).not.toContain('bsa-secret')
  })

  it('still reports chain engines and tolerates absent configs', () => {
    const view = summarize({ searchEngines: ['bing'] })
    expect(view.searchEngineConfigs).toEqual({})
  })
})
