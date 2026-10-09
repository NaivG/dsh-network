// Manual end-to-end check for the `download` subcommand of the built CLI.
// Not part of the suite (it needs dist/cli.cjs and a live origin):
//   node tests/download-cli-smoke.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'dist', 'cli.cjs')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

const server = createServer((req, res) => {
  if (req.url.startsWith('/pixel.png')) {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
  } else if (req.url.startsWith('/lib.js')) {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end('export const x = 1\n')
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const { port } = server.address()
const origin = `http://127.0.0.1:${port}`

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dshn-cli-smoke-'))

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.on('close', () => resolve(out))
  })
}

const results = []
function check(label, ok, detail) {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. workspace destination, honoring DSH_NETWORK_WORKSPACE_DIR
{
  const raw = await run(
    ['download', '-u', `${origin}/pixel.png`, '--dest', 'workspace', '--allow-private-network'],
    { DSH_NETWORK_WORKSPACE_DIR: workspace },
  )
  const entry = JSON.parse(raw).results[0]
  const onDisk = entry.path ? await fs.readFile(entry.path).catch(() => null) : null
  check(
    'workspace download writes the bytes',
    entry.status === 'ok' && onDisk !== null && onDisk.equals(PNG),
    `${entry.filename} (${entry.bytes} B) at ${entry.path}`,
  )
  check('workspace root is <root>/downloads', String(entry.path).startsWith(path.join(workspace, 'downloads')))
}

// 2. the executable denylist
{
  const raw = await run(
    ['download', '-u', `${origin}/lib.js`, '--dest', 'workspace', '--allow-private-network'],
    { DSH_NETWORK_WORKSPACE_DIR: workspace },
  )
  const entry = JSON.parse(raw).results[0]
  check('executable extension refused', entry.status === 'unavailable' && /executable/i.test(entry.summary), entry.summary)
}

// 3. workspace without a configured root
{
  const raw = await run(
    ['download', '-u', `${origin}/pixel.png`, '--dest', 'workspace', '--allow-private-network'],
    { DSH_NETWORK_WORKSPACE_DIR: '' },
  )
  const entry = JSON.parse(raw).results[0]
  check('workspace refused without a host root', entry.status === 'unavailable' && /workspace root/.test(entry.summary), entry.summary)
}

// 4. the byte cap
{
  const raw = await run(
    ['download', '-u', `${origin}/pixel.png`, '--max-bytes', '8', '--allow-private-network'],
    {},
  )
  const entry = JSON.parse(raw).results[0]
  check('over-cap transfer fails instead of truncating', entry.status === 'unavailable' && /exceeds max size/.test(entry.summary), entry.summary)
}

// 5. SSRF still fenced by default
{
  const raw = await run(['download', '-u', `${origin}/pixel.png`], {})
  const entry = JSON.parse(raw).results[0]
  check('private target blocked without the opt-in', entry.status === 'unavailable' && /private|denied|reserved/i.test(entry.summary), entry.summary)
}

// 6. a 404 body is still saved, and the status says so
{
  const raw = await run(
    ['download', '-u', `${origin}/gone.png`, '--dest', 'workspace', '--allow-private-network'],
    { DSH_NETWORK_WORKSPACE_DIR: workspace },
  )
  const entry = JSON.parse(raw).results[0]
  check('404 body saved with a warning', entry.status === 'ok' && entry.statusCode === 404 && /HTTP 404/.test(entry.warnings.join(' ')), entry.warnings.join(' '))
}

await fs.rm(workspace, { recursive: true, force: true })
server.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
