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

/**
 * HTML character references → the characters they stand for.
 *
 * Every text node this package hands to a model or a UI must pass through
 * here, because source markup is entity-encoded: Bing writes result dates
 * as `Aug 19, 2026&nbsp;&#0183;&#32;DeepSeek`, and a page's prose carries
 * `&rsquo;` / `&mdash;`. Nothing downstream can rescue a literal `&nbsp;`
 * — the Markdown renderer shows the six characters verbatim, a search
 * card shows them in a proportional font, and the model reads them as
 * content and reproduces them in its answer.
 *
 * `stripTags` (here and in `engines/types.ts`) and `decodeEntities` are
 * therefore one step, not two: anything that pulls text OUT of markup
 * decodes it in the same breath.
 *
 * Deliberately NOT a full HTML5 table (2231 named references): the long
 * tail is almost entirely math/emoji/stroke codepoints that never appear
 * in result markup, and none of the ~130 below needs anything but the
 * Basic Multilingual Plane. Unknown references are left untouched rather
 * than blanked — `&notreal;` staying visible is a better failure than it
 * vanishing, and it keeps this function idempotent-in-spirit for text
 * that was never markup.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  // whitespace — every one decodes to a PLAIN space below, so `**&nbsp;a**`
  // renders as bold instead of silently collapsing inside the emphasis
  // markers. The zero-width ones vanish because a model reasoning about a
  // word or a URL must not inherit an invisible character.
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '', zwj: '', shy: '',
  // markup-significant
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  // quotes, dashes, ellipsis
  lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a',
  ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e',
  laquo: '\u00ab', raquo: '\u00bb', lsaquo: '\u2039', rsaquo: '\u203a',
  ndash: '\u2013', mdash: '\u2014', horbar: '\u2015', minus: '\u2212', brvbar: '\u00a6',
  hellip: '\u2026', mldr: '\u2026',
  // marks, symbols, punctuation
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', sect: '\u00a7', para: '\u00b6',
  dagger: '\u2020', ddagger: '\u2021', permil: '\u2030', prime: '\u2032', primeprime: '\u2033',
  times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', not: '\u00ac',
  deg: '\u00b0', micro: '\u00b5', sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3',
  frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  bull: '\u2022', middot: '\u00b7', cdot: '\u22c5',
  // latin-1 accented letters (names/places in fetched prose)
  eacute: '\u00e9', egrave: '\u00e8', agrave: '\u00e0', ccedil: '\u00e7',
  uuml: '\u00fc', ouml: '\u00f6', auml: '\u00e4', szlig: '\u00df', ntilde: '\u00f1',
  // arrows
  larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194',
  lArr: '\u21d0', rArr: '\u21d2', hArr: '\u21d4',
  // math
  le: '\u2264', ge: '\u2265', ne: '\u2260', asymp: '\u2248', equiv: '\u2261',
  infin: '\u221e', sum: '\u2211', prod: '\u220f', radic: '\u221a', part: '\u2202',
  int: '\u222b', nabla: '\u2207', isin: '\u2208', notin: '\u2209', empty: '\u2205',
  forall: '\u2200', exist: '\u2203', lowast: '\u2217',
  // currency
  cent: '\u00a2', pound: '\u00a3', curren: '\u00a4', yen: '\u00a5', euro: '\u20ac',
  // ascii names (rare in the wild, cheap to cover)
  num: '#', dollar: '$', percnt: '%', ast: '*', comma: ',', period: '.',
  colon: ':', semi: ';', quest: '?', excl: '!', sol: '/', bsol: '\\',
  lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lcub: '{', rcub: '}',
  // card suits and marks
  oplus: '\u2295', otimes: '\u2297', perp: '\u22a5', sim: '\u223c', cong: '\u2245',
  lceil: '\u2308', rceil: '\u2309', lfloor: '\u230a', rfloor: '\u230b',
  loz: '\u25ca', spades: '\u2660', clubs: '\u2663', hearts: '\u2665', diams: '\u2666',
  check: '\u2713', cross: '\u2717',
}

const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]{1,31});/gi

function codePointToString(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return ''
  // Surrogate halves and the noncharacters U+FFFE/U+FFFF are not valid
  // scalar values; emit nothing rather than a lone surrogate.
  if (cp >= 0xd800 && cp <= 0xdfff) return ''
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

/**
 * Decode HTML character references in a text string: `&nbsp;` → space,
 * `&#0183;` → `·`, `&#x27;` → `'`, `&amp;` → `&`.
 *
 * Order matters. One left-to-right pass resolves each reference exactly
 * once against the ORIGINAL text, so `&amp;lt;` correctly yields `&lt;`
 * instead of being decoded twice into `<` (a double-decode is how entity
 * handling turns escaped markup into injection). Anything the table does
 * not know is left alone.
 *
 * Name lookup lowercases first, so `&NBSP;` and `&NBSP` style caps from a
 * minifier decode too; the two-case pairs where that merges a distinct
 * codepoint (`&Dagger;`, `&Prime;`) are not worth the extra table.
 */
export function decodeEntities(s: string): string {
  const text = String(s)
  // The `&` guard is on the REFERENCE pass only. The whitespace pass must
  // still run for text that carries no reference at all: a page can put a
  // raw U+00A0 between two words, and an early `return text` here is what
  // let that character reach the model untouched.
  const decoded = text.includes('&')
    ? text.replace(ENTITY_RE, (match, body: string) => {
        if (body.charCodeAt(0) === 35 /* # */) {
          const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88 /* xX */
          const digits = hex ? body.slice(2) : body.slice(1)
          return codePointToString(parseInt(digits, hex ? 16 : 10))
        }
        const hit = NAMED_ENTITIES[body.toLowerCase()]
        return hit === undefined ? match : hit
      })
    : text
  return decoded
    // A page's OWN U+00A0 / U+2000-family padding: read it as ordinary
    // space rather than as a character the model has to reason about.
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    // Zero-width characters are not whitespace to `\s`, so they survive a
    // collapse and end up inside a word, a URL or a keyword. Drop them:
    // a soft hyphen between "un" and "broken" is a hyphenation hint, not
    // content. U+200E/U+200F are deliberately NOT dropped — those encode
    // bidi intent for Arabic/Hebrew text and removing them flips reading
    // order in the rendered card.
    .replace(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g, '')
}

/**
 * Decode a text string that was pulled out of markup: `stripTags` in the
 * same breath, then whitespace-normalize. The search engines and the
 * visible-text extractor both go through here so a snippet can never
 * carry a raw `&nbsp;` / `&#x27;` to the model or to a card.
 */
export function cleanHtmlText(html: string): string {
  return normalizeWhitespace(decodeEntities(stripTags(html)))
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
    const text = cleanHtmlText(m[2] ?? '')
    if (!text) continue
    out.push({ text, url: resolved })
  }
  return out
}

/**
 * Pull the page's visible text: strip script/style/svgs/iframes/forms/nav,
 * decode character references, then collapse whitespace. Returns the
 * document title when one is present.
 *
 * Newlines are inserted BEFORE the decode but the decode itself is safe
 * here: `&nbsp;` collapses to a space, and a decoded `&#10;` is
 * re-collapsed by the `\n{3,}` pass below.
 */
export function extractVisibleTextFromHtml(html: string): { title: string | null; text: string } {
  let s = String(html)
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  // `<head>` is dropped BEFORE the visible-text pass, so the title has to
  // be read first — reading it after is why this function returned a null
  // title for every page that had one.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)
  const titleText = title ? cleanHtmlText(title[1] ?? '') || null : null
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '')
  s = s.replace(
    /<(script|style|noscript|template|svg|iframe|form|nav|footer|header|aside|dialog)[\s\S]*?<\/\1>/gi,
    '',
  )
  // Block-level closers insert real newlines so list items and headings stay
  // readable, mirroring what a browser would render as separate paragraphs.
  s = s.replace(
    /<\/(p|div|section|article|main|li|tr|ul|ol|dl|dt|dd|figure|figcaption|summary|address|table|tbody|thead|tfoot|h[1-6]|blockquote|pre|br)>/gi,
    '\n',
  )
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = decodeEntities(stripTags(s))
  s = s.replace(/[ \t]+\n/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return { title: titleText, text: s.trim() }
}
