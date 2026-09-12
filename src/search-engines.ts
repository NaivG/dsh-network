/**
 * Backward-compatibility shim.
 *
 * The real implementations moved to `./engines/` so each search
 * engine lives in its own file (with its own headers and parser) and
 * the registry pattern from tessera's `web_search_engine.dart`
 * composes them. This file re-exports the public surface unchanged so
 * tests and any external consumer keep working.
 *
 * New code should import from `./engines/index.ts` directly.
 */
export {
  type SearchEngine,
  type SearchSource,
  SearchEngineRegistry,
  defaultRegistry,
  registerDefaultEngines,
  b64UrlDecode,
  stripTags,
  composeEngineUrl,
} from './engines/index.ts'

import { BingSearchEngine } from './engines/bing.ts'
import { DuckDuckGoSearchEngine } from './engines/duckduckgo.ts'
import { BaiduSearchEngine } from './engines/baidu.ts'
import type { SearchEngine } from './engines/types.ts'

/** @deprecated use `new BingSearchEngine()` from `./engines/bing.ts`. */
export const ENGINE_IDS = ['bing', 'duckduckgo', 'baidu'] as const
/** @deprecated use `EngineId` parameter typing from individual engines. */
export type EngineId = (typeof ENGINE_IDS)[number]

/** @deprecated drive engines through the registry. */
export function buildEngineUrl(id: EngineId, query: string): string {
  const e = getEngine(id)
  return e.buildUrl(query)
}

/** @deprecated drive engines through the registry. */
export function parseEngineResults(id: EngineId, html: string, max: number) {
  return getEngine(id).parse(html, max)
}

/** @deprecated use `BingSearchEngine.unwrapBingUrl` directly. */
export function unwrapBingUrl(href: string): string {
  return BingSearchEngine.unwrapBingUrl(href)
}

/** @deprecated use `DuckDuckGoSearchEngine.unwrapUrl` directly. */
export function unwrapDuckDuckGoUrl(href: string): string {
  return DuckDuckGoSearchEngine.unwrapUrl(href)
}

/** @deprecated instantiate `BingSearchEngine` directly. */
export function parseBingResults(html: string, max: number) {
  return new BingSearchEngine().parse(html, max)
}

/** @deprecated instantiate `DuckDuckGoSearchEngine` directly. */
export function parseDuckDuckGoResults(html: string, max: number) {
  return new DuckDuckGoSearchEngine().parse(html, max)
}

/** @deprecated instantiate `BaiduSearchEngine` directly. */
export function parseBaiduResults(html: string, max: number) {
  return new BaiduSearchEngine().parse(html, max)
}

/** @deprecated use `BaiduSearchEngine.extractSnippet` directly. */
export function baiduSnippet(block: string): string {
  return BaiduSearchEngine.extractSnippet(block)
}

function getEngine(id: EngineId): SearchEngine {
  switch (id) {
    case 'bing':
      return new BingSearchEngine()
    case 'duckduckgo':
      return new DuckDuckGoSearchEngine()
    case 'baidu':
      return new BaiduSearchEngine()
  }
}
