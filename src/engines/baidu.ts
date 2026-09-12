/**
 * BaiduSearchEngine — Baidu web search.
 *
 * Endpoint: `https://www.baidu.com/s?wd=<q>&ie=utf-8`
 *
 * `ie=utf-8` overrides Baidu's default GB2132 encoding; without it,
 * Chinese characters come back mojibake. The `Host` header is pinned
 * to `www.baidu.com` because Baidu's reverse-proxy stack occasionally
 * 502s when the header is reconstructed from the URL alone.
 *
 * Result blocks in 2026 Baidu HTML:
 *
 *   <div class="c-container ..." data-tools="..." mu="https://real.url/">
 *     <h3 class="t"><a href="https://www.baidu.com/link?url=...">Title</a></h3>
 *     <div data-module="abstract">
 *       <span class="cu-line-clamp-2">Snippet text…</span>
 *     </div>
 *   </div>
 *
 * The real URL is best taken from the container's `mu` attribute
 * (Baidu pre-renders it for SEO); falling back to the anchor's `href`
 * (a baidu.com/link redirect) is acceptable but uglier in our output.
 *
 * Snippet extraction cascades through four strategies because Baidu
 * serves three different result-card layouts (standard, rich cards
 * like baike, and AI snippets):
 *   1. `[data-module="abstract"] .cu-line-clamp-{2,3}`  (newest)
 *   2. Any `.cu-line-clamp-{2,3,4}` inside the container
 *   3. Old `.c-abstract` (legacy page)
 *   4. `.c-color` descriptive element (rich cards)
 */
import {
  type SearchEngine,
  type SearchSource,
  composeEngineUrl,
  stripTags,
  FIREFOX_BAIDU,
} from './index.ts'

export class BaiduSearchEngine implements SearchEngine {
  readonly id = 'baidu'
  readonly displayName = 'Baidu'
  readonly endpoint = 'https://www.baidu.com/s'
  readonly defaultHeaders = FIREFOX_BAIDU

  buildUrl(query: string, options?: Readonly<Record<string, string>>): string {
    return composeEngineUrl(this.endpoint, 'wd', query, { ie: 'utf-8', ...(options ?? {}) })
  }

  parse(html: string, max: number): SearchSource[] {
    const out: SearchSource[] = []
    const blockRe =
      /<div[^>]*class="[^"]*c-container[^"]*"[^>]*>[\s\S]*?(?=<div[^>]*class="[^"]*c-container|$)/gi
    let m: RegExpExecArray | null
    while ((m = blockRe.exec(html)) && out.length < max) {
      const block = m[0]
      const h3 = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i.exec(block)
      if (!h3) continue
      // Prefer the `mu` attribute (real URL); fall back to the anchor href.
      const mu = /\bmu="([^"]*)"/i.exec(block)
      const url = mu && mu[1] ? mu[1] : h3[1] ?? ''
      const title = stripTags(h3[2] ?? '').replace(/\s+/g, ' ').trim()
      if (!url || !title) continue
      const source: SearchSource = { url, title }
      const snippet = BaiduSearchEngine.extractSnippet(block)
      if (snippet) source.snippet = snippet
      out.push(source)
    }
    return out
  }

  /**
   * Pull the snippet text from a Baidu result block. Strategy cascade
   * exists because Baidu's three result layouts put the snippet in
   * different elements; see the engine header for the four patterns.
   */
  static extractSnippet(block: string): string {
    // 1) data-module="abstract" + cu-line-clamp-{2,3} (newest standard layout)
    const mod = /data-module="abstract"[\s\S]*?<span[^>]*class="[^"]*cu-line-clamp[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)
    if (mod && mod[1]) return stripTags(mod[1]).replace(/\s+/g, ' ').trim()
    // 2) bare cu-line-clamp-{2,3,4} anywhere in the container
    const clamp = /class="[^"]*cu-line-clamp[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i.exec(block)
    if (clamp && clamp[1]) return stripTags(clamp[1]).replace(/\s+/g, ' ').trim()
    // 3) legacy c-abstract
    const abs = /class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i.exec(block)
    if (abs && abs[1]) return stripTags(abs[1]).replace(/\s+/g, ' ').trim()
    // 4) rich-card descriptive .c-color
    const color = /class="[^"]*c-color[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i.exec(block)
    if (color && color[1]) return stripTags(color[1]).replace(/\s+/g, ' ').trim()
    return ''
  }
}
