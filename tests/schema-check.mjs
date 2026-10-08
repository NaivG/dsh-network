// Regression guard for the dsh-tools JSON Schema subset.
//
// The host plugin registers three tools whose `parameters`
// and `output.schema` blocks are validated by `dsh-tools.assertSupportedJsonSchema`
// at boot. The accepted subset is narrow:
//   type / oneOf / properties / required / additionalProperties / items /
//   enum / const + annotations (description, title).
// `required` must be an array of property names placed at the *object*
// level (next to `properties`), never a `required: true` flag inside a
// property — that was the boot failure fixed alongside this script.
//
// Run:  node ./tests/schema-check.mjs
// Exits non-zero if any schema in the host-side modules is rejected.
//
// The host side is split across modules (dsh/index.js + the files it
// wires: schemas / cli-runner / evidence / providers / tools / routes /
// config-summary). The schemas and the tool `parameters` blocks live in
// `dsh/schemas.js` and `dsh/tools.js`, so this guard scans ALL of them
// concatenated and keeps working if a constant moves between files.
//
// The validator lives in @deepseek-ai/dsh-tools, which ships inside the dsh
// harness install rather than as a dependency of this package. It is located
// without hardcoding any machine path, in this order:
//   1. DSH_TOOLS_PATH — explicit override, path to dsh-tools' lib/index.js
//   2. npm global root  (<root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools)
//   3. pnpm global root (same layout, for pnpm-installed harnesses)
// When dsh is not installed at all, the guard skips cleanly with exit 0 so
// fresh clones and CI without the harness still pass.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

/** Global node_modules roots where the dsh harness may live (best effort). */
function globalRoots() {
  const roots = new Set()
  for (const probe of ['npm root -g', 'pnpm root -g']) {
    try {
      // shell: true is required — npm/pnpm are .cmd shims on Windows and
      // Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980).
      roots.add(execFileSync(probe, { encoding: 'utf8', shell: true }).trim())
    } catch {
      // package manager missing or misconfigured — try the next probe
    }
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    roots.add(join(process.env.APPDATA, 'npm', 'node_modules'))
  }
  roots.add('/usr/local/lib/node_modules')
  roots.add('/usr/lib/node_modules')
  return [...roots].filter(Boolean)
}

/** @returns {Promise<{ assertSupportedJsonSchema: Function, JsonSchemaError: Function } | null>} */
async function loadDshTools() {
  // 1) explicit override: DSH_TOOLS_PATH points at dsh-tools' entry file.
  if (process.env.DSH_TOOLS_PATH && existsSync(process.env.DSH_TOOLS_PATH)) {
    return import(pathToFileURL(process.env.DSH_TOOLS_PATH).href)
  }
  // 2) npm-global layout: <root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools
  for (const root of globalRoots()) {
    const file = join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    if (existsSync(file)) return import(pathToFileURL(file).href)
  }
  // 3) resolve from the dsh package itself — covers pnpm's nested store layout.
  for (const root of globalRoots()) {
    try {
      const baseRequire = createRequire(join(root, '@deepseek-ai', 'dsh', 'package.json'))
      const resolved = baseRequire.resolve('@deepseek-ai/dsh-tools')
      return import(pathToFileURL(resolved).href)
    } catch {
      // dsh not installed under this root — try the next one
    }
  }
  return null
}

const dshTools = await loadDshTools()
if (!dshTools) {
  console.log('skip: @deepseek-ai/dsh-tools not found — install the dsh harness')
  console.log('      or point DSH_TOOLS_PATH at its lib/index.js to run this guard.')
  process.exit(0)
}
const { assertSupportedJsonSchema, JsonSchemaError } = dshTools

const here = dirname(fileURLToPath(import.meta.url))
// Scan every host-side module: the constants and the parameters blocks can
// legally live in any of them, and a future move must not silently no-op
// this guard (the same failure mode the CRLF regex below once had).
const HOST_FILES = [
  'index.js',
  'schemas.js',
  'cli-runner.js',
  'evidence.js',
  'providers.js',
  'tools.js',
  'routes.js',
  'config-summary.js',
]
const src = HOST_FILES.map((file) => readFileSync(join(here, '..', 'dsh', file), 'utf8')).join('\n')

function extractConst(name) {
  // Walk forward from `const <name> = ` and brace-balance `{}` / `[]`
  // so we can grab both object literals (schemas) and array literals
  // (enum vocabularies like WEB_SITEMAP_CATEGORIES) regardless of
  // whether they close on their own line.
  //
  // String handling is the tricky bit: we toggle `inString` on a
  // single/double/backtick quote and skip everything inside, BUT we
  // have to re-enter brace-counting inside `${...}` substitutions of a
  // template literal (otherwise the parser would treat `${value.foo}`
  // as a single `{ }` inside a string and over-count). The state
  // machine below tracks three top-level contexts — string, template
  // literal, and code — plus the depth-0 / depth-N nesting inside them.
  const start = src.indexOf(`const ${name} = `)
  if (start === -1) throw new Error(`could not locate ${name} in the dsh host modules`)
  const valueStart = start + `const ${name} = `.length
  let depth = 0
  let opener = ''
  let quote = '' // active quote character: ', ", or ` (empty = not in a string)
  let escape = false
  for (let i = valueStart; i < src.length; i++) {
    const ch = src[i]
    if (quote !== '') {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === quote) {
        if (quote === '`' && src[i + 1] === '{') {
          // Template-literal substitution `${...}` — re-enter code
          // mode but keep `quote` so the closing backtick can pop us
          // back into the string.
          quote = '`'
          // The `{` will be counted by the next iteration.
          continue
        }
        quote = ''
        continue
      }
      continue
    }
    // code context
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '/' && src[i + 1] === '/') {
      // line comment: skip to EOL
      const eol = src.indexOf('\n', i)
      if (eol === -1) break
      i = eol
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      // block comment: skip to */
      const end = src.indexOf('*/', i + 2)
      if (end === -1) break
      i = end + 1
      continue
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0) opener = ch
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0 && ch === (opener === '{' ? '}' : ']')) {
        const body = src.slice(valueStart, i + 1)
        // eslint-disable-next-line no-new-func
        return new Function(`return (${body});`)()
      }
    }
  }
  throw new Error(`could not parse ${name} in the dsh host modules (unbalanced brackets?)`)
}

let failed = 0
function check(label, schema) {
  try {
    assertSupportedJsonSchema(schema)
    console.log(`ok  ${label}`)
  } catch (error) {
    failed++
    if (error instanceof JsonSchemaError) {
      console.error(`FAIL ${label}`)
      for (const v of error.violations) console.error(`  - ${v}`)
    } else {
      console.error(`FAIL ${label}:`, error?.message ?? error)
    }
  }
}

for (const name of ['SEARCH_OUTPUT_SCHEMA', 'FETCH_OUTPUT_SCHEMA', 'HTTP_OUTPUT_SCHEMA', 'WEB_CONFIG_OUTPUT_SCHEMA', 'WEB_CONFIG_PATCH_SCHEMA']) {
  check(name, extractConst(name))
}

// The tool-registration `parameters: { ... }` blocks. They are
// followed by `output: { schema: <NAME>, ... }` on the next statement, so
// we anchor on `output:` to keep the regex unambiguous.
// The line breaks are matched as `\r?\n`: with `core.autocrlf=true` the
// checked-out working tree is CRLF, and a bare `\n` in the pattern made this
// guard match zero blocks on Windows — degrading it into "found 0" instead
// of checking anything.
const paramMatches = [
  ...src.matchAll(/parameters: \{\r?\n([\s\S]*?)\r?\n    \},\r?\n    output: \{/g),
]
if (paramMatches.length !== 5) {
  console.error(`expected 5 parameters blocks (search, fetch, http_request, web_sitemap, web_config), found ${paramMatches.length}`)
  failed++
} else {
  paramMatches.forEach((m, i) => {
    // web_search's enum is built at runtime from config.searchEngines;
    // web_sitemap's category enum references WEB_SITEMAP_CATEGORIES;
    // web_config's parameters block spreads WEB_CONFIG_PATCH_SCHEMA.
    // Pull each named const into the eval stub so the parameters block
    // sees the same bindings the real module sees.
    const stub =
      `const knownEngines = ['bing', 'duckduckgo', 'baidu']\n` +
      `const WEB_SITEMAP_CATEGORIES = ${JSON.stringify(extractConst('WEB_SITEMAP_CATEGORIES'))}\n` +
      `const WEB_CONFIG_PATCH_SCHEMA = ${JSON.stringify(extractConst('WEB_CONFIG_PATCH_SCHEMA'))}\n`
    // eslint-disable-next-line no-new-func
    const obj = new Function(stub + `return { parameters: {\n${m[1]}\n    \}};`)()
    check(`parameters[${i}]`, obj.parameters)
  })
}

if (failed > 0) {
  console.error(`\n${failed} schema check(s) failed`)
  process.exit(1)
}
console.log('\nall schema checks passed')