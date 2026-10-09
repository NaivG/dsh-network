/**
 * Node smoke test for the dsh-network persistent loopback server.
 *
 * Real loopback E2E, no public network: spins up a local echo HTTP server,
 * spawns the BUILT CLI (`dist/cli.cjs`) in `server` mode, then drives it
 * over HTTP exactly like the host plugin will:
 *
 *   1. spawn the server, read the `{"type":"ready","port":N}` stdout line;
 *   2. POST /invoke with a `fetch` argv targeting the echo server
 *      (loopback → needs `--allow-private-network`), body over INLINE_CAP;
 *   3. assert the envelope carries `cacheId` + `contentLength` and the
 *      inline `content` is only the preview;
 *   4. page through the cached body via POST /invoke `--cache-id`+`--offset`;
 *   5. assert `/health` reports cache size, then `/shutdown` exits cleanly.
 *
 * Run: `node tests/server-smoke.mjs` (requires `pnpm build` first).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../dist/cli.cjs', import.meta.url))
const INLINE_CAP = 20_000

function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = text === '' ? null : JSON.parse(text)
          } catch {
            parsed = text
          }
          resolve({ status: res.statusCode, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function main() {
  // 1. A local echo HTTP server that emits a body larger than INLINE_CAP.
  const echoBody = 'line-'.repeat(5_000) // 6 * 5_000 = 30 000 chars
  const echo = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(echoBody)
  })
  await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  const echoPort = echo.address().port
  console.log(`echo server on 127.0.0.1:${echoPort} (${echoBody.length} chars)`)

  // 1b. A local feed server: one RSS document far larger than INLINE_CAP,
  // served fresh on every request.
  const feedBody = `<?xml version="1.0"?><rss version="2.0"><channel><title>Smoke feed</title>${Array.from(
    { length: 40 },
    (_v, i) =>
      `<item><title>Entry ${i}</title><link>https://example.test/e${i}</link><description>${'padding '.repeat(200)}</description></item>`,
  ).join('')}</channel></rss>`
  const feed = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(feedBody)
  })
  await new Promise((r) => feed.listen(0, '127.0.0.1', r))
  const feedPort = feed.address().port
  console.log(`feed server on 127.0.0.1:${feedPort} (${feedBody.length} chars of RSS)`)

  // 2. Spawn the built CLI in server mode — exactly like the host does
  // (plain `node cli.cjs server`, no special flags).
  const child = spawn(process.execPath, [CLI, 'server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let ready
  try {
    ready = await new Promise((resolve, reject) => {
      const rl = createInterface({ input: child.stdout })
      const timer = setTimeout(() => reject(new Error('server did not announce ready')), 15_000)
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'ready') {
            clearTimeout(timer)
            rl.close()
            resolve(msg)
          }
        } catch {}
      })
      child.once('error', reject)
    })
  } catch (error) {
    child.kill('SIGTERM')
    echo.close()
    feed.close()
    throw error
  }
  const port = ready.port
  console.log(`server ready on 127.0.0.1:${port}`)

  try {
    // 3. Fetch the echo body through /invoke (loopback → allow-private).
    const fetchArgv = ['fetch', '-u', `http://127.0.0.1:${echoPort}/big`, '--format', 'markdown', '--allow-private-network']
    const inv = await request(port, 'POST', '/invoke', JSON.stringify({ argv: fetchArgv }))
    assert.equal(inv.status, 200, `invoke status ${inv.status}`)
    const entry = inv.body.results[0]
    assert.equal(entry.status, 'ok')
    console.log('fetch entry:', JSON.stringify({
      status: entry.status,
      contentLength: entry.contentLength,
      hasCacheId: !!entry.cacheId,
      contentLen: (entry.content || '').length,
    }))

    // 4. The body is 30k chars → must be degraded to preview + cacheId.
    assert.ok(entry.cacheId, 'over-cap body must degrade to cacheId')
    assert.equal(entry.contentLength, echoBody.length)
    assert.ok(entry.content.length <= INLINE_CAP)
    assert.ok(entry.content.length > 0)

    // 5. Page through via cacheId.
    const page = await request(port, 'POST', '/invoke', JSON.stringify({
      argv: ['fetch', '--cache-id', entry.cacheId, '--offset', '1000', '--limit', '500'],
    }))
    assert.equal(page.status, 200)
    const pEntry = page.body.results[0]
    assert.equal(pEntry.status, 'ok')
    assert.equal(pEntry.cacheId, entry.cacheId)
    assert.equal(pEntry.content, echoBody.slice(1000, 1500))
    assert.equal(pEntry.cacheSlice.offset, 1000)
    assert.equal(pEntry.cacheSlice.end, 1500)
    assert.equal(pEntry.cacheSlice.more, true)
    console.log('paging OK: [1000,1500) of', pEntry.cacheSlice.total)

    // 5b. Bare `--cache-id` (the argv http_request's paging path sends — no
    // `fetch` subcommand, no `-X`) must page, not fall through to help, and
    // come back HTTP-shaped: the host handler consumes `entry.body`, so a
    // fetch-shaped `content` field rendered as an empty body (defect).
    const bare = await request(port, 'POST', '/invoke', JSON.stringify({
      argv: ['--cache-id', entry.cacheId, '--offset', '2000', '--limit', '300'],
    }))
    assert.equal(bare.status, 200)
    assert.equal(bare.body.help, undefined, 'bare --cache-id must not return the help envelope')
    assert.ok(bare.body.results.length > 0, 'bare --cache-id must return a result entry')
    const bEntry = bare.body.results[0]
    assert.equal(bEntry.status, 'ok')
    assert.equal(bEntry.body, echoBody.slice(2000, 2300), 'bare --cache-id must return an http-shaped entry')
    assert.equal(bEntry.cacheSlice.offset, 2000)
    assert.equal(bEntry.cacheSlice.end, 2300)

    // 5b2. Explicit `http --cache-id` (the prefixed form the host sends since
    // the shape fix) pages identically.
    const httpPaged = await request(port, 'POST', '/invoke', JSON.stringify({
      argv: ['http', '--cache-id', entry.cacheId, '--offset', '2500', '--limit', '200'],
    }))
    assert.equal(httpPaged.status, 200)
    const hEntry = httpPaged.body.results[0]
    assert.equal(hEntry.status, 'ok')
    assert.equal(hEntry.body, echoBody.slice(2500, 2700), 'http --cache-id must return an http-shaped entry')
    console.log('bare + http --cache-id paging OK: [2000,2700) of', hEntry.cacheSlice.total)

    // 5c. A warm dedup hit for the same URL must keep the degrade shape:
    // preview ≤ INLINE_CAP + cacheId, never the full body inline.
    const again = await request(port, 'POST', '/invoke', JSON.stringify({ argv: fetchArgv }))
    assert.equal(again.status, 200)
    const aEntry = again.body.results[0]
    assert.equal(aEntry.status, 'ok')
    assert.equal(aEntry.cacheId, entry.cacheId, 'dedup hit reuses the same cacheId')
    assert.ok(
      (aEntry.content || '').length <= INLINE_CAP,
      `dedup hit must stay a preview, got ${(aEntry.content || '').length} chars`,
    )
    assert.equal(aEntry.contentLength, echoBody.length)
    assert.ok(
      (aEntry.warnings || []).some((w) => /Served from server cache/.test(w)),
      'dedup hit should be labelled as served from cache',
    )
    console.log('dedup hit keeps degrade shape:', (aEntry.content || '').length, 'chars')

    // 5d. A feed whose WHOLE render dwarfs INLINE_CAP: the tail must land
    // in the cache instead of being dropped by a render budget.
    const feedInvoke = await request(port, 'POST', '/invoke', JSON.stringify({
      argv: ['fetch', '-u', `http://127.0.0.1:${feedPort}/rss.xml`, '--format', 'markdown', '--allow-private-network'],
    }))
    assert.equal(feedInvoke.status, 200)
    const fEntry = feedInvoke.body.results[0]
    assert.equal(fEntry.status, 'ok')
    assert.ok(fEntry.cacheId, 'an over-cap feed must degrade to cacheId, not to a truncated inline body')
    assert.ok(
      fEntry.contentLength > INLINE_CAP * 2,
      `the whole render must be cached, got ${fEntry.contentLength} chars`,
    )
    assert.ok(fEntry.content.length <= INLINE_CAP, 'the inline part stays a preview')
    // The preview ends on a WHOLE item, so the model's next cacheId call
    // starts at a readable boundary rather than mid-entry.
    assert.match(fEntry.content, /padding$/)
    const feedPage = await request(port, 'POST', '/invoke', JSON.stringify({
      argv: ['fetch', '--cache-id', fEntry.cacheId, '--offset', String(fEntry.content.length), '--limit', '400'],
    }))
    assert.equal(feedPage.body.results[0].status, 'ok')
    assert.match(feedPage.body.results[0].content, /^\n\n## \d+\./, 'paging resumes on an item boundary')
    assert.ok(
      (fEntry.warnings || []).some((w) => w.includes(`offset ${fEntry.content.length}`)),
      'the warning must name the exact resume offset',
    )
    console.log(
      'feed: preview',
      fEntry.content.length,
      'of',
      fEntry.contentLength,
      'chars cached; paging resumes at an item boundary',
    )

    // 6. /health reports the cache.
    const health = await request(port, 'GET', '/health')
    assert.equal(health.status, 200)
    assert.equal(health.body.ok, true)
    assert.ok(health.body.cache.size >= 1)
    console.log('health:', JSON.stringify(health.body.cache))

    // 7. /shutdown exits cleanly.
    const sh = await request(port, 'POST', '/shutdown')
    assert.equal(sh.status, 200)
    const exit = await new Promise((r) => child.once('exit', r))
    assert.equal(exit, 0)
    console.log('server exited cleanly with code', exit)
    console.log('PASS: server-smoke')
  } finally {
    child.kill('SIGTERM')
    echo.close()
    feed.close()
  }
}

main().catch((error) => {
  console.error('FAIL:', error)
  process.exit(1)
})
