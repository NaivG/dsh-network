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
// eslint-disable-next-line no-new-func
const summarize = new Function(
  `${githubSortsDecl[0]}\n${summarizeMatch[0]}\nreturn summarize;`,
)() as (config: Record<string, unknown>) => Record<string, any>

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
