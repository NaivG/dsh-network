/**
 * HTML → Markdown converter. Pure function; produces a faithful,
 * readable Markdown view of an arbitrary HTML body. Hosts:
 *   - the dsh-network web_fetch tool (Markdown format),
 *   - the dedicated block renderer in `dsh/client.js` (Markdown is the
 *     body the result view shows when the browser has no rich renderer
 *     for a given HTML snippet).
 *
 * Tag-stripping and entity-decoding live in `html-extract.ts` so the
 * search engines and this converter decode character references through
 * ONE table. The decode runs exactly once, at the very end, after the
 * markup is gone — decoding earlier would let a page's own `&amp;lt;`
 * reach the stripper as `<` and re-enter as markup.
 */
import { decodeEntities, stripTags } from './html-extract.js'

export function htmlToMarkdown(html: string): string {
  let s = String(html)
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '')
  s = s.replace(
    /<(script|style|noscript|template|svg|iframe|form|nav|footer|header|aside|dialog)[\s\S]*?<\/\1>/gi,
    '',
  )
  // pre → fenced code (before inline code handling)
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = stripTags(inner).replace(/^\n+|\n+$/g, '')
    return code ? `\n\`\`\`\n${code}\n\`\`\`\n` : ''
  })
  // table → pipe rows
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows: string[] = []
    const trs = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || []
    for (const tr of trs) {
      const cells: string[] = []
      const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
      let cm: RegExpExecArray | null
      while ((cm = re.exec(tr))) cells.push(stripTags(cm[1] ?? '').replace(/\s+/g, ' ').trim())
      if (cells.length > 0) rows.push(`| ${cells.join(' | ')} |`)
    }
    return rows.length > 0 ? `\n${rows.join('\n')}\n` : ''
  })
  // links before headings/lists so hrefs survive
  s = s.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const txt = stripTags(inner).replace(/\s+/g, ' ').trim()
    if (!txt) return ''
    if (!href || /^(javascript|mailto|tel|data):/i.test(href)) return txt
    return `[${txt}](${href})`
  })
  s = s.replace(/<img\s+[^>]*>/gi, (m) => {
    const src = /src="([^"]*)"/i.exec(m)
    const alt = /alt="([^"]*)"/i.exec(m)
    if (!src || !src[1]) return ''
    return alt && alt[1] ? `![${alt[1]}](${src[1]})` : `![](${src[1]})`
  })
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => {
    const txt = stripTags(inner).replace(/\s+/g, ' ').trim()
    return txt ? `\n${'#'.repeat(Number(n))} ${txt}\n` : ''
  })
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
    const txt = stripTags(inner).replace(/\s+/g, ' ').trim()
    return txt ? `- ${txt}\n` : ''
  })
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    const lines = inner.split('\n')
    return `\n${lines.map((l) => `> ${l.trim()}`).join('\n')}\n`
  })
  s = s.replace(/<hr[^>]*>/gi, '\n---\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => '`' + String(inner).replace(/`/g, '') + '`')
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
  s = s.replace(
    /<\/(p|div|section|article|main|li|tr|ul|ol|dl|dt|dd|figure|figcaption|summary|address|table|tbody|thead|tfoot|h[1-6]|blockquote|pre)>/gi,
    '\n',
  )
  s = stripTags(s)
  s = decodeEntities(s)
  s = s.replace(/[ \t]+\n/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}
