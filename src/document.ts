/**
 * Document parsing for web_fetch: PDF / OOXML / ODF / EPUB → Markdown.
 *
 * The transport layer (`client.ts`) recognises a fixed allowlist of document
 * MIME types and hands them back as raw `Uint8Array` (UTF-8 decoding would
 * corrupt the bytes). This module maps the MIME back to officeparser's
 * `fileType` hint, runs the parse, and returns a uniform Markdown view
 * with metadata (title, warnings) that matches the existing web_fetch
 * contract so the tool schema and downstream UI never see a difference.
 *
 * OCR is intentionally NOT enabled here: it pulls in tesseract.js + the
 * 80 MB tesseract-core WASM, and a scanned-PDF workload is rare for an
 * LLM web_fetch call. When we need it, gate it behind a `--ocr` flag with
 * a dynamic import so the cold-start bundle stays lean.
 *
 * The html→md path in `html.ts` is unchanged: real-world web pages have
 * nav/footer/cookie banners and need a pre-filter that officeparser's HTML
 * input format does not provide. officeparser's value is for the binary
 * formats that ship structured content in a zip or PDF container — there
 * the "noise" problem does not exist.
 */

export type DocumentFileType =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'odt'
  | 'odp'
  | 'ods'
  | 'epub'

const DOCUMENT_MIME_TO_FILE_TYPE: Readonly<Record<string, DocumentFileType>> = {
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
}

/**
 * Map a Content-Type header value (the part before any `; charset=...`)
 * to the officeparser `fileType` hint. Returns `null` for non-document
 * content types so the caller can branch back to the text/HTML path.
 *
 * Pure function, easy to unit-test without touching the parser.
 */
export function inferFileType(contentType: string): DocumentFileType | null {
  const t = (contentType || '').split(';')[0]!.trim().toLowerCase()
  if (!t) return null
  return DOCUMENT_MIME_TO_FILE_TYPE[t] ?? null
}

export interface DocumentParseResult {
  /** Markdown body — the same shape web_fetch returns for HTML pages. */
  content: string
  /** Document title from `ast.metadata.title`, when present. */
  title: string | null
  /** Non-fatal issues from officeparser (malformed parts, OCR skips, …). */
  warnings: string[]
}

/**
 * Parse a document buffer to Markdown through officeparser. The input is
 * the raw bytes from the transport (no charset decoding). The output
 * shape matches the HTML branch of web_fetch so callers and schemas
 * don't have to special-case document responses.
 */
export async function parseDocument(
  bytes: Uint8Array,
  contentType: string,
): Promise<DocumentParseResult> {
  const fileType = inferFileType(contentType)
  if (!fileType) {
    throw new Error(`parseDocument: unsupported content-type "${contentType}"`)
  }
  // officeparser accepts Buffer / Uint8Array / ArrayBuffer / string path.
  // Pass Uint8Array verbatim — node Buffer is a subclass of Uint8Array
  // and works without conversion.
  // Dynamic import keeps tesseract.js out of the cold-start bundle.
  const { OfficeParser } = await import('officeparser')
  const ast = await OfficeParser.parseOffice(bytes, {
    fileType,
    // OCR is intentionally off; see the file header.
  })
  const conversion = await ast.to('md')
  const md = String(conversion.value ?? '')
  const warnings: string[] = []
  // Surface non-fatal officeparser issues as warnings rather than
  // silent "this PDF had a broken XRef table" footguns.
  const astWarnings = (ast as { warnings?: Array<{ message?: string; code?: string }> }).warnings
  if (Array.isArray(astWarnings)) {
    for (const w of astWarnings) {
      if (w && typeof w.message === 'string') warnings.push(w.message)
    }
  }
  if (Array.isArray(conversion.messages)) {
    for (const w of conversion.messages) {
      const message = (w as { message?: string })?.message
      if (typeof message === 'string') warnings.push(message)
    }
  }
  const titleRaw = (ast as { metadata?: { title?: unknown } }).metadata?.title
  const title = typeof titleRaw === 'string' && titleRaw.trim() !== '' ? titleRaw.trim() : null
  return { content: md, title, warnings }
}
