/**
 * RSS 2.0 / RSS 1.0 (RDF) / Atom 1.0 → Markdown, for `web_fetch`.
 *
 * Why this exists: 没这个模块获取 RSS 时就会解析出一条？！惊天大区！？
 * 
 * `isTextLikeContentType` lets any `*xml` body through and the transport
 * flags it as markup, so a feed needs its own renderer: `htmlToMarkdown`
 * knows nothing about `<item>` and would return the channel metadata and
 * every item body as one undifferentiated run.
 *
 * Hand-written, no XML dependency, and the scanner must stay tolerant: a
 * feed is a FIXED tag vocabulary, not a general document tree, and the
 * payloads are hostile by nature — unescaped `&` in descriptions, unclosed
 * `<link>`, `dc:` / `content:` / `itunes:` namespaces, HTML entities inside
 * CDATA, DOCTYPEs with internal subsets. For a model-facing fetch "the one
 * feed I asked for came back empty" is a far worse outcome than "two fields
 * were missing", so the scanner degrades instead of throwing.
 *
 * Entity discipline (one decode, the `html-extract.ts` rule): a CDATA
 * payload is LITERAL — its `&amp;` really is those five characters — so it
 * is handed to `htmlToMarkdown` raw and decoded exactly once, at the end,
 * by the same table every other text extraction uses. Character data is
 * XML entity-decoded first and then converted, so a `&lt;p&gt;` escaped
 * description becomes a paragraph instead of literal angle brackets. Never
 * both, never a second pass.
 *
 * No DTD processing of any kind: `<!DOCTYPE …>` (including an internal
 * subset with `<!ENTITY>` declarations) is skipped, so there is no entity
 * expansion to abuse and no external reference to resolve.
 */
import { decodeEntities, normalizeWhitespace } from './html-extract.ts'
import { htmlToMarkdown } from './html.ts'

export type FeedKind = 'rss' | 'rdf' | 'atom'

/**
 * Hard stop on how many items one render walks. This is a WORK ceiling, not
 * a presentation one: server mode renders every item it parsed and lets the
 * result cache carry the tail, so this only fires on a feed pathological
 * enough to be a denial-of-service rather than a subscription.
 */
export const RENDER_MAX_ITEMS = 500
/** Characters of one item's rendered body before it is clipped. */
export const DEFAULT_MAX_ITEM_CHARS = 8000
/**
 * Inline budget for a WHOLE rendered feed, headers included — used ONLY when
 * there is no result cache to carry the tail (the single-shot CLI, where the
 * body has to fit through a child-process stdout pipe).
 *
 * Server mode passes `null` instead: the whole render goes to the result
 * cache and the model pages it by `cacheId` + offset, which never touches
 * the network.
 */
export const DEFAULT_MAX_TOTAL_CHARS = 20_000
/**
 * Where an inline preview of an oversized feed should end: the end of the
 * last COMPLETE item block under this many characters. Matches the server's
 * inline cap, so the preview is a whole number of items rather than a slice
 * that stops mid-entry.
 */
export const FEED_PREVIEW_CHARS = 20_000

/** Tag nesting the scanner descends into; malformed markup cannot blow the stack. */
const MAX_DEPTH = 128
/** `<category>` is context, not content: a few is plenty. */
const MAX_CATEGORIES = 6
/** The only roots this module claims. `<urlset>` / `<opml>` are not feeds. */
const ROOT_NAMES = new Set(['rss', 'feed', 'rdf'])

export interface FeedItem {
  title: string | null
  link: string | null
  id: string | null
  /** Source string, normalized to ISO only when it parses to a plausible year. */
  date: string | null
  author: string | null
  /** Rendered Markdown (HTML bodies) or tidied plain text, already clipped. */
  body: string | null
  categories: string[]
}

export interface FeedRender {
  kind: FeedKind
  title: string | null
  link: string | null
  /** `rel="self"` — the URL to subscribe to. Null for feeds that omit it. */
  self: string | null
  description: string | null
  updated: string | null
  items: FeedItem[]
  /** Items present in the document, including the ones not rendered. */
  totalItems: number
  itemsClipped: boolean
  markdown: string
  /**
   * Character offset into {@link markdown} at which an INLINE preview should
   * end — the end of the last complete item block that fits
   * {@link FeedRenderOptions.previewCap}. `null` when the whole render fits
   * (no preview needed) or when not even the first item does (the caller
   * should fall back to a hard cut). Keeping the cut on an item boundary is
   * what lets a model read the preview, decide it wants entry 40, and page
   * straight to it with one `cacheId` call.
   */
  previewCutAt: number | null
}

export interface FeedRenderOptions {
  /** Default {@link RENDER_MAX_ITEMS}. */
  maxItems?: number
  /** Default {@link DEFAULT_MAX_ITEM_CHARS}. */
  maxItemChars?: number
  /**
   * Default `null` — render every item and let the caller decide how much of
   * it to inline. Pass a number to stop the walk at that many characters
   * instead (the single-shot CLI, where the cache cannot carry the tail).
   * The first item is always rendered even when it alone exceeds the budget —
   * an empty view of a feed is worse than a clipped one.
   */
  maxTotalChars?: number | null
  /** Default {@link FEED_PREVIEW_CHARS}; only feeds {@link FeedRender.previewCutAt}. */
  previewCap?: number
  /** Resolves relative item / channel links against this URL. */
  baseUrl?: string
}

// ---------------------------------------------------------------------------
// Minimal tolerant XML scanner
// ---------------------------------------------------------------------------

/**
 * One piece of an element's content, IN DOCUMENT ORDER.
 *
 * Order is the whole reason this is a list and not a `text` field plus a
 * `children` array: Atom's `type="xhtml"` bodies and ordinary feed HTML
 * are mixed content (`<p>rich <em>x</em> body</p>`), and any model that
 * concatenates the text first and the children after reorders the prose.
 */
type Content =
  | { kind: 'text' | 'cdata'; value: string }
  | { kind: 'node'; node: FeedNode }

interface FeedNode {
  /** Local name, lowercased. */
  name: string
  /** Namespace prefix as written, lowercased; `''` when unprefixed. */
  prefix: string
  /** Attribute values are entity-decoded once, at parse time. */
  attrs: Record<string, string>
  content: Content[]
}

function emptyNode(name: string, prefix: string, attrs: Record<string, string>): FeedNode {
  return { name, prefix, attrs, content: [] }
}

/** Scan an XML document into a node tree. Never throws; never recurses. */
function parseXml(src: string): FeedNode {
  const doc = emptyNode('#document', '', {})
  const stack: FeedNode[] = [doc]
  const top = () => stack[stack.length - 1]!
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      top().content.push({ kind: 'text', value: src.slice(i) })
      break
    }
    if (lt > i) top().content.push({ kind: 'text', value: src.slice(i, lt) })
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      top().content.push({ kind: 'cdata', value: src.slice(lt + 9, end < 0 ? src.length : end) })
      i = end < 0 ? src.length : end + 3
      continue
    }
    // Comments, processing instructions and declarations (a DOCTYPE with an
    // internal subset included) are dropped, never expanded.
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    if (src.startsWith('<!', lt)) {
      i = skipDeclaration(src, lt)
      continue
    }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt)
      if (end < 0) break
      const close = splitQName(src.slice(lt + 2, end).trim())
      // Pop to the matching open tag; an unmatched close is ignored rather
      // than unwinding the whole stack. The qualified name is split the same
      // way the open tag was — comparing a close tag's `dc:date` against a
      // node whose `name` is `date` never matches, and every namespaced
      // element would swallow the rest of its document.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === close.name && stack[k]!.prefix === close.prefix) {
          stack.length = k
          break
        }
      }
      i = end + 1
      continue
    }
    const end = findTagEnd(src, lt)
    if (end < 0) break
    const raw = src.slice(lt + 1, end).trimEnd()
    const selfClosing = raw.endsWith('/')
    const node = parseTag(selfClosing ? raw.slice(0, -1) : raw)
    top().content.push({ kind: 'node', node })
    if (!selfClosing && stack.length < MAX_DEPTH) stack.push(node)
    i = end + 1
  }
  return doc
}

/** `>` inside a quoted attribute value does not end the tag. */
function findTagEnd(src: string, from: number): number {
  let quote = ''
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i]!
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '>') return i
  }
  return -1
}

/** Skip `<!DOCTYPE …>` / `<!ENTITY …>`, honouring a `[ … ]` internal subset. */
function skipDeclaration(src: string, from: number): number {
  let depth = 0
  for (let i = from + 2; i < src.length; i++) {
    const c = src[i]!
    if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === '>' && depth <= 0) return i + 1
  }
  return src.length
}

function splitQName(qname: string): { prefix: string; name: string } {
  const lower = String(qname).toLowerCase()
  const colon = lower.indexOf(':')
  return colon > 0
    ? { prefix: lower.slice(0, colon), name: lower.slice(colon + 1) }
    : { prefix: '', name: lower }
}

function parseTag(raw: string): FeedNode {
  const qname = /^([^\s/>]+)/.exec(raw)?.[1] ?? ''
  const { prefix, name } = splitQName(qname)
  const node = emptyNode(name, prefix, {})
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  const rest = raw.slice(qname.length)
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(rest))) {
    // Decoded here and nowhere else, so the value is safe to print straight
    // into Markdown (an `&` in a URL is a `&`, not `&amp;`).
    node.attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return node
}

function childNodes(node: FeedNode): FeedNode[] {
  const out: FeedNode[] = []
  for (const part of node.content) {
    if (part.kind === 'node') out.push(part.node)
  }
  return out
}

function findChild(node: FeedNode, name: string, prefix = ''): FeedNode | null {
  for (const part of node.content) {
    if (part.kind === 'node' && part.node.name === name && part.node.prefix === prefix) return part.node
  }
  return null
}

function findChildren(node: FeedNode, name: string, prefix?: string): FeedNode[] {
  const out: FeedNode[] = []
  const walk = (n: FeedNode) => {
    for (const part of n.content) {
      if (part.kind !== 'node') continue
      const child = part.node
      if (child.name === name && (prefix === undefined || child.prefix === prefix)) out.push(child)
      // Recursive on purpose: a feed that forgets to close `<link>` nests
      // every following item inside the previous one, and the items must
      // still be found.
      walk(child)
    }
  }
  walk(node)
  return out
}

/**
 * An attribute by local name, so `rdf:resource` is reachable as
 * `resource` — parse keys are lowercased WITH their prefix intact.
 */
function attrValue(node: FeedNode, name: string): string | undefined {
  const direct = node.attrs[name]
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(node.attrs)) {
    if (key.endsWith(`:${name}`)) return value
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

/** CDATA is literal; character data is entity-decoded. Exactly one decode. */
function rawValue(node: FeedNode): { value: string; literal: boolean } {
  let cdata = ''
  let text = ''
  for (const part of node.content) {
    if (part.kind === 'cdata') cdata += part.value
    else if (part.kind === 'text') text += part.value
  }
  return cdata ? { value: cdata, literal: true } : { value: text, literal: false }
}

/** Single-line plain text (title, date, author, guid, link). */
function fieldText(node: FeedNode | null | undefined): string | null {
  if (!node) return null
  if (node.content.some((part) => part.kind === 'node')) {
    // `type="xhtml"` titles and inline-markup titles: render, don't strip.
    return htmlToMarkdown(serializeChildren(node)) || null
  }
  const { value, literal } = rawValue(node)
  const text = normalizeWhitespace(literal ? value : decodeEntities(value))
  return text || null
}

/**
 * An HTML body as Markdown. Raw CDATA, decoded character data; a
 * `type="text"` body keeps its own line structure.
 */
function fieldHtml(node: FeedNode | null | undefined, type?: string): string {
  if (!node) return ''
  const declared = (type ?? node.attrs['type'] ?? 'html').toLowerCase()
  const { value, literal } = rawValue(node)
  const source = literal ? value : decodeEntities(value)
  if (declared === 'text') return tidyPlainText(source)
  if (node.content.some((part) => part.kind === 'node')) return htmlToMarkdown(serializeChildren(node))
  return htmlToMarkdown(source)
}

/** `type="text"` bodies keep their line structure; only tidy them. */
function tidyPlainText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function serializeNode(node: FeedNode): string {
  const name = node.prefix ? `${node.prefix}:${node.name}` : node.name
  let attrs = ''
  for (const [key, value] of Object.entries(node.attrs)) {
    attrs += ` ${key}="${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}"`
  }
  const inner = serializeChildren(node)
  return inner ? `<${name}${attrs}>${inner}</${name}>` : `<${name}${attrs} />`
}

function serializeChildren(node: FeedNode): string {
  let out = ''
  for (const part of node.content) {
    out += part.kind === 'node' ? serializeNode(part.node) : part.value
  }
  return out
}

function resolveUrl(href: string, base?: string): string {
  const h = String(href || '').trim()
  if (!h) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return h
  if (!base) return h
  try {
    return new URL(h, base).toString()
  } catch {
    return h
  }
}

/**
 * RFC 822 / ISO 8601 → `YYYY-MM-DD`.
 *
 * Echoing `Thu, 08 Oct 2026 23:59:59 GMT` is honest but expensive to read,
 * and item order is something the model compares. A value is reformatted
 * only when it parses AND lands in [1990, next year], because a date that
 * is wrong in the evidence is worse than no date. Anything else passes
 * through verbatim rather than being guessed at.
 */
export function normalizeFeedDate(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return text
  const year = new Date(ms).getUTCFullYear()
  if (year < 1990 || year > new Date().getUTCFullYear() + 1) return text
  return new Date(ms).toISOString().slice(0, 10)
}

interface FieldRef {
  prefix: string
  name: string
}

function firstField(node: FeedNode, refs: FieldRef[]): FeedNode | null {
  for (const ref of refs) {
    const hit = findChild(node, ref.name, ref.prefix)
    if (hit) return hit
  }
  return null
}

const TITLE_REFS: FieldRef[] = [{ prefix: '', name: 'title' }]
const ITEM_DATE_REFS: FieldRef[] = [
  { prefix: '', name: 'pubdate' },
  { prefix: '', name: 'published' },
  { prefix: '', name: 'updated' },
  { prefix: 'dc', name: 'date' },
]
const FEED_UPDATED_REFS: FieldRef[] = [
  { prefix: '', name: 'lastbuilddate' },
  { prefix: '', name: 'updated' },
  { prefix: '', name: 'pubdate' },
  { prefix: 'dc', name: 'date' },
]
const AUTHOR_REFS: FieldRef[] = [
  { prefix: '', name: 'author' },
  { prefix: 'dc', name: 'creator' },
  { prefix: 'itunes', name: 'author' },
]
/** `content:encoded` is the full RSS body; `description` is the summary. */
const BODY_REFS: FieldRef[] = [
  { prefix: 'content', name: 'encoded' },
  { prefix: '', name: 'content' },
  { prefix: '', name: 'description' },
  { prefix: '', name: 'summary' },
]

/**
 * Resolve the canonical link plus the feed's `rel="self"`.
 *
 * Three shapes share the tag name: RSS `<link>url</link>` (text), Atom
 * `<link rel="alternate" href="…"/>`, and RSS 1.0
 * `<link rdf:resource="…"/>`. A `rel="self"` link is the subscription URL,
 * not a page — handing it back as the item's link would point the model at
 * the feed it just read.
 *
 * Direct children ONLY: a channel that omits its own `<link>` has no home
 * page, and falling back to a nested match would hand back the first
 * ITEM's link as the channel's.
 */
function pickLink(node: FeedNode, base?: string): { link: string | null; self: string | null } {
  let link: string | null = null
  let self: string | null = null
  for (const child of childNodes(node)) {
    if (child.name !== 'link') continue
    const href = attrValue(child, 'href') ?? attrValue(child, 'resource') ?? fieldText(child) ?? ''
    const url = resolveUrl(href, base)
    if (!url) continue
    const rel = (attrValue(child, 'rel') ?? '').trim().toLowerCase()
    if (attrValue(child, 'href') === undefined && attrValue(child, 'resource') === undefined) {
      // RSS text link — the channel's home page / the item's permalink.
      if (!link) link = url
      continue
    }
    if (rel === 'self') {
      if (!self) self = url
      continue
    }
    if ((rel === '' || rel === 'alternate') && !link) link = url
  }
  return { link, self }
}

function pickAuthor(item: FeedNode): string | null {
  const node = firstField(item, AUTHOR_REFS)
  if (!node) return null
  return fieldText(findChild(node, 'name') ?? node)
}

function pickCategories(item: FeedNode): string[] {
  const out: string[] = []
  for (const child of findChildren(item, 'category')) {
    const value = fieldText(child) ?? child.attrs['term'] ?? null
    if (value && !out.includes(value)) out.push(value)
    if (out.length >= MAX_CATEGORIES) break
  }
  return out
}

function pickGuid(item: FeedNode): string | null {
  const guid = findChild(item, 'guid')
  if (guid) {
    const permalink = (guid.attrs['ispermalink'] ?? 'true').toLowerCase() !== 'false'
    const text = fieldText(guid)
    return text && permalink ? resolveUrl(text) : text
  }
  return fieldText(findChild(item, 'id'))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Identify a feed by its ROOT ELEMENT, not by content type: feeds are
 * routinely served as `text/html` or plain `application/xml` by broken
 * CDNs, and a strict mime check drops exactly those. The match is anchored
 * to the first element after the prolog, so a `sitemap.xml` (`<urlset>`),
 * an OPML export (`<outline>`) or a page that merely mentions `<feed>`
 * never matches and falls through to `htmlToMarkdown` unchanged.
 */
export function sniffFeedKind(body: string): FeedKind | null {
  const head = stripProlog(String(body).slice(0, 4096)).trimStart()
  if (/^<rss[\s/>]/i.test(head)) return 'rss'
  if (/^<feed[\s/>]/i.test(head)) return 'atom'
  if (/^<(?:[\w.-]+:)?rdf[\s/>]/i.test(head)) return 'rdf'
  return null
}

function stripProlog(s: string): string {
  return s
    .replace(/^﻿/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?\s*>/gi, '')
}

/**
 * Clip a rendered body, preferring a block boundary near the budget so the
 * model never receives half a sentence. Falls back to a hard cut only when
 * the budget lands inside a very long unbroken block.
 */
function clipBody(markdown: string, maxChars: number): { text: string; total: number | null } {
  if (markdown.length <= maxChars) return { text: markdown, total: null }
  const slice = markdown.slice(0, maxChars)
  // Paragraph break, then a sub-heading, then a bare line break. Tightly
  // packed markup (`</p><p>` with no whitespace between) yields single
  // newlines only, and clipping on one of those still beats a mid-sentence
  // cut. The 40% floor keeps a newline that sits right at the budget from
  // throwing away most of the allowance.
  const cut = Math.max(
    slice.lastIndexOf('\n\n'),
    slice.lastIndexOf('\n### '),
    slice.lastIndexOf('\n## '),
    slice.lastIndexOf('\n'),
  )
  const at = cut > maxChars * 0.4 ? cut + 1 : maxChars
  return { text: markdown.slice(0, at).trimEnd(), total: markdown.length }
}

/** One `## N. title` block, with its metadata line and any clip marker. */
function renderItemBlock(item: FeedItem, index: number, maxItemChars: number, fullBody: number | null): string {
  const meta: string[] = []
  if (item.date) meta.push(item.date)
  if (item.author) meta.push(item.author)
  if (item.link) meta.push(`<${item.link}>`)
  const parts = [`## ${index}. ${item.title ?? item.link ?? `item ${index}`}`]
  if (meta.length > 0) parts.push(meta.join(' · '))
  if (item.categories.length > 0) parts.push(item.categories.join(', '))
  if (item.body) {
    parts.push(item.body)
    if (fullBody !== null) {
      parts.push(`_… body clipped at ${maxItemChars} of ${fullBody} characters._`)
    }
  }
  return parts.join('\n\n')
}

/**
 * Render a feed to Markdown, or return `null` when the body is not a feed
 * so the caller falls through to its normal path. That `null` is the
 * contract: this module never fails a fetch, it only claims bodies whose
 * root element says it is a feed.
 */
export function renderFeed(body: string, options: FeedRenderOptions = {}): FeedRender | null {
  const kind = sniffFeedKind(body)
  if (!kind) return null

  const maxItems = Math.max(1, Math.floor(options.maxItems ?? RENDER_MAX_ITEMS))
  const maxItemChars = Math.max(200, Math.floor(options.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS))
  const totalBudget = options.maxTotalChars === undefined ? null : options.maxTotalChars
  const maxTotalChars = totalBudget === null ? null : Math.max(1000, Math.floor(totalBudget))
  const previewCap = Math.max(1000, Math.floor(options.previewCap ?? FEED_PREVIEW_CHARS))
  const base = options.baseUrl

  const doc = parseXml(String(body))
  let root: FeedNode | null = null
  for (const part of doc.content) {
    if (part.kind === 'node' && ROOT_NAMES.has(part.node.name)) {
      root = part.node
      break
    }
  }
  if (!root) return null

  // RSS 2.0 nests the metadata in <channel>; Atom puts it on the root
  // itself; RSS 1.0 has a <channel> whose <item>s are SIBLINGS of it.
  const channel = kind === 'atom' ? root : (findChild(root, 'channel') ?? root)
  const itemScope = kind === 'rdf' ? root : channel
  const entries = kind === 'atom' ? findChildren(itemScope, 'entry') : findChildren(itemScope, 'item')

  const channelLinks = pickLink(channel, base)
  const title = fieldText(firstField(channel, TITLE_REFS))
  const description = fieldHtml(findChild(channel, 'description') ?? findChild(channel, 'subtitle'))
  const updated = normalizeFeedDate(fieldText(firstField(channel, FEED_UPDATED_REFS)))

  // Header first, so its characters count against the total budget.
  const blocks: string[] = [`# ${title ?? 'Untitled feed'}`]
  const head: string[] = []
  if (channelLinks.link) head.push(`Home: <${channelLinks.link}>`)
  if (channelLinks.self && channelLinks.self !== channelLinks.link) {
    head.push(`Feed: <${channelLinks.self}>`)
  }
  if (updated) head.push(`Updated: ${updated}`)
  if (head.length > 0) blocks.push(head.join('  \n'))
  if (description) blocks.push(description)
  let used = blocks.join('\n\n').length
  // End of the last COMPLETE item block that still fits the inline preview.
  // `used` is an exact prefix length of the final `join('\n\n')`, so this is
  // a real offset into `markdown` and survives the final `.trim()`.
  // Starts null on purpose: a preview that holds the channel header and NOT
  // ONE entry is worse than a hard cut, so a run whose first item already
  // blows the cap leaves the caller to cut plainly.
  let previewCutAt: number | null = null

  const items: FeedItem[] = []
  for (const entry of entries) {
    if (items.length >= maxItems) break
    const own = pickLink(entry, base)
    const guid = pickGuid(entry)
    const clipped = clipBody(fieldHtml(firstField(entry, BODY_REFS)), maxItemChars)
    const item: FeedItem = {
      title: fieldText(firstField(entry, TITLE_REFS)),
      link: own.link ?? resolveUrl(guid ?? ''),
      id: guid,
      date: normalizeFeedDate(fieldText(firstField(entry, ITEM_DATE_REFS))),
      author: pickAuthor(entry),
      body: clipped.text || null,
      categories: pickCategories(entry),
    }
    const block = renderItemBlock(item, items.length + 1, maxItemChars, clipped.total)
    // The first item is always rendered: an empty view of a feed is worse
    // than a clipped one. After that, an item that would blow the total
    // budget stops the walk — the tail is counted, not silently dropped.
    // `maxTotalChars === null` (server mode, where the cache holds the whole
    // render) never stops: the item count ceiling alone bounds the walk.
    if (maxTotalChars !== null && items.length > 0 && used + block.length > maxTotalChars) break
    used += 2 + block.length
    items.push(item)
    blocks.push(block)
    if (used <= previewCap) previewCutAt = used
  }

  if (entries.length > items.length) {
    const hidden = entries.length - items.length
    blocks.push(
      maxTotalChars === null
        ? `_… ${hidden} more of ${entries.length} items not rendered (walked ${items.length} at the ${maxItems}-item render ceiling)._`
        : `_… ${hidden} more of ${entries.length} items not shown (rendered ${items.length} of ${entries.length} within a ${maxTotalChars}-character budget). Re-fetch with format=raw for the source._`,
    )
  }

  const markdown = blocks.join('\n\n').trim()
  // Nothing to preview away when the whole render fits; and a `null` cut
  // (not even the header plus first item fits) means "hard-cut at the cap".
  const cut = markdown.length <= previewCap ? null : previewCutAt
  return {
    kind,
    title,
    link: channelLinks.link,
    self: channelLinks.self,
    description: description || null,
    updated,
    items,
    totalItems: entries.length,
    itemsClipped: entries.length > items.length,
    markdown,
    previewCutAt: cut !== null && cut > 0 ? cut : null,
  }
}
