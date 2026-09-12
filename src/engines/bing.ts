/**
 * BingSearchEngine — Bing web search via the desktop HTML endpoint.
 *
 * Endpoint: `https://www.bing.com/search?q=<q>&pc=MOZI&form=MOZLBR`
 *
 * The `pc=MOZI&form=MOZLBR` pair is Bing's hint that the requester is
 * on the new homepage layout — it returns the modern `<li class="b_algo">`
 * result blocks instead of the older `<li class="b_algo"` shape, and
 * avoids the 302-to-consent-page that bare Firefox-127 sometimes hits.
 *
 * Result blocks in 2026 Bing HTML:
 *
 *   <li class="b_algo">
 *     <h2>
 *       <a href="https://www.bing.com/ck/a?...&u=a1<base64url>&ntb=1"
 *          h="ID=SERP,...">
 *         Title text
 *       </a>
 *     </h2>
 *     <div class="b_caption">
 *       <p class="b_lineclamp2">Snippet text…</p>
 *     </div>
 *   </li>
 *
 * The `ck/a` redirect encodes the real URL as `u=a1` + base64url of the
 * target — `unwrapBingUrl` decodes it. When the block omits the ck/a
 * redirect (rare), the parser falls back to the raw href.
 */
import {
  type SearchEngine,
  type SearchSource,
  b64UrlDecode,
  composeEngineUrl,
  stripTags,
  FIREFOX_BING,
} from './index.ts'

export class BingSearchEngine implements SearchEngine {
  readonly id = 'bing'
  readonly displayName = 'Bing'
  readonly endpoint = 'https://www.bing.com/search'
  readonly defaultHeaders = FIREFOX_BING

  buildUrl(query: string, options?: Readonly<Record<string, string>>): string {
    return composeEngineUrl(this.endpoint, 'q', query, {
      pc: 'MOZI',
      form: 'MOZLBR',
      ...(options ?? {}),
    })
  }

  parse(html: string, max: number): SearchSource[] {
    const out: SearchSource[] = []
    const blockRe = /<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/gi
    let block: RegExpExecArray | null
    while ((block = blockRe.exec(html)) && out.length < max) {
      const chunk = block[0]
      const anchor = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(chunk)
      if (!anchor) continue
      const href = anchor[1] ?? ''
      const title = stripTags(anchor[2] ?? '').replace(/\s+/g, ' ').trim()
      const url = BingSearchEngine.unwrapBingUrl(href)
      if (!url || !title) continue
      const pMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk)
      const snippet = pMatch ? stripTags(pMatch[1] ?? '').replace(/\s+/g, ' ').trim() : ''
      const source: SearchSource = { url, title }
      if (snippet) source.snippet = snippet
      out.push(source)
    }
    return out
  }

  /**
   * Decode Bing's `ck/a` redirect. When the href contains `u=a1<...>`,
   * the suffix is base64url of the real URL. Otherwise return the href
   * unchanged (already-clean links pass through).
   */
  static unwrapBingUrl(href: string): string {
    const clean = String(href).replace(/&amp;/gi, '&')
    if (!/\/ck\/a\?/i.test(clean)) return clean
    const uMatch = /[?&]u=([^&]+)/.exec(clean)
    if (!uMatch || !uMatch[1]) return clean
    let u = uMatch[1]
    try {
      u = decodeURIComponent(u)
    } catch {
      /* keep raw */
    }
    if (!u.startsWith('a1')) return clean
    const decoded = b64UrlDecode(u.slice(2))
    return decoded ?? clean
  }
}
