/**
 * Pure HTML helpers shared by the fetcher and the HTML→Markdown converter.
 * Dependency-free; safe to call on hostile / malformed markup.
 */

export function stripTags(s: string): string {
  return String(s).replace(/<[^>]*>/g, '')
}

export function normalizeWhitespace(s: string): string {
  return String(s).replace(/\s+/g, ' ').trim()
}

interface VisitedLink {
  text: string
  url: string
}

/** Extract `<a href=...>text</a>` links, normalizing relative URLs against `base`. */
export function extractLinks(html: string, base: string): VisitedLink[] {
  const out: VisitedLink[] = []
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = m[1]
    if (!href || /^(javascript|mailto|tel|data):/i.test(href)) continue
    let resolved: string
    try {
      resolved = new URL(href, base).toString()
    } catch {
      continue
    }
    const text = normalizeWhitespace(stripTags(m[2] ?? ''))
    if (!text) continue
    out.push({ text, url: resolved })
  }
  return out
}

/**
 * Pull the page's visible text: strip script/style/svgs/iframes/forms/nav, then
 * collapse whitespace. Returns the document title when one is present.
 */
export function extractVisibleTextFromHtml(html: string): { title: string | null; text: string } {
  let s = String(html)
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '')
  s = s.replace(
    /<(script|style|noscript|template|svg|iframe|form|nav|footer|header|aside|dialog)[\s\S]*?<\/\1>/gi,
    '',
  )
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)
  const titleText = title ? normalizeWhitespace(stripTags(title[1] ?? '')) : null
  // Block-level closers insert real newlines so list items and headings stay
  // readable, mirroring what a browser would render as separate paragraphs.
  s = s.replace(
    /<\/(p|div|section|article|main|li|tr|ul|ol|dl|dt|dd|figure|figcaption|summary|address|table|tbody|thead|tfoot|h[1-6]|blockquote|pre|br)>/gi,
    '\n',
  )
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = stripTags(s)
  s = s.replace(/[ \t]+\n/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return { title: titleText, text: s.trim() }
}
