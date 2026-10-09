/**
 * dsh-network web_fetch formatting layer.
 *
 * Sits on top of the raw transport in `client.ts`: it calls
 * `runClientFetch` to get the raw body, then decides how to present it.
 *
 *   - `format: 'markdown'` (default) — HTML → Markdown via `html.ts`,
 *     so the model gets readable, linked, code-fenced text. An RSS / Atom
 *     / RDF body is claimed first by `feed.ts`, which renders per-item
 *     Markdown with labelled metadata and a bounded body.
 *   - `format: 'raw'` — the raw body verbatim (raw HTML for HTML pages,
 *     raw XML for a feed, raw text otherwise). No conversion, no extraction.
 *   - Document content types (PDF / DOCX / PPTX / XLSX / ODT / ODP / ODS /
 *     EPUB) — the transport returns raw bytes via `bodyBuffer` and this
 *     layer pipes them through `officeparser` for a Markdown view.
 *     `format` is ignored for documents; `officeparser` always emits
 *     Markdown. The HTML → Markdown path stays untouched (real-world web
 *     pages need the nav/footer pre-filter that officeparser's HTML input
 *     format does not provide).
 *
 * It also extracts the outgoing links and the page title from the raw
 * markup — bookkeeping the transport layer deliberately does not own.
 *
 * The search engines do NOT go through this layer: they call
 * `runClientFetch` directly (see `cli.ts`) because they need the raw
 * HTML to run their own parsers.
 */
import type { FetchOptions } from './client.ts'
import { runClientFetch } from './client.ts'
import { htmlToMarkdown } from './html.ts'
import { extractLinks, extractVisibleTextFromHtml, normalizeWhitespace } from './html-extract.ts'
import { parseDocument } from './document.ts'
import { renderFeed } from './feed.ts'

export interface FetchPageOptions {
  url: string
  /** 'markdown' (default) or 'raw'. Document responses ignore this. */
  format?: 'markdown' | 'raw'
  timeoutMs?: number
  maxBytes?: number
  maxChars?: number
  maxRedirects?: number
  userAgent?: string
  allowlist?: readonly string[]
  allowPrivateNetwork?: boolean
  /** Only same-domain redirect hops are followed (on by default). */
  redirectProtection?: boolean
  /** Redirect hops may not switch between http and https (on by default). */
  protocolLock?: boolean
  headers?: Record<string, string>
  /**
   * Whole-feed render budget for a feed body; `null` renders every item and
   * leaves the tail to the result cache. `undefined` takes the renderer's
   * own default (`null`). Ignored for non-feed bodies.
   */
  feedBudget?: number | null
}

export interface FetchPageResult {
  url: string
  finalUrl: string
  statusCode: number
  statusText: string
  contentType: string
  /** The formatted body: Markdown (default) or the raw body verbatim. */
  content: string
  /** Outgoing links extracted from the raw markup (HTML pages only). */
  links: Array<{ text: string; url: string }>
  title: string | null
  /** True when the raw body was truncated at `maxChars` / `maxBytes`. */
  truncated: boolean
  /** The redirect chain followed, oldest first. */
  redirectChain: string[]
  engine: string
  /**
   * Where an inline preview of an oversized feed should be cut — the end of
   * the last complete item block. Null for everything but a feed that
   * overflows the preview cap. See {@link FeedRender.previewCutAt}.
   */
  previewCutAt: number | null
  /**
   * Non-fatal issues surfaced by the formatting layer (e.g. officeparser
   * warnings about a malformed PDF part). Empty for HTML / text responses.
   */
  warnings: string[]
}

/**
 * Fetch one URL and format the result for web_fetch consumption.
 * Transport concerns stay in `client.ts`; this layer only decides how
 * the raw body is presented (markdown vs raw) and extracts metadata.
 */
export async function fetchPage(options: FetchPageOptions): Promise<FetchPageResult> {
  const format = options.format === 'raw' ? 'raw' : 'markdown'
  const clientOptions: FetchOptions = {
    url: options.url,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    maxChars: options.maxChars,
    maxRedirects: options.maxRedirects,
    userAgent: options.userAgent,
    allowlist: options.allowlist,
    allowPrivateNetwork: options.allowPrivateNetwork,
    redirectProtection: options.redirectProtection,
    protocolLock: options.protocolLock,
    headers: options.headers,
  }
  const raw = await runClientFetch(clientOptions)

  let content: string
  let title: string | null = null
  let links: Array<{ text: string; url: string }> = []
  let warnings: string[] = []
  let previewCutAt: number | null = null

  if (raw.isDocument && raw.bodyBuffer) {
    // PDF / DOCX / PPTX / XLSX / ODT / ODP / ODS / EPUB — officeparser
    // parses the bytes and emits Markdown. `format` is irrelevant here.
    const parsed = await parseDocument(raw.bodyBuffer, raw.contentType)
    content = parsed.content
    title = parsed.title
    // Document body has no "outgoing links" in the HTML sense.
    links = []
    warnings = parsed.warnings
  } else if (format === 'markdown') {
    // A feed is claimed BEFORE the markup branch: the transport flags any
    // `*xml` body as markup, and `htmlToMarkdown` knows nothing about
    // `<item>`, so channel metadata and every item body would come back as
    // one unlabeled wall. `renderFeed` returns null for any root element
    // that is not a feed (a sitemap, an OPML export, a JS app shell), so
    // the branch is a no-op for everything else.
    const feed = renderFeed(raw.body, { baseUrl: raw.finalUrl, maxTotalChars: options.feedBudget })
    if (feed) {
      content = feed.markdown
      title = feed.title
      // An oversized feed is NOT cut here — the whole render goes to the
      // caller, and the result cache degrades it to a preview at an item
      // boundary plus a `cacheId`.
      previewCutAt = feed.previewCutAt
      // Links stay empty: the rendered body already carries every item
      // URL, and `dsh/evidence.js` prints `links` into the answer text —
      // filling it would duplicate each one into the model's context.
      links = []
    } else if (raw.isHtml) {
      content = htmlToMarkdown(raw.body)
      title = extractTitle(raw.body)
      links = extractLinks(raw.body, raw.finalUrl)
    } else {
      // Non-HTML (JSON, plain text, …): there is no markup to convert.
      content = normalizeWhitespace(raw.body)
    }
  } else if (raw.isHtml) {
    // format: 'raw' — hand the body back verbatim, markup intact.
    content = raw.body
    title = extractTitle(raw.body)
    links = extractLinks(raw.body, raw.finalUrl)
  } else {
    content = raw.body
  }

  return {
    url: options.url,
    finalUrl: raw.finalUrl,
    statusCode: raw.status,
    statusText: raw.statusText,
    contentType: raw.contentType,
    content,
    links,
    title,
    truncated: raw.meta.truncated,
    redirectChain: raw.meta.redirectChain,
    engine: raw.meta.engine,
    previewCutAt,
    warnings,
  }
}

/**
 * Pull the document title from raw HTML. Null when absent. This is a
 * tiny dedicated extractor — `extractVisibleTextFromHtml` also computes
 * the title, but it pays for a full visible-text pass this layer does
 * not need.
 */
export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html))
  if (!m || !m[1]) return null
  const text = normalizeWhitespace(m[1].replace(/<[^>]*>/g, ''))
  return text || null
}

// Re-export the visible-text helper for callers that need a plain-text
// fallback view (e.g. the block renderer when no rich renderer exists).
export { extractVisibleTextFromHtml, normalizeWhitespace }
