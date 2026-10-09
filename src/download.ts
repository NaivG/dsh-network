/**
 * dsh-network file download layer (web_download).
 *
 * The transport in `client.ts` refuses binary content on purpose: every
 * model-facing tool returns text, and a base64 blob would blow the ~20 KB
 * inline cap while telling the model nothing it can act on. That refusal
 * leaves a real hole though — the model's only remaining route to a file is
 * `pwsh` + curl/Invoke-WebRequest, which walks straight past the allowlist,
 * the private-IP rejection, the same-domain redirect lock and the TLS/UA pin
 * this plugin spends its whole architecture on. One injected page is enough
 * to aim that at `http://169.254.169.254/…` and drop the bytes in the
 * workspace.
 *
 * This module closes that hole by routing the bytes through the SAME
 * transport (`runClientFetch({ mode: 'bytes' })` → `assertSafeRemoteTarget` →
 * pinned dispatcher), and then doing the three things that turn a network
 * response into a trustworthy file on disk:
 *
 *   1. NAME — `Content-Disposition` (RFC 5987 `filename*` first), else the
 *      URL basename, else `download`; then sanitized down to something that
 *      is legal on Windows AND cannot escape the destination root.
 *   2. TYPE — the extension comes from the magic bytes, not from the URL or
 *      the `Content-Type`. `evil.example/x.png` serving an HTML anti-bot page
 *      must land as `x.html`, because saving it as a `.png` and handing it
 *      to `read_image` is a garbage-in path dressed up as a success.
 *   3. BOUNDS — an executable-extension denylist, a byte cap enforced
 *      before and during the transfer, and an atomic `.part` → rename so a
 *      half-written file is never observable.
 *
 * Deliberately NOT here:
 *   - The result cache. It stores strings keyed by `fetch|format|url`; a
 *     download's product is a file, and a warm hit would either rewrite it or
 *     hand back a stale one. `cli.ts` runs this path with no cache at all.
 *   - Any way for the model to name the destination root. `dest` picks
 *     between two fixed roots; the root itself arrives from the host's
 *     per-invoke env snapshot and is never model-influenced.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runClientFetch, type FetchOptions } from './client.ts'

/** Where a downloaded file lands. Both roots are plugin-owned, never model-supplied. */
export type DownloadDest = 'tmp' | 'workspace'

/** Subdirectory under the OS temp dir. */
export const TMP_SUBDIR = 'dsh-network'
/** Subdirectory under the workspace root — a file the user may keep. */
export const WORKSPACE_SUBDIR = 'downloads'

/**
 * Download byte cap. Deliberately far above the fetch/http body caps (7–8 MB
 * in `client.ts`): those exist to keep a *response preview* inside the
 * inline transport budget, while this one exists to keep the server child's
 * heap bounded. One byte over throws — it never truncates.
 */
export const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024

/** Longest base name we will write, extension excluded. */
const MAX_BASE_LEN = 120

/**
 * Extensions that a downloaded file must never carry into the workspace.
 *
 * A file on disk is an executable waiting for an interpreter: `.ps1` runs
 * under `pwsh -File`, `.js` under node, `.sh` under git-bash, `.bat`/`.cmd`
 * by double-click. Writing one is a capability this plugin has no business
 * granting to a web page, so this is a refusal rather than a warning.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'msi', 'msix', 'msp', 'msc', 'com', 'scr', 'cpl', 'dll', 'sys', 'drv', 'ocx',
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'jar', 'lnk', 'reg', 'sh', 'bash', 'zsh', 'py', 'pyc', 'pyo', 'pl', 'rb', 'php',
  'app', 'command', 'workflow', 'action', 'desktop', 'run',
])

/** `Content-Type` (media type, lowercased) → extension. Only the common set. */
const EXT_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-tar': 'tar',
  'application/x-bzip2': 'bz2',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/javascript': 'js',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/html': 'html',
  'application/wasm': 'wasm',
  'application/x-sqlite3': 'sqlite',
  'application/vnd.sqlite3': 'sqlite',
}

function startsWith(head: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (head.length < offset + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (head[offset + i] !== sig[i]) return false
  return true
}

function asciiAt(head: Uint8Array, offset: number, text: string): boolean {
  if (head.length < offset + text.length) return false
  for (let i = 0; i < text.length; i++) {
    if (head[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** Case-insensitive ASCII compare — markup detection has to survive `<!DOCTYPE HTML`. */
function asciiAtIgnoreCase(head: Uint8Array, offset: number, text: string): boolean {
  if (head.length < offset + text.length) return false
  for (let i = 0; i < text.length; i++) {
    const byte = head[offset + i]!
    const want = text.charCodeAt(i)
    const upper = byte >= 0x41 && byte <= 0x5a ? byte + 32 : byte
    if (upper !== (want >= 0x41 && want <= 0x5a ? want + 32 : want)) return false
  }
  return true
}

/**
 * Identify a payload from its first bytes.
 *
 * Hand-rolled on purpose: the set below is the format space that actually
 * reaches a workspace, it is ~30 lines, and a dependency here would be the
 * first non-essential one in the CLI bundle. Returns an extension WITHOUT a
 * leading dot, or `null` for an unrecognized payload — `null` is not a
 * failure, it just means the declared name/type has to carry the extension.
 */
export function sniffExtension(head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpg'
  if (asciiAt(head, 0, 'GIF8')) return 'gif'
  if (asciiAt(head, 0, 'RIFF')) {
    if (asciiAt(head, 8, 'WEBP')) return 'webp'
    if (asciiAt(head, 8, 'WAVE')) return 'wav'
    return 'riff'
  }
  if (asciiAt(head, 0, '%PDF')) return 'pdf'
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]) || startsWith(head, [0x50, 0x4b, 0x07, 0x08])) {
    // ZIP container — OOXML/EPUB/JAR all land here; the container extension is
    // the honest answer, and web_fetch's officeparser path is the right tool
    // for the inside.
    return 'zip'
  }
  if (asciiAt(head, 0, 'OggS')) return 'ogg'
  if (asciiAt(head, 0, 'fLaC')) return 'flac'
  if (asciiAt(head, 0, 'ID3')) return 'mp3'
  if (startsWith(head, [0xff, 0xfb]) || startsWith(head, [0xff, 0xf3]) || startsWith(head, [0xff, 0xf2])) return 'mp3'
  if (startsWith(head, [0x1f, 0x8b])) return 'gz'
  if (asciiAt(head, 0, 'BZh')) return 'bz2'
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z'
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar'
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'elf'
  if (startsWith(head, [0x4d, 0x5a])) return 'exe'
  if (startsWith(head, [0x00, 0x61, 0x73, 0x6d])) return 'wasm'
  if (asciiAt(head, 4, 'ftyp')) return 'mp4'
  if (startsWith(head, [0x00, 0x00, 0x01, 0x00])) return 'ico'
  if (asciiAt(head, 0, 'OTTO')) return 'otf'
  if (startsWith(head, [0x00, 0x01, 0x00, 0x00]) || asciiAt(head, 0, 'true')) return 'ttf'
  if (asciiAt(head, 0, 'SQLite format 3')) return 'sqlite'
  if (asciiAt(head, 0, '<?xml') || asciiAt(head, 0, '<svg')) return 'xml'
  if (startsWith(head, [0xef, 0xbb, 0xbf]) && asciiAt(head, 3, '<?xml')) return 'xml'
  // Markup has to be recognized EXPLICITLY, not merely "unrecognized". A
  // server that answers an image request with an HTML anti-bot page is the
  // single most common way a download goes wrong, and `null` for it would
  // hand the decision back to the lying `Content-Type` — which is exactly
  // the failure this sniffer exists to prevent.
  if (asciiAtIgnoreCase(head, 0, '<!doctype html') || asciiAtIgnoreCase(head, 0, '<html')) return 'html'
  if (asciiAt(head, 0, '{') || asciiAt(head, 0, '[')) return 'json'
  return null
}

/**
 * Pull a filename out of `Content-Disposition`.
 *
 * RFC 5987 `filename*` wins over the bare `filename` parameter because the
 * bare one is ISO-8859-1 by definition and browsers have shipped percent-
 * encoded UTF-8 in it for twenty years. The returned value is a CANDIDATE
 * only — it goes through {@link sanitizeFileName} before it touches a disk.
 */
export function filenameFromContentDisposition(header: string | undefined): string | null {
  if (!header) return null
  const extended = /filename\*\s*=\s*([^']*)'([^']*)'([^;]+)/i.exec(header)
  if (extended) {
    try {
      const decoded = decodeURIComponent((extended[3] ?? '').trim().replace(/^"|"$/g, ''))
      if (decoded.trim() !== '') return decoded
    } catch {
      /* malformed percent-encoding — fall through to the bare parameter */
    }
  }
  const bare = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header)
  if (bare) {
    const value = ((bare[2] ?? bare[3]) ?? '').trim().replace(/^"|"$/g, '')
    if (value !== '') return value
  }
  return null
}

/** Windows reserved device names — legal as a filename everywhere except on Windows. */
const RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() }
}

/**
 * Reduce an untrusted candidate name to a single safe path segment.
 *
 * Everything Windows forbids is replaced (`\ / : * ? " < > |`, control
 * characters), leading dots are dropped (no `.`, no `..`, no dotfiles), a
 * trailing dot/space is removed (Windows silently strips it, which would
 * make the on-disk name differ from the name we validated and reported), a
 * reserved device name gains an underscore, and the base is length-capped.
 * Separators are replaced rather than dropped so `a/b.png` stays legible as
 * `a_b.png` instead of silently becoming `b.png`.
 */
export function sanitizeFileName(candidate: string): { base: string; ext: string } {
  let cleaned = candidate
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  let { base, ext } = splitExtension(cleaned)
  base = base.replace(/^\.+/, '').replace(/[. ]+$/,'').trim()
  // An extension is only an extension if it is short and alphanumeric —
  // `report.2024.final.pdf` must keep everything before the LAST dot, and
  // `archive.` (trailing dot) must not produce a dotfile.
  ext = /^[a-z0-9]{1,12}$/i.test(ext) ? ext.toLowerCase() : ''
  if (base === '') base = 'download'
  if (RESERVED_BASENAMES.has(base.toLowerCase())) base = `_${base}`
  if (base.length > MAX_BASE_LEN) base = base.slice(0, MAX_BASE_LEN)
  return { base, ext }
}

/**
 * True when an extension names something a host will happily EXECUTE.
 *
 * Exported for the unit suite: this list is a security boundary, and a
 * boundary only the code that writes files can check is a boundary nobody
 * re-verifies when someone adds a format to it.
 */
export function isExecutableExtension(ext: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(String(ext).toLowerCase().replace(/^\./, ''))
}

/**
 * Resolve `name` inside `root`, or throw.
 *
 * The sanitized name cannot contain a separator, so this is a second line of
 * defence rather than the first — but it is the one that matters, because it
 * is what keeps `workspace` mode a write-inside-the-workspace operation even
 * if the name sanitizer is ever weakened. `path.relative` is the check that
 * catches both `..` traversal and the absolute-path case, and it is done on
 * RESOLVED paths so a symlinked root or a `C:` vs `/c:` mismatch on Windows
 * cannot slip past a string prefix test.
 */
export function resolveInsideRoot(root: string, name: string): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, name)
  const rel = path.relative(resolvedRoot, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside the download root (resolved to "${target}").`)
  }
  return target
}

/**
 * Pick a non-clobbering name: `a.png` → `a-1.png` → `a-2.png` …
 *
 * Overwriting is worse than it looks: the workspace destination is where a
 * deliverable lives, and a second download of a different URL that happens to
 * share a basename would silently replace the file the user was given.
 */
async function uniquePath(dir: string, base: string, ext: string): Promise<{ path: string; filename: string }> {
  for (let n = 0; n < 1000; n++) {
    const filename = n === 0 ? `${base}.${ext}` : `${base}-${n}.${ext}`
    const target = resolveInsideRoot(dir, filename)
    try {
      await fs.access(target)
    } catch {
      return { path: target, filename }
    }
  }
  throw new Error('Could not find a free filename after 1000 attempts.')
}

export interface DownloadOptions {
  url: string
  dest: DownloadDest
  /** Explicit filename candidate; still sanitized and type-reconciled. */
  filename?: string
  /** Workspace root. REQUIRED for `dest: 'workspace'`, ignored for `tmp`. */
  workspaceRoot?: string
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  userAgent?: string
  allowlist?: readonly string[]
  allowPrivateNetwork?: boolean
  redirectProtection?: boolean
  protocolLock?: boolean
  headers?: Record<string, string>
  /** Override Node's DNS lookup (test seam). */
  lookup?: FetchOptions['lookup']
}

export interface DownloadResult {
  url: string
  finalUrl: string
  status: number
  statusText: string
  contentType: string
  /** Absolute path of the written file. */
  path: string
  /** Basename of the written file (the name actually used, post-clobber-avoid). */
  filename: string
  dest: DownloadDest
  bytes: number
  redirectChain: string[]
  warnings: string[]
}

function candidateNameFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    if (!last) return null
    return decodeURIComponent(last)
  } catch {
    return null
  }
}

/**
 * Fetch one URL and save it under the requested destination root.
 *
 * `mode: 'bytes'` is the load-bearing argument: it routes the request
 * through the shared transport (SSRF allowlist, private-IP rejection,
 * same-domain redirect lock, TLS 1.3 + UA pin) and hands back bytes without
 * a charset decode. The transport throws past `maxBytes` instead of
 * truncating, so a file that exists is a complete file.
 */
export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const dest: DownloadDest = options.dest === 'workspace' ? 'workspace' : 'tmp'
  const maxBytes = options.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Invalid maxBytes.')

  let root: string
  if (dest === 'workspace') {
    const configured = typeof options.workspaceRoot === 'string' ? options.workspaceRoot.trim() : ''
    if (configured === '') {
      throw new Error(
        'dest="workspace" is not available: no workspace root was provided by the host. Use dest="tmp".',
      )
    }
    root = path.join(configured, WORKSPACE_SUBDIR)
  } else {
    root = path.join(os.tmpdir(), TMP_SUBDIR)
  }

  const raw = await runClientFetch({
    url: options.url,
    headers: options.headers,
    timeoutMs: options.timeoutMs,
    maxBytes,
    // Meaningless for a byte body, but the transport wants a number and a
    // download must not be char-clipped by a stale config value.
    maxChars: Number.MAX_SAFE_INTEGER,
    maxRedirects: options.maxRedirects,
    userAgent: options.userAgent,
    allowlist: options.allowlist,
    allowPrivateNetwork: options.allowPrivateNetwork,
    redirectProtection: options.redirectProtection,
    protocolLock: options.protocolLock,
    lookup: options.lookup,
    mode: 'bytes',
  })
  const bytes = raw.bodyBuffer ?? new Uint8Array()
  if (bytes.length === 0) throw new Error('The response body was empty; nothing was written.')

  const warnings: string[] = []
  if (raw.meta.redirectChain.length > 0) {
    warnings.push(`Followed ${raw.meta.redirectChain.length} redirect(s) to ${raw.finalUrl}.`)
  }

  // ── name ────────────────────────────────────────────────────────────────
  const explicit = typeof options.filename === 'string' ? options.filename.trim() : ''
  const candidate =
    explicit ||
    filenameFromContentDisposition(raw.headers['content-disposition']) ||
    candidateNameFromUrl(raw.finalUrl) ||
    'download'
  const { base: declaredBase, ext: declaredExt } = sanitizeFileName(candidate)

  // ── type ────────────────────────────────────────────────────────────────
  // Precedence, and every rung exists because the one above it can lie:
  //   1. magic bytes — the payload is the only thing that cannot lie;
  //   2. Content-Type — the server's own claim, for the formats the map
  //      knows, when the bytes are simply unrecognized (opaque blobs, some
  //      fonts, proprietary containers);
  //   3. the declared filename — last, because it is attacker-controlled and
  //      the least likely of the three to be right.
  // A URL basename loses to the content type: `/download?name=x.png` served
  // as `text/csv` is a CSV, and calling it a PNG is how a model ends up
  // handing a broken file to the next tool.
  const sniffed = sniffExtension(bytes.subarray(0, 64))
  const mediaType = raw.contentType.split(';')[0]!.trim().toLowerCase()
  const mimeExt = EXT_FOR_MIME[mediaType] ?? ''
  const ext = sniffed ?? mimeExt ?? declaredExt ?? 'bin'
  if (sniffed && declaredExt && sniffed !== declaredExt) {
    warnings.push(
      `Filename said ".${declaredExt}" but the payload is ${sniffed.toUpperCase()}; saved as ".${sniffed}".`,
    )
  } else if (!sniffed && mimeExt && declaredExt && mimeExt !== declaredExt) {
    warnings.push(
      `Filename said ".${declaredExt}" but the server sent ${mediaType}; saved as ".${mimeExt}".`,
    )
  }
  if (sniffed === 'html' || sniffed === 'json' || sniffed === 'xml') {
    warnings.push(
      `The server returned ${sniffed.toUpperCase()} markup/data, not a binary file; the bytes on disk are what it sent.`,
    )
  }
  if (!sniffed && !mimeExt && !declaredExt) {
    warnings.push(`Unrecognized payload; saved as "${declaredBase}.bin".`)
  }

  // ── bounds ──────────────────────────────────────────────────────────────
  // Both names are checked: the sniffed one (what we are about to write) and
  // the declared one (what the server called it). Either being executable is
  // a refusal — a `.exe` that sniffs as `exe` obviously, and a `setup.exe`
  // that sniffs as `riff` just as much.
  for (const candidateExt of new Set([ext, declaredExt])) {
    if (candidateExt && isExecutableExtension(candidateExt)) {
      throw new Error(
        `Refusing to save an executable (".${candidateExt}"); web_download writes data files only.`,
      )
    }
  }

  await fs.mkdir(root, { recursive: true })
  const chosen = await uniquePath(root, declaredBase, ext)
  // Atomic: a reader (or the user) never observes a partial file, and a
  // crash mid-write leaves a `.part` the next run can ignore.
  const partPath = resolveInsideRoot(root, `.${chosen.filename}.${process.pid}.part`)
  try {
    await fs.writeFile(partPath, bytes)
    await fs.rename(partPath, chosen.path)
  } catch (error) {
    await fs.rm(partPath, { force: true }).catch(() => {})
    throw error
  }

  return {
    url: options.url,
    finalUrl: raw.finalUrl,
    status: raw.status,
    statusText: raw.statusText,
    contentType: raw.contentType,
    path: chosen.path,
    filename: chosen.filename,
    dest,
    bytes: bytes.length,
    redirectChain: raw.meta.redirectChain,
    warnings,
  }
}
