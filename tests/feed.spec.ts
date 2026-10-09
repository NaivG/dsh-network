import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_TOTAL_CHARS,
  FEED_PREVIEW_CHARS,
  RENDER_MAX_ITEMS,
  normalizeFeedDate,
  renderFeed,
  sniffFeedKind,
  type FeedRender,
} from '../src/feed.ts'

/** Render or throw — a test that expected a feed and got null should fail loudly. */
function feed(xml: string, options?: Parameters<typeof renderFeed>[1]): FeedRender {
  const out = renderFeed(xml, options)
  expect(out, 'expected the body to be recognised as a feed').not.toBeNull()
  return out as FeedRender
}

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example &amp; Co</title>
    <link>https://example.com/</link>
    <atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml"/>
    <description>A demo &lt;b&gt;feed&lt;/b&gt;</description>
    <lastBuildDate>Tue, 06 Oct 2026 10:00:00 GMT</lastBuildDate>
    <item>
      <title>First &amp; foremost</title>
      <link>/posts/1</link>
      <guid isPermaLink="true">https://example.com/posts/1</guid>
      <pubDate>Mon, 05 Oct 2026 09:00:00 GMT</pubDate>
      <author>ada@example.com</author>
      <category>eng</category>
      <category>release</category>
      <description><![CDATA[<p>Body with a <a href="/rel">relative link</a> &amp; an entity.</p>]]></description>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/posts/2</link>
      <pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate>
      <description>&lt;p&gt;escaped paragraph&lt;/p&gt;</description>
    </item>
  </channel>
</rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom demo</title>
  <subtitle>sub &amp; subtitle</subtitle>
  <link rel="self" href="/atom.xml"/>
  <link rel="alternate" href="https://example.org/"/>
  <updated>2026-10-04T18:30:02Z</updated>
  <entry>
    <title>Entry one</title>
    <link rel="self" href="https://example.org/e/1"/>
    <link rel="alternate" href="https://example.org/e/1.html"/>
    <id>tag:example.org,2026:e1</id>
    <published>2026-10-04T18:30:02Z</published>
    <author><name>Grace H.</name></author>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>rich <em>xhtml</em> body</p></div></content>
  </entry>
  <entry>
    <title>Entry two</title>
    <link rel="alternate" href="/e/2.html"/>
    <id>tag:example.org,2026:e2</id>
    <updated>2026-10-03T18:30:02Z</updated>
    <summary type="text">literal &amp;amp; stays</summary>
  </entry>
</feed>`

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://old.example.net/">
    <title>RDF demo</title>
    <link>https://old.example.net/</link>
    <description>rss 1.0</description>
  </channel>
  <item rdf:about="https://old.example.net/a">
    <title>RDF item</title>
    <link rdf:resource="https://old.example.net/a"/>
    <dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">2026-10-02T12:00:00+02:00</dc:date>
    <description>rdf body</description>
  </item>
</rdf:RDF>`

describe('sniffFeedKind', () => {
  it('recognises the three feed roots', () => {
    expect(sniffFeedKind(RSS)).toBe('rss')
    expect(sniffFeedKind(ATOM)).toBe('atom')
    expect(sniffFeedKind(RDF)).toBe('rdf')
  })

  it('survives a BOM, leading whitespace and an XML declaration', () => {
    expect(sniffFeedKind('﻿\n  <?xml version="1.0"?><rss version="2.0"><channel/></rss>')).toBe('rss')
  })

  it('does not claim XML that is not a feed', () => {
    // A sitemap, an OPML export and a page that merely mentions <feed> in
    // prose must all fall through to the normal HTML→Markdown path.
    expect(sniffFeedKind('<?xml version="1.0"?><urlset><url><loc>x</loc></url></urlset>')).toBeNull()
    expect(sniffFeedKind('<opml version="2.0"><body><outline text="a"/></body></opml>')).toBeNull()
    expect(sniffFeedKind('<html><body>the &lt;feed&gt; element is documented here</body></html>')).toBeNull()
  })
})

describe('renderFeed — RSS 2.0', () => {
  it('labels the channel and the items', () => {
    const out = feed(RSS, { baseUrl: 'https://example.com/blog/' })
    expect(out.kind).toBe('rss')
    expect(out.title).toBe('Example & Co')
    expect(out.link).toBe('https://example.com/')
    expect(out.self).toBe('https://example.com/feed.xml')
    expect(out.updated).toBe('2026-10-06')
    expect(out.totalItems).toBe(2)
    expect(out.markdown).toContain('# Example & Co')
    expect(out.markdown).toContain('Feed: <https://example.com/feed.xml>')
    expect(out.markdown).toContain('## 1. First & foremost')
    expect(out.markdown).toContain('2026-10-05 · ada@example.com · <https://example.com/posts/1>')
    expect(out.markdown).toContain('eng, release')
  })

  it('resolves relative item links and the channel link against baseUrl', () => {
    const out = feed(RSS, { baseUrl: 'https://example.com/blog/' })
    expect(out.items[0]!.link).toBe('https://example.com/posts/1')
  })

  it('runs CDATA HTML through the HTML→Markdown converter, decodng once', () => {
    const out = feed(RSS)
    // `&amp;` inside CDATA is the HTML source's entity: one decode, so the
    // model reads "…& an entity", never the five characters "&amp;".
    expect(out.items[0]!.body).toContain('& an entity')
    expect(out.markdown).not.toContain('&amp;')
    expect(out.items[0]!.body).toContain('[relative link](/rel)')
  })

  it('decodes escaped character data into real markup exactly once', () => {
    const out = feed(RSS)
    // `&lt;p&gt;escaped paragraph&lt;/p&gt;` in XML is an HTML paragraph, not
    // literal angle brackets — and it is decoded once, so no `&lt;` leaks.
    expect(out.items[1]!.body).toBe('escaped paragraph')
    expect(out.markdown).not.toContain('&lt;')
  })
})

describe('renderFeed — Atom', () => {
  it('reads attribute links, xhtml content and a nested author name', () => {
    const out = feed(ATOM, { baseUrl: 'https://example.org/' })
    expect(out.kind).toBe('atom')
    expect(out.self).toBe('https://example.org/atom.xml')
    expect(out.link).toBe('https://example.org/')
    expect(out.description).toBe('sub & subtitle')
    expect(out.updated).toBe('2026-10-04')
    expect(out.items[0]!.link).toBe('https://example.org/e/1.html')
    expect(out.items[0]!.author).toBe('Grace H.')
    expect(out.items[0]!.body).toContain('rich *xhtml* body')
    expect(out.items[1]!.link).toBe('https://example.org/e/2.html')
    expect(out.items[1]!.body).toBe('literal &amp; stays')
  })
})

describe('renderFeed — RSS 1.0 (RDF)', () => {
  it('finds items that are siblings of the channel, not children', () => {
    const out = feed(RDF)
    expect(out.kind).toBe('rdf')
    expect(out.title).toBe('RDF demo')
    expect(out.totalItems).toBe(1)
    expect(out.items[0]!.link).toBe('https://old.example.net/a')
    expect(out.items[0]!.date).toBe('2026-10-02')
  })
})

describe('renderFeed — hostile / malformed input', () => {
  it('degrades instead of throwing on an unescaped ampersand', () => {
    // A strict parser rejects this document outright. Losing the whole feed
    // over one "&" is the failure mode this module exists to avoid.
    const out = feed(`<rss version="2.0"><channel><title>Tom & Jerry</title>
      <item><title>A & B</title><description>raw & ampersand</description></item>
    </channel></rss>`)
    expect(out.title).toBe('Tom & Jerry')
    expect(out.items[0]!.title).toBe('A & B')
    expect(out.items[0]!.body).toBe('raw & ampersand')
  })

  it('closes a namespaced element without swallowing its siblings', () => {
    // A close tag's qualified name must be split the same way the open
    // tag's was. Comparing `</dc:date>` against a node whose name is `date`
    // never matches, so the element keeps nesting and every field after it
    // — including the next item — disappears into its text.
    const out = feed(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
        xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>ns</title>
        <item><title>one</title>
          <dc:date>2026-10-02T12:00:00Z</dc:date>
          <description>short</description>
          <content:encoded><![CDATA[<p>full body</p>]]></content:encoded>
        </item>
        <item><title>two</title><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate><description>b</description></item>
      </channel></rss>`)
    expect(out.totalItems).toBe(2)
    expect(out.items[0]!.date).toBe('2026-10-02')
    // content:encoded wins over description — and neither ate the next item.
    expect(out.items[0]!.body).toBe('full body')
    expect(out.items[1]!.title).toBe('two')
    expect(out.items[1]!.date).toBe('2026-10-06')
    expect(out.items[1]!.body).toBe('b')
  })

  it('keeps finding items when <link> is never closed', () => {
    // Atom-style <link href=…> written without the self-closing slash
    // nests every following item inside the previous one.
    const out = feed(`<feed xmlns="http://www.w3.org/2005/Atom">
      <title>sloppy</title>
      <entry><title>one</title><link rel="alternate" href="https://x.test/1">
        <id>1</id><summary>first</summary></entry>
      <entry><title>two</title><id>2</id><summary>second</summary></entry>
    </feed>`)
    expect(out.totalItems).toBe(2)
    expect(out.items.map((i) => i.title)).toEqual(['one', 'two'])
  })

  it('ignores a DOCTYPE internal subset instead of expanding its entities', () => {
    const billion = `<?xml version="1.0"?>
    <!DOCTYPE rss [ <!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"> ]>
    <rss version="2.0"><channel><title>no expansion</title>
      <item><description>&b;</description></item></channel></rss>`
    const out = feed(billion)
    // Left literal: nothing was expanded, so the body stays the 7 characters
    // the document actually contains instead of a megabyte of 'a'.
    expect(out.items[0]!.body).toBe('&b;')
  })

  it('does not recurse without bound on deeply nested markup', () => {
    const deep = `${'<div>'.repeat(5000)}x${'</div>'.repeat(5000)}`
    expect(() => feed(`<rss version="2.0"><channel><title>deep</title><item><description>${deep}</description></item></channel></rss>`)).not.toThrow()
  })

  it('returns null for a non-feed body so the caller can fall through', () => {
    expect(renderFeed('<html><body><p>hello</p></body></html>')).toBeNull()
    expect(renderFeed('{"json":true}')).toBeNull()
    expect(renderFeed('')).toBeNull()
  })
})

describe('renderFeed — token budget', () => {
  const many = `<rss version="2.0"><channel><title>Many</title>${Array.from(
    { length: 40 },
    (_v, i) => `<item><title>Item ${i}</title><link>https://x.test/${i}</link><description>body ${i}</description></item>`,
  ).join('')}</channel></rss>`

  // Server mode: no whole-feed budget. The render is complete, the cache
  // holds the tail, and the preview ends on an item boundary.
  const big = `<rss version="2.0"><channel><title>Big</title>${Array.from(
    { length: 40 },
    (_v, i) =>
      `<item><title>Item ${i}</title><link>https://x.test/${i}</link><description>${'padding '.repeat(200)}</description></item>`,
  ).join('')}</channel></rss>`

  it('renders every item by default — the tail is cached, not discarded', () => {
    const out = feed(many)
    expect(out.items).toHaveLength(40)
    expect(out.totalItems).toBe(40)
    expect(out.itemsClipped).toBe(false)
    expect(out.markdown).not.toContain('not shown')
    expect(out.markdown).toContain('## 40. Item 39')
  })

  it('stops at the work ceiling and says so', () => {
    const out = feed(many, { maxItems: 3 })
    expect(out.items).toHaveLength(3)
    expect(out.totalItems).toBe(40)
    expect(out.itemsClipped).toBe(true)
    expect(out.markdown).toContain('_… 37 more of 40 items not rendered')
    expect(out.markdown).not.toContain('## 4.')
    expect(RENDER_MAX_ITEMS).toBeGreaterThanOrEqual(500)
  })

  it('previews at a whole item boundary and still holds the whole feed', () => {
    const out = feed(big)
    expect(out.markdown.length).toBeGreaterThan(FEED_PREVIEW_CHARS * 2)
    expect(out.previewCutAt).not.toBeNull()
    expect(out.previewCutAt!).toBeLessThanOrEqual(FEED_PREVIEW_CHARS)
    // The cut lands on the end of a complete `## N.` block, never inside one.
    const preview = out.markdown.slice(0, out.previewCutAt!)
    expect(out.markdown.slice(out.previewCutAt!)).toMatch(/^\n\n## \d+\./)
    expect(preview.match(/^## \d+\. /gm)!.length).toBeGreaterThan(1)
    // …and not mid-word: every fixture body ends with a whole 'padding'.
    expect(preview.endsWith('padding')).toBe(true)
  })

  it('has no preview cut when the whole render fits', () => {
    const out = feed(many)
    expect(out.markdown.length).toBeLessThan(FEED_PREVIEW_CHARS)
    expect(out.previewCutAt).toBeNull()
  })

  it('falls back to a hard cut when not even the first item fits', () => {
    const huge = `<rss version="2.0"><channel><title>One huge item</title><item><title>big</title>
      <description>${'word '.repeat(60_000)}</description></item></channel></rss>`
    const out = feed(huge, { maxItemChars: 60_000, previewCap: 1000 })
    expect(out.previewCutAt).toBeNull()
  })

  it('keeps the inline budget when one is passed (no-cache CLI path)', () => {
    // `big`, not `many`: forty one-line items fit inside 2000 characters on
    // their own, so only a fixture with real bodies exercises this knob.
    const out = feed(big, { maxTotalChars: 2000 })
    expect(out.items.length).toBeLessThan(40)
    expect(out.items.length).toBeGreaterThan(0)
    expect(out.totalItems).toBe(40)
    expect(out.markdown).toContain(`within a 2000-character budget`)
    expect(out.markdown.length).toBeLessThan(2000 + 200)
    expect(DEFAULT_MAX_TOTAL_CHARS).toBe(FEED_PREVIEW_CHARS)
  })

  it('always renders the first item, even when it alone busts the budget', () => {
    const huge = `<rss version="2.0"><channel><title>One huge item</title><item><title>big</title>
      <description>${'word '.repeat(6000)}</description></item></channel></rss>`
    const out = feed(huge, { maxTotalChars: 1000 })
    expect(out.items).toHaveLength(1)
    expect(out.markdown).toContain('## 1. big')
  })

  it('caps one item body and states the real length it clipped from', () => {
    const long = `<rss version="2.0"><channel><title>One huge item</title><item><title>big</title>
      <description>${'word '.repeat(6000)}</description></item></channel></rss>`
    const out = feed(long, { maxItemChars: 500 })
    expect(out.items[0]!.body!.length).toBeLessThanOrEqual(500)
    // The reported total is the RENDERED length, not the source length.
    const marker = out.markdown.match(/_… body clipped at (\d+) of (\d+) characters\._/)
    expect(marker).not.toBeNull()
    expect(Number(marker![1])).toBe(500)
    expect(Number(marker![2])).toBeGreaterThan(25_000)
  })

  it('clips on a block boundary so the model never gets half a sentence', () => {
    const paragraphs = Array.from({ length: 200 }, (_v, i) => `<p>Paragraph ${i} padding padding padding.</p>`).join('')
    const out = feed(`<rss version="2.0"><channel><title>p</title><item><description>${paragraphs}</description></item></channel></rss>`, {
      maxItemChars: 400,
    })
    const body = out.items[0]!.body!
    expect(body.length).toBeLessThanOrEqual(400)
    // The last line is a WHOLE paragraph, not a fragment of one.
    expect(body.split('\n').pop()).toMatch(/^Paragraph \d+ padding padding padding\.$/)
  })

  it('defaults to a bounded read', () => {
    expect(RENDER_MAX_ITEMS).toBe(500)
    expect(DEFAULT_MAX_TOTAL_CHARS).toBe(20_000)
    // No whole-feed budget by default: the count ceiling is the only stop.
    expect(feed(many).items).toHaveLength(40)
  })
})

describe('normalizeFeedDate', () => {
  it('reformats plausible timestamps and leaves the rest alone', () => {
    expect(normalizeFeedDate('Thu, 08 Oct 2026 23:59:59 GMT')).toBe('2026-10-08')
    expect(normalizeFeedDate('2026-10-04T18:30:02Z')).toBe('2026-10-04')
    // Not a date: never guessed at.
    expect(normalizeFeedDate('last Tuesday-ish')).toBe('last Tuesday-ish')
    // Wrong century: a feed that writes an epoch-seconds value read as ms,
    // or a stale template date. Echo it rather than render a wrong year.
    expect(normalizeFeedDate('Thu, 08 Oct 1971 23:59:59 GMT')).toBe('Thu, 08 Oct 1971 23:59:59 GMT')
    expect(normalizeFeedDate(null)).toBeNull()
  })
})
