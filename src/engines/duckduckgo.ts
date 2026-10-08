/**
 * DuckDuckGoSearchEngine — DuckDuckGo lite HTML endpoint.
 *
 * Endpoint: `https://html.duckduckgo.com/html/?q=<q>`
 *
 * We must use the `/html` lite endpoint because the bare `/` renders
 * client-side JavaScript. The lite endpoint returns server-rendered HTML
 * that we can parse with regex.
 *
 * Result blocks in 2026 DDG lite HTML:
 *
 *   <div class="result ...result__body">
 *     <h2 class="result__title">
 *       <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded>&...">
 *         Title text
 *       </a>
 *     </h2>
 *     <a class="result__snippet" href="#">Snippet text</a>
 *   </div>
 *
 * Each result href is a DDG redirect: extract `uddg` and `decodeURIComponent`
 * to get the real target URL. Sponsored ad clicks come through
 * `duckduckgo.com/y.js` and must be skipped (they lead to ad networks,
 * not the user's query target).
 *
 * Note: Cloudflare-protected DDG sometimes rate-limits free Node IP
 * ranges. When that happens the CLI's chain falls through to Baidu.
 */
import {
  type SearchEngine,
  type SearchSource,
  composeEngineUrl,
  stripTags,
  FIREFOX_DUCKDUCKGO,
} from './index.ts'

export class DuckDuckGoSearchEngine implements SearchEngine {
  readonly id = 'duckduckgo'
  readonly displayName = 'DuckDuckGo'
  readonly endpoint = 'https://html.duckduckgo.com/html/'
  readonly defaultHeaders = FIREFOX_DUCKDUCKGO

  buildUrl(query: string, options?: Readonly<Record<string, string>>): string {
    return composeEngineUrl(this.endpoint, 'q', query, options)
  }

  parse(html: string, max: number): SearchSource[] {
    // Snippets live in their own anchors (one per result, in order).
    const snippets: string[] = []
    const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    let snippetMatch: RegExpExecArray | null
    while ((snippetMatch = snippetRe.exec(html))) {
      snippets.push(stripTags(snippetMatch[1] ?? '').replace(/\s+/g, ' ').trim())
    }

    const out: SearchSource[] = []
    const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m: RegExpExecArray | null
    let i = 0
    while ((m = anchorRe.exec(html)) && out.length < max) {
      const title = stripTags(m[2] ?? '').replace(/\s+/g, ' ').trim()
      const url = DuckDuckGoSearchEngine.unwrapUrl(m[1] ?? '')
      if (!title || !url || url === 'https://duckduckgo.com') continue
      if (/duckduckgo\.com\/y\.js/i.test(url)) continue // sponsored ad click-tracker
      const source: SearchSource = { url, title }
      if (i < snippets.length && snippets[i]) source.snippet = snippets[i]
      out.push(source)
      i += 1
    }
    return out
  }

  /**
   * Strip a DDG redirect wrapper. The href is either `//duckduckgo.com/l/?uddg=...`
   * (protocol-relative) or a fully-qualified DDG URL. The `uddg` query
   * parameter holds the percent-encoded real target URL.
   */
  static unwrapUrl(href: string): string {
    const full = String(href).startsWith('//') ? 'https:' + href : href
    const m = /[?&]uddg=([^&]+)/.exec(full)
    if (m && m[1]) {
      try {
        return decodeURIComponent(m[1])
      } catch {
        return m[1]
      }
    }
    return full
  }
}
