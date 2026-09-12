/**
 * dsh-network search engine registry — barrel + default registration.
 *
 * Usage:
 *
 *   import { defaultRegistry, registerDefaultEngines } from './engines/index.ts'
 *   registerDefaultEngines(defaultRegistry)
 *   const engines = defaultRegistry.resolve(['bing', 'duckduckgo'])
 *
 * Adding a new engine:
 *   1. Create `src/engines/<name>.ts` exporting a class implementing
 *      `SearchEngine`. Keep parsers pure (no I/O) so the engines stay
 *      unit-testable without network.
 *   2. Add `export * from './<name>.ts'` below.
 *   3. Add `new <Name>SearchEngine()` to `registerDefaultEngines`.
 *
 * Engines registered first become the chain head — keep the most
 * reliable one (Bing) at the top.
 */

export * from './types.ts'
export * from './header-profiles.ts'
export { BingSearchEngine } from './bing.ts'
export { DuckDuckGoSearchEngine } from './duckduckgo.ts'
export { BaiduSearchEngine } from './baidu.ts'
export { GitHubSearchEngine, routeGithubIndexes } from './github.ts'
export { SearxngSearchEngine, SEARXNG_DEFAULT_ENDPOINT, SEARXNG_ENV, buildSearxngUrl, normalizeSearxngEndpoint } from './searxng.ts'
// web_sitemap is the curated portal catalog used by the LLM to pick
// authoritative sources. It lives outside the engine registry (it is
// pure data, not a search backend) so we only re-export it from here
// for discoverability — engines themselves do not depend on it.
export * as WebSitemap from '../sitemap.js'

import { SearchEngineRegistry, type SearchEngine } from './types.ts'
import { BingSearchEngine } from './bing.ts'
import { DuckDuckGoSearchEngine } from './duckduckgo.ts'
import { BaiduSearchEngine } from './baidu.ts'
import { GitHubSearchEngine } from './github.ts'
import { SearxngSearchEngine } from './searxng.ts'

/** The process-wide registry. Call `registerDefaultEngines` at startup. */
export const defaultRegistry = new SearchEngineRegistry()

/**
 * Register Bing, DuckDuckGo, Baidu, GitHub, and SearXNG as the default
 * search chain.
 *
 * Order matters: the chain runs engines in registration order, so the
 * most reliable one (Bing) goes first. GitHub sits near the tail — it is
 * a fallback for code/ecosystem queries and its anonymous search quota is
 * only 10 req/min per IP. SearXNG sits LAST: it targets a self-hosted
 * instance that is not guaranteed to be running, so it is never part of
 * the DEFAULT chain (`DSH_NETWORK_SEARCH_ENGINES` defaults to
 * bing,duckduckgo,baidu) — users opt in via the env var or the settings
 * UI, and its requests get loopback access only when the configured
 * endpoint is itself private (see `engineAllowsPrivate` in cli.ts).
 * Users can override the chain order via the `DSH_NETWORK_SEARCH_ENGINES`
 * env var.
 */
export function registerDefaultEngines(registry: SearchEngineRegistry = defaultRegistry): readonly SearchEngine[] {
  const engines: SearchEngine[] = [
    new BingSearchEngine(),
    new DuckDuckGoSearchEngine(),
    new BaiduSearchEngine(),
    new GitHubSearchEngine(),
    new SearxngSearchEngine(),
  ]
  for (const e of engines) registry.register(e)
  return engines
}
