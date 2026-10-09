/**
 * Tests for `src/download.ts` — the web_download file-write path.
 *
 * Two halves, deliberately separated:
 *
 *   1. PURE unit tests over the name / type / bounds helpers. These are the
 *      security boundary: a filename that escapes the root, an extension that
 *      lies about the payload, a `.ps1` that lands on disk. All of it is
 *      reachable without a socket, so it is tested without one.
 *   2. A loopback end-to-end pass over `downloadFile` against a throwaway
 *      `node:http` origin, because the parts that only exist in the whole —
 *      the `mode: 'bytes'` transport branch, the byte cap, the write — have
 *      no seams worth adding one for. Loopback only; the SSRF guards are
 *      explicitly opened for these calls via `allowPrivateNetwork`, exactly
 *      as `--allow-private-network` does for a real one.
 */
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_DOWNLOAD_MAX_BYTES,
  downloadFile,
  filenameFromContentDisposition,
  isExecutableExtension,
  resolveInsideRoot,
  sanitizeFileName,
  sniffExtension,
} from '../src/download.ts'

// A 1×1 PNG — real magic bytes, small enough to inline.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
])
const HTML_BYTES = new Uint8Array(Buffer.from('<!doctype html><html><body>nope</body></html>'))
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00])

describe('sanitizeFileName', () => {
  it('splits a normal name into base + lowercased extension', () => {
    expect(sanitizeFileName('Photo.PNG')).toEqual({ base: 'Photo', ext: 'png' })
  })

  it('cannot be walked out of its directory', () => {
    // `..` is stripped from the FRONT of the base, so both of these collapse
    // to a plain name inside the root rather than resolving upward.
    expect(sanitizeFileName('../../etc/passwd').base).not.toContain('/')
    expect(sanitizeFileName('../../etc/passwd').base).not.toContain('\\')
    expect(sanitizeFileName('..\\..\\windows\\system32\\x.dll').base).not.toContain('\\')
    expect(sanitizeFileName('..').base).toBe('download')
    expect(sanitizeFileName('.').base).toBe('download')
  })

  it('replaces what Windows forbids instead of dropping it silently', () => {
    // Dropping would silently merge `a/b.png` into `b.png`, which reads as a
    // different download than the one the user asked for.
    expect(sanitizeFileName('a/b:c*d?e"f<g>h|i.png').base).toBe('a_b_c_d_e_f_g_h_i')
  })

  it('neutralizes Windows reserved device names', () => {
    expect(sanitizeFileName('CON').base).toBe('_CON')
    expect(sanitizeFileName('nul.png').base).toBe('_nul')
    expect(sanitizeFileName('com1.txt').base).toBe('_com1')
    // Only the exact device name is reserved — `console` is a normal file.
    expect(sanitizeFileName('console').base).toBe('console')
  })

  it('drops control characters and trailing dots/spaces', () => {
    expect(sanitizeFileName('re\u0000po\u001frt.png').base).toBe('report')
    // Windows strips a trailing dot/space silently, so the on-disk name
    // would not match the name we validated and reported.
    expect(sanitizeFileName('report. ').ext).toBe('')
    expect(sanitizeFileName('report. ').base).toBe('report')
  })

  it('treats a long or non-alphanumeric trailing token as part of the base', () => {
    // `report.2024.final.pdf` must keep everything before the LAST dot.
    expect(sanitizeFileName('report.2024.final.pdf')).toEqual({ base: 'report.2024.final', ext: 'pdf' })
    expect(sanitizeFileName('archive.')).toEqual({ base: 'archive', ext: '' })
  })

  it('caps the base length', () => {
    const { base } = sanitizeFileName(`${'n'.repeat(400)}.png`)
    expect(base.length).toBeLessThanOrEqual(120)
  })

  it('is pure html/text when handed a URL-ish name with no extension', () => {
    expect(sanitizeFileName('  spaced name  ')).toEqual({ base: 'spaced name', ext: '' })
  })
})

describe('sniffExtension', () => {
  it('identifies the formats that reach a workspace', () => {
    expect(sniffExtension(PNG_BYTES)).toBe('png')
    expect(sniffExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('jpg')
    expect(sniffExtension(new TextEncoder().encode('GIF89a....'))).toBe('gif')
    expect(sniffExtension(new TextEncoder().encode('RIFF____WEBPVP8 '))).toBe('webp')
    expect(sniffExtension(new TextEncoder().encode('%PDF-1.7'))).toBe('pdf')
    expect(sniffExtension(ZIP_BYTES)).toBe('zip')
    expect(sniffExtension(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))).toBe('gz')
    expect(sniffExtension(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBe('exe')
    expect(sniffExtension(new TextEncoder().encode('OggS........'))).toBe('ogg')
  })

  it('returns null for an unknown payload rather than guessing', () => {
    expect(sniffExtension(new Uint8Array([0x01, 0x02, 0x03, 0x04]))).toBe(null)
    expect(sniffExtension(new Uint8Array(0))).toBe(null)
  })

  it('does not mistake an HTML anti-bot page for a binary payload', () => {
    // This is the whole reason sniffing beats Content-Type: the server says
    // `image/png` and the bytes say otherwise. Returning `null` here would
    // hand the decision back to the lying Content-Type, so markup is
    // recognized positively.
    expect(sniffExtension(HTML_BYTES)).toBe('html')
    expect(sniffExtension(new TextEncoder().encode('<!DOCTYPE HTML><html>'))).toBe('html')
    expect(sniffExtension(new TextEncoder().encode('{"a":1}'))).toBe('json')
    expect(sniffExtension(new Uint8Array([0x01, 0x02, 0x03, 0x04]))).toBe(null)
  })
})

describe('filenameFromContentDisposition', () => {
  it('prefers the RFC 5987 extended parameter', () => {
    expect(
      filenameFromContentDisposition(
        "attachment; filename=\"fallback.png\"; filename*=UTF-8''%E5%9B%BE%E7%89%87.png",
      ),
    ).toBe('图片.png')
  })

  it('falls back to the bare parameter', () => {
    expect(filenameFromContentDisposition('attachment; filename="report.pdf"')).toBe('report.pdf')
    expect(filenameFromContentDisposition('inline; filename=data.csv')).toBe('data.csv')
  })

  it('survives malformed percent-encoding', () => {
    // The extended parameter is undecodable, so the bare one has to win
    // rather than the whole header being dropped.
    expect(
      filenameFromContentDisposition("attachment; filename*=UTF-8''%E0%A4%A; filename=ok.png"),
    ).toBe('ok.png')
  })

  it('returns null when there is no filename at all', () => {
    expect(filenameFromContentDisposition(undefined)).toBe(null)
    expect(filenameFromContentDisposition('attachment')).toBe(null)
  })
})

describe('resolveInsideRoot', () => {
  it('accepts a plain name', () => {
    const root = path.join(os.tmpdir(), 'dshn-test-root')
    expect(resolveInsideRoot(root, 'a.png')).toBe(path.join(path.resolve(root), 'a.png'))
  })

  it('refuses traversal, absolute paths and the root itself', () => {
    const root = path.join(os.tmpdir(), 'dshn-test-root')
    expect(() => resolveInsideRoot(root, '..')).toThrow(/outside the download root/)
    expect(() => resolveInsideRoot(root, '../evil.png')).toThrow(/outside the download root/)
    expect(() => resolveInsideRoot(root, 'sub/../../evil.png')).toThrow(/outside the download root/)
    expect(() => resolveInsideRoot(root, path.join(os.tmpdir(), 'evil.png'))).toThrow(
      /outside the download root/,
    )
    expect(() => resolveInsideRoot(root, '.')).toThrow(/outside the download root/)
  })

  it('does not accept a sibling directory that shares a name prefix', () => {
    // The reason this is `path.relative` and not `startsWith`: a root of
    // `…/downloads` must not admit `…/downloads-evil/x`.
    const base = path.join(os.tmpdir(), 'dshn-prefix-test')
    expect(() => resolveInsideRoot(base, path.join('..', 'downloads-evil', 'x.png'))).toThrow(
      /outside the download root/,
    )
  })
})

describe('isExecutableExtension', () => {
  it('covers the interpreters a host will actually run', () => {
    for (const ext of ['exe', 'msi', 'dll', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'sh', 'jar', 'lnk', 'py']) {
      expect(isExecutableExtension(ext), ext).toBe(true)
      expect(isExecutableExtension(`.${ext}`), ext).toBe(true)
      expect(isExecutableExtension(ext.toUpperCase()), ext).toBe(true)
    }
  })

  it('leaves data formats alone', () => {
    for (const ext of ['png', 'jpg', 'pdf', 'zip', 'csv', 'json', 'mp4', 'woff2', '']) {
      expect(isExecutableExtension(ext), ext).toBe(false)
    }
  })
})

// ─────────────────────────── loopback end-to-end ───────────────────────────

interface Origin {
  url: string
  close: () => Promise<void>
}

let origin: Origin

beforeAll(async () => {
  const server = http.createServer((req, res) => {
    const path_ = (req.url || '/').split('?')[0]
    if (path_ === '/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from(PNG_BYTES))
      return
    }
    if (path_ === '/disguised.png') {
      // The anti-bot page pattern: an image URL answering with markup.
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from(HTML_BYTES))
      return
    }
    if (path_ === '/setup.exe') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))
      return
    }
    if (path_ === '/named') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.zip",
      })
      res.end(Buffer.from(ZIP_BYTES))
      return
    }
    if (path_ === '/traversal') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from(PNG_BYTES))
      return
    }
    if (path_ === '/huge') {
      const size = 64 * 1024
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.alloc(size, 1))
      return
    }
    if (path_ === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('origin did not bind a port')
  origin = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
})

afterAll(async () => {
  if (origin) await origin.close()
})

const WORKSPACE_ROOT = path.join(os.tmpdir(), 'dshn-download-workspace')
const written: string[] = []

async function downloadToWorkspace(url: string, filename?: string) {
  const result = await downloadFile({
    url,
    dest: 'workspace',
    workspaceRoot: WORKSPACE_ROOT,
    filename,
    // The origin is on loopback, which the SSRF guard refuses by default.
    // This is the same switch `--allow-private-network` flips for a real
    // download — the point of the test is the file layer, not the fence.
    allowPrivateNetwork: true,
    redirectProtection: true,
    protocolLock: true,
  })
  written.push(result.path)
  return result
}

afterAll(async () => {
  for (const file of written) await fs.rm(file, { force: true }).catch(() => {})
  await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {})
})

describe('downloadFile (loopback origin)', () => {
  it('writes the bytes and names the file from the URL', async () => {
    const r = await downloadToWorkspace(`${origin.url}/pixel.png`)
    expect(r.filename).toBe('pixel.png')
    expect(r.bytes).toBe(PNG_BYTES.length)
    expect(r.status).toBe(200)
    expect(path.dirname(r.path)).toBe(path.join(path.resolve(WORKSPACE_ROOT), 'downloads'))
    const onDisk = await fs.readFile(r.path)
    expect(Buffer.from(onDisk).equals(Buffer.from(PNG_BYTES))).toBe(true)
  })

  it('trusts the magic bytes over both the URL and the Content-Type', async () => {
    // Served as image/png at a .png URL, but it is markup.
    const r = await downloadToWorkspace(`${origin.url}/disguised.png`)
    expect(r.filename).not.toMatch(/\.png$/)
    expect(r.filename.endsWith('.html')).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/payload/i)
  })

  it('honours Content-Disposition, RFC 5987 form', async () => {
    const r = await downloadToWorkspace(`${origin.url}/named`)
    expect(r.filename).toBe('报告.zip')
  })

  it('refuses an executable payload even when the URL looks ordinary', async () => {
    await expect(downloadToWorkspace(`${origin.url}/setup.exe`)).rejects.toThrow(/executable/i)
  })

  it('contains a traversal-shaped filename INSIDE the download root', async () => {
    // The sanitizer collapses the separators, so this never reaches
    // resolveInsideRoot as a traversal — it lands as one ordinary file whose
    // name happens to contain dots. That is the property under test: the
    // write stays in the root whatever the caller asked for.
    const r = await downloadToWorkspace(`${origin.url}/traversal`, '../../escaped.png')
    expect(path.dirname(path.resolve(r.path))).toBe(path.join(path.resolve(WORKSPACE_ROOT), 'downloads'))
    expect(r.filename).not.toContain('/')
    expect(r.filename).not.toContain('\\')
    // …and nothing landed beside the root.
    await expect(fs.stat(path.join(WORKSPACE_ROOT, 'escaped.png'))).rejects.toThrow()
  })

  it('never truncates: a body over the cap fails instead of writing a partial file', async () => {
    await expect(
      downloadFile({
        url: `${origin.url}/huge`,
        dest: 'workspace',
        workspaceRoot: WORKSPACE_ROOT,
        maxBytes: 1024,
        allowPrivateNetwork: true,
      }),
    ).rejects.toThrow(/exceeds max size/)
    // Nothing was written: the cap is enforced BEFORE the buffer reaches disk.
    const leftovers = await fs
      .readdir(path.join(WORKSPACE_ROOT, 'downloads'))
      .catch(() => [] as string[])
    expect(leftovers.filter((f) => f.includes('huge'))).toEqual([])
  })

  it('does not clobber an existing file', async () => {
    const a = await downloadToWorkspace(`${origin.url}/pixel.png`)
    const b = await downloadToWorkspace(`${origin.url}/pixel.png`)
    expect(a.path).not.toBe(b.path)
    expect(b.filename).toMatch(/^pixel-\d+\.png$/)
  })

  it('refuses the workspace destination when the host supplied no root', async () => {
    await expect(
      downloadFile({ url: `${origin.url}/pixel.png`, dest: 'workspace', allowPrivateNetwork: true }),
    ).rejects.toThrow(/workspace root/)
  })

  it('keeps the SSRF fence on by default — the origin is only reachable with it off', async () => {
    await expect(
      downloadFile({ url: `${origin.url}/pixel.png`, dest: 'tmp' }),
    ).rejects.toThrow(/private|reserved|denied/i)
  })

  it('still saves an error page, and says the status was not ok', async () => {
    const r = await downloadToWorkspace(`${origin.url}/missing`)
    expect(r.status).toBe(404)
    // The bytes on disk ARE the 404 body — the caller has to be able to see
    // that, so the status rides along instead of being silently promoted.
    expect(await fs.readFile(r.path, 'utf8')).toContain('not found')
  })
})

describe('download defaults', () => {
  it('caps a single download well above the fetch body caps', () => {
    // The 7–8 MB fetch caps bound a response PREVIEW; this one bounds the
    // server child's heap while holding a real file in memory.
    expect(DEFAULT_DOWNLOAD_MAX_BYTES).toBeGreaterThan(8 * 1024 * 1024)
  })
})
