# Development

Building, testing, and the code layout of `dsh-network`. For installation and
usage see the [README](../README.md); for the internal design see
[architecture.md](architecture.md); for the configuration reference see
[configuration.md](configuration.md).

## Setup

```bash
pnpm install          # runs `prepare` → builds dist/cli.cjs automatically
pnpm build            # vite SSR build → dist/cli.cjs + dist/server-*.cjs
pnpm dev              # vite SSR watch
```

The CLI is built with vite in SSR mode (`vite.cli.config.ts`) so `node:*`
imports stay Node-side. `src/server.ts` is dynamically imported by
`src/cli.ts`, so it lives in a hashed chunk (`dist/server-*.cjs`) that the
single-shot CLI never loads.

Smoke-test the built bundle:

```bash
node ./dist/cli.cjs -u https://example.com/ --allow-private-network
node ./dist/cli.cjs doctor
```

## Scripts

| Script | What it runs |
|---|---|
| `pnpm test` | vitest unit suite (~230 cases, no external network, ~7 s) — includes the browser-half render specs |
| `pnpm run test:server` | loopback server smoke (`tests/server-smoke.mjs`, plain node) |
| `pnpm run test:persist` | durable-config-store smoke (`tests/persist-smoke.mjs`, plain node) |
| `pnpm run test:download` | download CLI smoke (`tests/download-cli-smoke.mjs`, plain node; needs `dist/cli.cjs`) |
| `pnpm run test:schema` | tool-schema guard (`tests/schema-check.mjs`, plain node; skips cleanly when dsh is absent) |
| `pnpm run test:all` | unit suite + all four smokes in one go |

## Test suite

Unit specs (vitest, no external network unless noted):

- `tests/network.spec.ts` — URL/IP helpers, allowlist, error classification.
- `tests/download.spec.ts` — the file-write boundary: filename sanitization,
  magic-byte sniffing, `Content-Disposition` (RFC 5987), root containment, the
  executable-extension denylist, then a loopback end-to-end over `downloadFile`
  covering the bytes-mode transport, the byte cap, non-clobbering names and the
  SSRF fence staying closed by default.
- `tests/cache.spec.ts` — `ResultCache` dedup, slice paging, eviction,
  inline-cap degrade.
- `tests/host-cache-slice.spec.ts` — host-side `cacheSlice` pass-through
  contract.
- `tests/engine-config-wiring.spec.ts` — keyed-engine credential/options
  handoff: `configToEnv` env-var names ↔ `readEngineEnvOptions`, plus
  `summarize()` surfacing configs outside the chain. Pins the env-var NAMES
  on both sides, because a rename on one side alone degrades silently to
  "unset".
- `tests/presentationmeta.spec.ts` — presentation_metadata envelope fields.
- `tests/search-source-format.spec.ts` — pins the GFM whitespace of the
  search answer contract (hard breaks, indentation, blank-line joins).
- `tests/client-toolview.render.spec.ts` — materializes the REAL
  `dsh/client.js` and `dsh/client.toolviews.js` through a mock of
  `@deepseek-ai/dsh-client-modules` (`window.__ModuleLoader__.load`,
  factory return value = record exports) with `react` as the only seed
  word, then renders the rows with `react-dom/server`. Pins the memo-aware
  `isRenderable` contract (a memo-shaped `MarkdownText` must be USED, not
  bypassed) and the degraded `{ Input }` fallback, plus the `web_fetch` row's
  own contract: the page renders as markdown, a `format: 'raw'` body stays
  monospace, a paging hint quotes the ABSOLUTE next offset, and a thrown call
  shows its error instead of shimmering. Only `react` + `react-dom` are
  needed — `MarkdownText` itself is stubbed, so no dsh install is required.
- `tests/client-chunks.spec.ts` — the CHUNK contract, and the guard that
  catches "the settings page stopped rendering": (a) builds a TypeScript
  `checkJs` program over all four client files and fails on any unresolved
  name, (b) asserts every chunk declares the loader-approved
  `client.<name>.js` name and re-binds the entry through
  `require('@naivg/dsh-network')`, (c) asserts every `STYLES.<key>` a chunk reads
  exists in the entry's table, and (d) materializes the real chunks through
  a faithful chunk-aware loader (registrations keyed `<owner>/<chunk>`,
  owner-relative `require.async`) and renders the settings section, the
  loaded page with engine rows + both engine dialogs, the legacy card, the
  sidebar panel and the toolview rows. `typescript`, `react` and
  `react-dom` are the only requirements.

Smokes:

- `tests/server-smoke.mjs` spawns the built `dist/cli.cjs server`, points it
  at a local 25 000-char echo server, and asserts:
  1. `/invoke` on `fetch` returns a degraded preview with `contentLen`
     = 20 000 and a `cacheId`.
  2. Paging with `--cache-id --offset 1000 --limit 500` returns the exact
     echo slice `[1000, 1500)`.
  3. `/health` reports the cache size, total chars, and hits.
  4. `/shutdown` exits the server cleanly with code 0.
- `tests/persist-smoke.mjs` — snapshots save/load atomically,  corrupt/missing files degrade with a warning, and a full fake-host
  round-trip (apply → PUT → restart → GET) proves UI edits survive
  restarts, secrets included, `enabled` kill-switch excluded; also probes
  the `/dsh-network/search` route contract (fence 403, missing query 400,
  bad count 400, wrong method 405, and the `webSearchTool` kill-switch
  gating the route).
- `tests/download-cli-smoke.mjs` drives the BUILT `dist/cli.cjs download`
  against a throwaway loopback origin: the workspace destination honors
  `DSH_NETWORK_WORKSPACE_DIR` and lands in `<root>/downloads/`, a `.js`
  payload is refused as executable, `workspace` without a host root fails
  instead of guessing, an over-cap transfer fails rather than truncating, a
  loopback target is blocked unless `--allow-private-network` is passed, and
  a 404 body is still saved with the non-200 status reported.
- `tests/schema-check.mjs` — extracts every `parameters` / `output.schema`
  block from the dsh host modules (the constants live in `dsh/schemas.js`,
  the tool registrations in `dsh/tools.js`; the guard scans all host-side
  files concatenated so a future move stays green) and asserts they pass
  `dsh-tools.assertSupportedJsonSchema`. Locates dsh-tools via
  `DSH_TOOLS_PATH` or the npm/pnpm global root; skips with exit 0 when the
  harness is not installed. The `parameters` regex matches line breaks as
  `\r?\n` on purpose: with `core.autocrlf=true` the working tree is CRLF and
  a bare `\n` silently matched ZERO blocks on Windows, turning the guard
  into a no-op.

## Code organization

```
dsh-network/
├── package.json                # main: ./dsh/index.js, bin: ./dist/cli.cjs, prepare → scripts/prepare.mjs
├── cordis.patch.yml            # topples web seam + tool-web + inserts row
├── vite.cli.config.ts          # SSR build for the CLI
├── scripts/prepare.mjs         # git-install build hook
├── dsh/                        # HOST (node) half — hand-written ESM, no build
│   ├── index.js                # contract exports + apply() wiring
│   ├── schemas.js              # tool JSON Schemas + enum vocabularies
│   ├── cli-runner.js           # server-client singleton + runCli/runCliSoft
│   ├── evidence.js             # model-facing evidence rendering + previewText clip + jsonSafeMeta
│   ├── providers.js            # web seam providers (search/fetch)
│   ├── tools.js                # the six tool registrations
│   ├── routes.js               # /dsh-network/config|health|search routes
│   ├── config-summary.js       # summarize / summarizeForModel / applyCardSettings / fence
│   ├── serverClient.js         # host ↔ loopback server client
│   ├── persist.js              # durable config store (atomic write)
│   ├── spawnHidden.js          # child-process boundary
│   ├── client.js               # BROWSER entry: shared surface + apply()
│   ├── client.settings.js      # chunk: "网络" settings section + legacy card
│   ├── client.toolviews.js     # chunk: 6 toolview rows + dshn-* styles
│   └── client.searchpanel.js   # chunk: sidebar search panel
├── src/                        # CLI (vite SSR build → dist/cli.cjs)
│   ├── cli.ts                  # argv parsing → search/fetch/http/download/sitemap/doctor/server
│   ├── server.ts               # loopback HTTP server + parent-death watcher
│   ├── cache.ts                # ResultCache (dedup, LRU, degrade, paging)
│   ├── client.ts               # RAW transport: undici + pinned-dispatcher SSRF (text/bytes modes)
│   ├── fetch.ts                # web_fetch formatting layer
│   ├── download.ts             # web_download: name sanitize + magic sniff + atomic write
│   ├── http_request.ts         # undici-direct low-level HTTP path
│   ├── sitemap.ts              # web_sitemap curated portals table
│   ├── network.ts              # URL/IP helpers, allowlist, error classification
│   ├── html-extract.ts         # HTML → visible text + links (raw helpers)
│   ├── html.ts                 # HTML → Markdown (nav/footer pre-filter)
│   ├── document.ts             # PDF/OOXML/ODF/EPUB → Markdown via officeparser
│   ├── search-engines.ts       # BACKWARD-COMPAT shim → re-exports ./engines
│   ├── config.ts               # CLI-side runtime config (env knobs)
│   └── engines/                # registry + per-engine implementations
│       ├── types.ts            # SearchEngine interface, registry, options reader
│       ├── header-profiles.ts  # Firefox-127 baseline + overlays
│       ├── bing.ts / duckduckgo.ts / baidu.ts / github.ts / searxng.ts / brave.ts
│       └── index.ts            # barrel + registerDefaultEngines()
├── tests/                      # see "Test suite" above
└── dist/                       # built artifacts (gitignored)
    ├── cli.cjs
    └── server-*.cjs            # hashed server chunk
```

Single responsibility: this package owns live web (search + fetch + http +
document parsing). Image parsing lives in `modlens`.

## Publishing and the `prepare` / `prepack` hooks

`dist/` is gitignored, so it never exists in a fresh clone and never appears in
a git install — something has to build it at the right moment. The package
carries two hooks for two routes, both pointing at `scripts/prepare.mjs`:

| Route | What produces `dist/cli.cjs` |
|---|---|
| `dsh plugin --profile web add @naivg/dsh-network` (npm) | nothing — `prepack` already baked it into the published tarball |
| `dsh plugin --profile web add github:NaivG/dsh-network` (git) | the `prepare` script, run by pnpm during install |
| `dsh plugin --profile web add link:<path>` (link) | you: `pnpm install && pnpm build` |

`scripts/prepare.mjs` skips its build when `dist/cli.cjs` is already newer than
every CLI input (`src/**`, `vite.cli.config.ts`, `package.json`), because npm
runs `prepack` AND `prepare` around a single `npm publish`. Set
`DSH_NETWORK_FORCE_BUILD=1` to bypass that check.

### The npm route

```bash
pnpm test:all
npm publish            # prepack builds dist/; publishConfig.access is public
```

The name is scoped (`@naivg/dsh-network`) because the unscoped `dsh-network` is
taken by an unrelated project. Nothing else changes for that: the plugin id is
the package name verbatim (see below), the CLI binary stays `dsh-network`.

### The git route and `allowBuilds`

`dsh plugin add github:NaivG/dsh-network` is just `pnpm add` with cwd = the
profile — so the only thing that can produce the CLI bundle during that install
is this package's `prepare` script (which skips cleanly when devDeps are
absent). Without it pnpm reports success and every later tool call dies with
`dsh-network CLI bundle is missing` (`assertCliPresent()` in
`dsh/serverClient.js`).

pnpm 12 gates git-dep build scripts behind `allowBuilds`, and for a
git-hosted dep the key must be **spec-qualified** — a bare
`@naivg/dsh-network: true` is rejected with
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. Either pass the flag:

```bash
dsh plugin --profile web add github:NaivG/dsh-network --allow-build=@naivg/dsh-network
```

or put this under `allowBuilds` in the PROFILE's `pnpm-workspace.yaml`
(`~/.dsh/profiles/web/pnpm-workspace.yaml` — not this repo's, which only
governs local dev installs of vite/esbuild). The key is `<name>@<spec>` and
MUST be quoted: `@` cannot start a plain YAML scalar.

```yaml
allowBuilds:
  '@naivg/dsh-network@github:NaivG/dsh-network': true
```

pnpm prints the exact key it wants when it refuses, so copy from there if a
future pnpm changes the shape.

For a link install (`dsh plugin --profile web add link:<path>`) run
`pnpm install && pnpm build` inside the checkout instead.

### Migrating an existing profile after the rename

The rename is not repo-local: a profile that already has the plugin installed
holds the OLD specifier in three places, and dsh resolves the browser bundle by
matching the loader row's specifier against the installed manifest's `name`. A
mismatch returns `undefined` instead of throwing, so the symptom is the
browser half quietly not mounting — no error anywhere.

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": { "@naivg/dsh-network": "link:D:/StudioProjects/dsh-network" },
"dsh": { "profile": { "bundles": [ /* … */ "@naivg/dsh-network" ] } }
```

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml — git installs only
allowBuilds:
  '@naivg/dsh-network@github:NaivG/dsh-network': true
```

Then `pnpm install` in the profile (so `node_modules/@naivg/dsh-network` exists)
and restart dsh. Deleting the old `node_modules/dsh-network` link is optional
but keeps the two from being confused later.

### The plugin id IS the package name

`dsh-client-modules` keys the browser bundle by the installed manifest's `name`
field, verbatim and scope included (`exactPackageSpecifier` → `nearestPackage`
→ `graphRow(packageName, …)`), so `@naivg/dsh-network` is the id in all four
`__ModuleLoader__.load({ id })` calls, the `require(...)` the chunks use, and
the `/plugins/@naivg/dsh-network/<chunk>?rev=…` URL. In `cordis.patch.yml` the
insert row keeps a short free-form `id: dsh-network` (the loader alias, per
`@deepseek-ai/dsh-web-app`'s own patch) and carries the package name in
`name: '@naivg/dsh-network'`.

Everything else deliberately keeps the short name — the locale namespace, the
`settings.section` id, the `searchProvider` / `fetchProvider` ids, the
`/dsh-network/*` routes, `~/.dsh/dsh-network.json`, `DSH_NETWORK_*`, the CLI
binary and the sidebar panel id.

## Misc internals worth knowing while hacking

- **`DSH_NETWORK_CLI`** overrides the CLI bundle path that
  `dsh/serverClient.js` resolves (it otherwise resolves `dist/cli.cjs`
  relative to the plugin's own URL). Tests use it.
- **Client chunk revisions** derive from the ENTRY file's mtime/ctime/size.
  After editing a chunk (`dsh/client.*.js`), touch `dsh/client.js` (or
  reinstall) to bump the rev, otherwise browsers keep the immutable-cached
  old copy.
- **Chunks must be self-contained**: seed words (`react`) and the entry via
  `require('@naivg/dsh-network')` only — never another chunk. Every shared symbol
  must be re-bound from the entry by name; a leftover free variable becomes
  a `ReferenceError` inside React's render, not a load error (see
  [architecture.md](architecture.md)).
- **`engine-config-wiring` and `client-chunks` are the guards for the
  credential chain** — if you rename an env var or a dialog field, those
  two specs are what hold the four hops together.

## Real-network testing etiquette

Real end-to-end runs cost public-engine budget — ask before bulk. The Brave
engine is BILLED PER QUERY (its free tier is gone), so it sits last in the
registry, is absent from the default chain, and the CLI short-circuits a
keyed engine with no key (no request at all until a key exists). `doctor`'s
`apiKeys=[brave=no key]` is how you check that without spending anything;
probing the endpoint without a credential is also free (Brave answers 422
with `header.x-subscription-token: Field required`).

---

See also: [README](../README.md) · [Search engines](search-engines.md) ·
[CLI and cache paging](cli.md) · [Configuration](configuration.md) ·
[Architecture](architecture.md)
