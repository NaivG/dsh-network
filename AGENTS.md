# Project Overview (for AI Agent)

## Goal

Provide the `dsh-network` DeepSeek Harness plugin that replaces the
official `tool-web` (`web_search` / `web_fetch`) and supplies a free,
keyless `http_request` tool. The host keeps ONE persistent `dsh-network
server` child running for its lifetime; every tool call is an HTTP round-trip
to that loopback server. The CLI does the network I/O, parses pages, returns a
structured JSON envelope, and **server-side caches** any body bigger than
~20 KB so large results are paged through `cacheId` instead of truncated
(handbook #717 — child-process stdout chunking is the symptom; the fix is
on the server side). `web_config` adds a model-facing surface to read or
patch the same live config the browser UI edits; its `set` action is
gated by the user-controlled `allowConfigEdit` safety toggle in the
**网络 → 安全** section (off by default). The toggle itself is
intentionally hidden from the model — neither echoed on `get` nor
accepted on `set` — so a botched batched patch can never lock the
model out of its own write path. The user, from the browser, is the
only actor that can flip the toggle.

## Technical Approach

- **Hand-written host plugin** (`dsh/index.js` + the modules it wires,
  plain ESM, no build). The entry owns only the plugin contract exports
  (`name` / `inject`) and `apply()`; the rest is split by concern into
  in-tree modules: `dsh/schemas.js` (JSON Schema outputs + enum
  vocabularies), `dsh/cli-runner.js` (server-client singleton + `runCli`),
  `dsh/evidence.js` (model-facing evidence rendering), `dsh/providers.js`
  (web seam providers), `dsh/tools.js` (the five tool registrations),
  `dsh/routes.js` (loopback routes), `dsh/config-summary.js` (config
  projection / mutation / request fence). All imports are `node:*`
  built-ins and in-tree files. vite's lib mode silently replaces
  `node:*` with browser externals, so the host must stay hand-written.
- **Loopback server-client** (`dsh/serverClient.js`). The host owns
  exactly one persistent `node dist/cli.cjs server` child and talks
  to it over `127.0.0.1:<port>` HTTP. The server announces its port
  via a stdout ready line `{"type":"ready","port":N}`. The client
  respawns on unexpected exit and POSTs `/shutdown` on dispose
  (best effort, SIGTERM → SIGKILL after 1 s).
- **Server-side cache + HTTP routes** (`src/cache.ts`, `src/server.ts`).
  The CLI exposes `POST /invoke` (runs one job with a per-call env
  snapshot), `GET /content?c=&offset=&limit=` (paging a cached body),
  `GET /health`, and `POST /shutdown`. The cache dedups by
  `(fetch|format|url)` / `(http|method|url)` keys, evicts LRU at
  48 entries / 16 MB total chars, expires entries after 5 minutes,
  and degrades any body above the inline cap (default 20 000 chars)
  to a preview + `cacheId` + `contentLength` + `cacheSlice`.
- **Eager server start + Cordis lifecycle binding**. `apply()` calls
  `client.ensure()` so the first user-visible invocation doesn't pay
  the Node + undici + officeparser cold-start cost (~2 s on Windows),
  and registers a `ctx.effect(() => () => client.dispose())` disposer
  so the server dies with dsh. Parent-death detection on the server
  side (`stdinWatch` → `process.stdin.on('end'|'error', shutdown)`)
  catches the case where dsh itself crashes.
- **Per-call env snapshot**. `configToEnv(config)` in
  `dsh/serverClient.js` carries the host's LIVE config (engine order,
  timeouts, allowlist, GitHub token, SearXNG endpoint) on every
  `/invoke` body. UI edits take effect on the next tool call without
  restarting the server.
- **Vite SSR build for the CLI** (`dist/cli.cjs`). Built with
  `vite build --ssr --config vite.cli.config.ts` so `node:*`
  imports stay Node-side. `src/server.ts` is dynamically imported
  by `src/cli.ts` so it lives in a hashed chunk (`dist/server-*.cjs`)
  that the single-shot CLI never loads.
- **Undici + pinned dispatcher** for SSRF. Every redirect hop is
  validated (URL parse → allowlist → DNS → private/reserved IP
  rejection) and pinned to one IP for the socket.
- **Document parsing via officeparser** (`src/document.ts`). The
  transport layer (`client.ts`) recognises a fixed allowlist of
  document MIME types — PDF, OOXML (DOCX/PPTX/XLSX), ODF
  (ODT/ODP/ODS), EPUB — and hands the raw bytes back to fetch.ts,
  which pipes them through `officeparser`'s `ast.to('md')` so the
  model sees clean Markdown. officeparser is loaded via `await import`
  so tesseract.js (and its 80 MB core) stays out of the cold-start
  bundle. OCR is intentionally off; gate it behind a `--ocr` flag if
  a scanned-PDF workload ever shows up.
- **HTML → Markdown stays hand-written** (`src/html.ts`). Real-world
  fetched web pages need a nav/footer/cookie-banner pre-filter that
  officeparser's HTML input format does not provide, and the existing
  108-line converter is tuned for that noise profile. officeparser's
  value is for binary documents, where the noise problem does not exist.
- **Version-locked CLI**. `dsh/serverClient.js` resolves
  `dist/cli.cjs` relative to the plugin's own URL.
  `DSH_NETWORK_CLI` overrides for tests.
- **Cordis patch toppling**. `cordis.patch.yml` sets the `web` seam
  providers to `dsh-network` and disables `tool-web` so our own tools
  do not collide on registration.
- **DSH browser half** (`dsh/client.js` entry + package-local chunks).
  Lazy-CJS module loaded by dsh web; the factory MUST declare its
  `require` parameter. The entry owns the SHARED surface (engine
  constants, `DICTS` i18n, the config API helpers `fetchConfig` /
  `putConfig` / `fetchHealth`, `labelText`, `STYLES`) and `apply()`,
  which loads the surfaces from chunks via the loader's OFFICIAL
  `require.async` protocol (what a bundler's dynamic `import()`
  compiles to): files named `client.<name>.js` next to the entry —
  `client.settings.js` (the "网络" settings section + the legacy
  `settings.plugin.item` card), `client.toolviews.js` (the block
  renderers on `tool.web.item` / `tool.web.fetch.item` for older dsh
  plus the `tool.call.toolview` rows), and `client.searchpanel.js`
  (the sidebar search panel). Chunk rules from
  `@deepseek-ai/dsh-client-modules`: a chunk must be SELF-CONTAINED —
  it may require seed words (`react`) and the entry via
  `require('dsh-network')` (always materialized before a chunk runs),
  never another chunk — and it registers with
  `window.__ModuleLoader__.load({ id, chunk, factory })`. The dsh host
  serves each chunk on demand at
  `/plugins/dsh-network/<chunk>?rev=…` with zero configuration (it
  reads any `client.*.js` sitting in the client entry's directory;
  package.json `files` already ships `dsh/`). Each chunk load is
  caught separately, so one failed surface never takes the others
  down. Per-plugin revisions derive from the ENTRY file's
  mtime/ctime/size: after editing a chunk, touch `dsh/client.js` (or
  reinstall) to bump the rev, otherwise browsers keep the
  immutable-cached old copy.
- **Search answer contract** (`dsh/providers.js` `makeSearchProvider`). The
  seam hands a provider one `content` per query, and dsh's own
  `tool-web` merges every query of one call into a single card: it
  wraps each query's `content` in a `### <query>` heading and pools all
  sources into ONE list capped at `searchMaxResults`, interleaved
  round-robin. Returning only the CLI summary therefore rendered two
  empty headings above an A/B/A/B list and hid every source past the cap
  (a 4-query call lost 3/4 of its hits, for the model too). The provider
  now renders **this query's full hit list** into `content`, so each
  `###` section is self-contained; `sources` still carries the complete
  set for any other consumer. Each hit is TWO lines —
  `N. [title](url)` closed by a GFM hard break (two trailing spaces; a
  bare `\n` is a soft break and renders as a space in dsh's markdown
  renderer) with the snippet/date indented four spaces on the next line —
  so the card shows a blue link with its description on a second line,
  and the sections join on blank lines so the trailing `Uncertain:` note
  can never lazy-continue the last list item (`tests/search-source-format.spec.ts`
  pins the whitespace).
- **Search card override** (`dsh/client.toolviews.js` `SearchToolview`).
  `tool.call.toolview` is a KEYED slot: one cell per tool name, only the
  **lowest-priority** live entry of a cell renders, and re-registering a
  key at an already-taken priority **throws**. dsh claims `web_search`
  at the default priority 0, so the plugin claims `-900` to shadow the
  native row; the registration is try/caught so an upstream change can
  never take the whole browser half down. The row renders the
  per-query answer and deliberately does NOT re-render the pooled source
  list; it falls back to a plain source list for this plugin's own
  `web_search` meta (`{engine, status, sources}` — no `answer`).
  Style-wise the row is composed to read like a first-party dsh tool card:
  a borderless disclosure row (16px leading box whose globe crossfades to a
  chevron on hover, 13px title, 2px dot separators, one ellipsing summary)
  over a WebBlock-styled body card. The rules are copied from dsh's own
  DisclosureRow / ToolRow / WebBlock module CSS under `dshn-` class names
  (injected once per document) because the upstream hashed classes are
  internal to the dsh bundle; primitives exports (TextShimmer, flow icons,
  LinkIconMedium) are used when present with identical inline-SVG fallbacks.
  Arguments are read via `argsOf`: a settled dsh block carries its arguments
  ONLY as the raw JSON string `block.call.argsRaw` (the native rows
  JSON.parse it — there is no pre-parsed `call.args`), with a literal
  `call.args` fallback for hosts/tests. Reading `call.args` alone is what
  once hid the "N 个查询" bit from the multi-query header. A settled block
  is detected by meta PRESENCE (a finished zero-hit call persists a meta
  object), not by hit count — the old test left such calls showing
  搜索中… forever.
- **Markdown rendering in the tool cards** (`dsh/client.js` `isRenderable`
  + `markdownLabels`, consumed by `client.toolviews.js` and
  `client.searchpanel.js`). Every answer/body string the rows show
  (`meta.answer`, the `web_sitemap` digest, the search panel's summary) goes
  through the host's `ui.MarkdownText` primitive. That primitive MUST be
  detected with `isRenderable(value)`, never `typeof value === 'function'`:
  dsh exports `MarkdownText` / `TextShimmer` through `React.memo`, so the
  shipped value is a memo object (`{ $$typeof: Symbol(react.memo), type,
  compare }`) and the function-only test silently evaluated FALSE on every
  build. The rows then took the raw-text `<pre>` fallback and the card showed
  literal `### <query>`, `[title](url)` and `&nbsp;` in a proportional font
  while the plain icons (real functions) kept working — the "web search does
  not render" defect. `isRenderable` accepts functions, memo / forwardRef /
  lazy tag objects and `render`-carrying objects, and rejects null, plain
  objects and the strings of the degraded `{ Input: 'input' }` host surface.
  `MarkdownText` also requires its `labels` seats (dsh's own
  `markdownLabels(t)`); they are read lazily (only a code fence touches
  `labels.code.copyLabel`, only a footnote `labels.footnotes`), and the entry
  supplies them per locale so a memo-wrapped renderer never throws on a
  missing seat.
- **Sidebar search panel** (`dsh/client.searchpanel.js` `SearchPanelPage` +
  `dsh/routes.js` `registerSearchRoute`). A search-engine-style page behind
  a sidebar rail entry, built on the same two-registration protocol the
  built-in plugins (order 0) and schedules (order 10) panels use: an icon
  in the root-scoped `sidebar.panellist` list slot with
  `{ id: 'dsh-network-search', order: 20, label }`, and the page component
  registered into the layout's root-scoped KEYED `main` slot under the
  same key — `layout.selectPanel(id)` validates the key against `main`
  entries, so id and key must match. The page POSTs
  `{ query, count, engine }` to the host's `/dsh-network/search` route
  (fenced by `isTrustedRequest` like the config route; `GET ?q=` is also
  accepted) which runs the SAME `runCli(['search', …])` path as the
  `web_search` tool — live engine chain, per-call env snapshot. The route
  is dynamically gated by `config.webSearchTool`, and `applyCardSettings`
  now honors the tool toggles (`webSearchTool` etc.) via the config PUT —
  previously the settings page's toggles were silently dropped on write.
  The panel only mounts after the `/dsh-network/config` probe proves the
  host plugin is present AND `webSearchTool !== false` in the summary; hit
  results render as cards (title link target=_blank, host, snippet, date)
  under the engines' summary, and panel state (last query/results/history)
  survives unmounts in a module-level cache so peeking at the conversation
  never loses results.
- **Single responsibility**. This package owns live web (search +
  fetch + http + document parsing). Image parsing lives in `modlens`.
- **Search engine registry**. Each engine lives in its own file under
  `src/engines/` with a URL builder, parser, and header profile. The
  CLI iterates engines via `SearchEngineRegistry`. The legacy
  `search-engines.ts` is a thin re-export shim for backward
  compatibility. SearXNG is a self-hosted JSON-API engine: its
  endpoint is read from `DSH_NETWORK_SEARXNG_URL`, and private-
  network access is granted only when the configured endpoint is
  itself loopback/private.

```bash
pnpm install          # runs `prepare` → builds dist/cli.cjs automatically
pnpm build   # vite SSR build → dist/cli.cjs + dist/server-*.cjs
```

- **`prepare` is mandatory for git installs.** `dist/` is gitignored and
  `dsh plugin add github:NaivG/dsh-network` is just `pnpm add` with cwd = the
  profile, so the only thing that can produce the CLI bundle during that
  install is this package's `prepare` script (`scripts/prepare.mjs`). Without
  it pnpm reports success and every later tool call dies with
  `dsh-network CLI bundle is missing` (`assertCliPresent()` in
  `dsh/serverClient.js`). pnpm 12 gates git-dep build scripts behind
  `allowBuilds`, and for a git-hosted dep the key must be **spec-qualified** —
  `dsh-network: true` is rejected with
  `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. Use
  `dsh plugin --profile web add github:NaivG/dsh-network --allow-build=dsh-network`,
  or put `dsh-network@github:NaivG/dsh-network: true` under `allowBuilds` in
  `~/.dsh/profiles/web/pnpm-workspace.yaml` (not this repo's — that one only
  governs local dev installs of vite/esbuild).

## Code Organization

```
dsh-network/
├── package.json                # main: ./dsh/index.js, bin: ./dist/cli.cjs, prepare → scripts/prepare.mjs
├── cordis.patch.yml            # topples web seam + tool-web + inserts row
├── vite.cli.config.ts          # SSR build for the CLI
├── scripts/prepare.mjs         # git-install build hook: vite build, skips cleanly when devDeps are absent
├── dsh/
│   ├── index.js                # host plugin ENTRY: contract exports (name/inject) + apply() wiring (eager server start, providers/tools/routes)
│   ├── schemas.js              # host: JSON Schema outputs + enum vocabularies (extracted by tests/schema-check.mjs)
│   ├── cli-runner.js           # host: server-client singleton + runCli/runCliSoft + releaseNetworkClient
│   ├── evidence.js             # host: model-facing evidence rendering + GFM source items + compactPresentation
│   ├── providers.js            # host: web seam providers (makeSearchProvider / makeFetchProvider)
│   ├── tools.js                # host: the five ctx.tools.register blocks (web_search/web_fetch/http_request/web_config/web_sitemap)
│   ├── routes.js               # host: /dsh-network/config|health|search loopback routes
│   ├── config-summary.js       # host: summarize / summarizeForModel / applyCardSettings / isTrustedRequest / defaultConfig
│   ├── serverClient.js         # host ↔ loopback server client (ensure/invoke/health/dispose)
│   ├── client.js               # browser ENTRY: shared surface (DICTS i18n, config API helpers, STYLES, engine lists) + apply() wiring via require.async
│   ├── client.settings.js      # browser chunk: "网络" settings section + legacy Plugins-tab card (+ all UI primitives only they use)
│   ├── client.toolviews.js     # browser chunk: tool.call.toolview rows + legacy tool.web.* block renderers + dshn-* styles
│   ├── client.searchpanel.js   # browser chunk: sidebar search panel (sidebar.panellist + keyed main) + its module-level state cache
│   ├── persist.js              # durable config store (~/.dsh/dsh-network.json, atomic write)
│   └── spawnHidden.js          # child-process boundary used by serverClient (single child)
├── src/
│   ├── cli.ts                  # CLI entry: argv parsing → search/fetch/http/sitemap/doctor + runOnce() for the server
│   ├── server.ts               # loopback HTTP server: /invoke, /content, /health, /shutdown + parent-death watcher
│   ├── cache.ts                # ResultCache: dedup, LRU, inline-cap degrade, slice() paging
│   ├── client.ts               # RAW transport: undici fetch + pinned-dispatcher SSRF
│   ├── fetch.ts                # web_fetch formatting layer: client → markdown/raw + links/title
│   ├── http_request.ts         # undici-direct low-level HTTP path (reuses client SSRF primitives)
│   ├── sitemap.ts              # web_sitemap: curated portals table (~90 domains) lookup + digest
│   ├── network.ts              # URL/IP helpers, allowlist, fetch error classification
│   ├── html-extract.ts         # HTML → visible text + links (raw helpers)
│   ├── html.ts                 # HTML → Markdown (web pages; nav/footer pre-filter)
│   ├── document.ts             # document parser: PDF/OOXML/ODF/EPUB → Markdown via officeparser
│   ├── search-engines.ts       # BACKWARD-COMPAT shim → re-exports from ./engines
│   ├── config.ts               # CLI-side runtime config (env knobs)
│   └── engines/                # search engine registry + per-engine implementations
│       ├── types.ts            # SearchEngine interface, SearchEngineRegistry, helpers
│       ├── header-profiles.ts  # Firefox-127 baseline + per-engine overlays
│       ├── bing.ts             # BingSearchEngine
│       ├── duckduckgo.ts       # DuckDuckGoSearchEngine
│       ├── baidu.ts            # BaiduSearchEngine
│       ├── github.ts           # GitHubSearchEngine (hybrid REST, RRF fusion)
│       ├── searxng.ts          # SearxngSearchEngine (self-hosted JSON API)
│       └── index.ts            # barrel + registerDefaultEngines()
├── tests/
│   ├── network.spec.ts         # vitest, zero-network unit tests
│   ├── cache.spec.ts           # vitest, ResultCache (dedup, slice, eviction, degrade)
│   ├── host-cache-slice.spec.ts# vitest, host-side cacheSlice pass-through contract
│   ├── presentationmeta.spec.ts# vitest, presentation_metadata envelope fields
│   ├── client-toolview.render.spec.ts # vitest, browser half: mock module loader +
│   │                           # react-dom/server — renders the real toolview chunks and
│   │                           # pins memo-aware MarkdownText / TextShimmer detection
│   ├── schema-check.mjs        # node guard: tool schemas in the dsh host modules pass dsh-tools' subset (skips when dsh absent)
│   ├── persist-smoke.mjs       # node smoke test for the durable config store (host half)
│   └── server-smoke.mjs        # node smoke test for the loopback server (echo → /invoke → cache paging → /shutdown)
└── dist/
    ├── cli.cjs                 # built CLI binary (vite SSR)
    └── server-*.cjs            # hashed server chunk (dynamic import of src/server.ts)
```

## CLI

```bash
dsh-network search  -q "typescript 5.9 release notes"
dsh-network fetch   -u "https://example.com/docs"               --cache-id <id> --offset 4000 --limit 4000
dsh-network         -X GET https://api.example.com/v1/users     --cache-id <id> --offset 0 --limit 4000
dsh-network web_sitemap --query "github" --domain github.com
dsh-network doctor                                                 # no network
dsh-network server   [--port <n>]                                 # persistent loopback server (host uses this)
```

- `fetch` / `-X` modes automatically store any body above the inline
  cap (~20 KB by default) on the server and return a `cacheId` +
  `contentLength` + preview. Pass `--cache-id` (with optional
  `--offset` / `--limit`) to page through the remainder without
  re-issuing the request.
- `doctor` reports resolved config without contacting anything;
  useful in CI and as the host-side `readiness` probe.
- `server` is the long-lived mode the host spawns once and reuses
  for every tool call. It announces its port on stdout as
  `{"type":"ready","port":N}`.

## Cache Paging

The server keeps an LRU cache of results (default cap: 48 entries /
16 MB total chars, 5-minute TTL). When a fetch/http body exceeds the
inline cap (default 20 000 chars) the server returns:

```jsonc
{
  "status": "ok",
  "content":   "<first 20000 chars preview>…",
  "cacheId":   "abc123",
  "contentLength": 175432,
  "cacheSlice": { "offset": 0, "limit": 20000, "total": 175432 }
}
```

…and the host tools (`web_fetch` / `http_request`) pass those
fields through to the model. To page further, the model re-invokes
the same tool with `cacheId` + optional `offset` / `limit`
(instead of `url`); `url` and `cacheId` are mutually exclusive.

`web_search` and `web_sitemap` don't page — their result lists
are bounded by `--max-results` (default 10, hard cap 20).

## Verification

- `pnpm test` for the pure-module unit suite (~127 cases — vitest,
  runs in ~3 s, no network). `tests/client-toolview.render.spec.ts`
  covers the browser half: it materializes the REAL `dsh/client.js`
  and `dsh/client.toolviews.js` through a mock of
  `@deepseek-ai/dsh-client-modules` (`window.__ModuleLoader__.load`,
  factory return value = record exports) with `react` as the only seed
  word, then renders the rows with `react-dom/server`. It pins the
  memo-aware `isRenderable` contract (a memo-shaped `MarkdownText`
  must be USED, not bypassed) and the degraded `{ Input }` fallback.
  Only `react` + `react-dom` are needed — `MarkdownText` itself is
  stubbed, so no dsh install is required.
- `pnpm run test:server` for the loopback server smoke
  (`tests/server-smoke.mjs`, plain node): spawns the built
  `dist/cli.cjs server`, points it at a local 25 000-char echo
  server, asserts that `fetch` returns a degraded preview with a
  `cacheId`, that paging with `--offset 1000 --limit 500` returns
  the expected slice, that `/health` shows the cached entry, and
  that `/shutdown` exits cleanly with code 0.
- `pnpm run test:persist` for the durability smoke test
  (`tests/persist-smoke.mjs`, plain node): snapshots save/load
  atomically, corrupt/missing files degrade with a warning, and a
  full fake-host round-trip (apply → PUT → restart → GET) proves UI
  edits survive restarts, secrets included, `enabled` kill-switch
  excluded; also probes the `/dsh-network/search` route contract
  (fence 403, missing query 400, bad count 400, wrong method 405,
  and the `webSearchTool` kill-switch gating the route).
- `pnpm run test:schema` for the tool-schema guard
  (`tests/schema-check.mjs`, plain node): extracts every `parameters` /
  `output.schema` block from the dsh host modules (the constants live in
  `dsh/schemas.js`, the tool registrations in `dsh/tools.js`; the guard
  scans all host-side files concatenated so a future move stays green)
  and asserts they pass `dsh-tools.assertSupportedJsonSchema`. Locates
  dsh-tools via `DSH_TOOLS_PATH` or the npm/pnpm global root; skips with
  exit 0 when the harness is not installed. The `parameters` regex
  matches line breaks as `\r?\n` on purpose: with `core.autocrlf=true`
  the working tree is CRLF and a bare `\n` silently matched ZERO blocks
  on Windows, turning the guard into a no-op.
- `pnpm run test:all` runs the unit suite, all three smokes, and the
  schema guard in one go.
- `pnpm build` to produce `dist/cli.cjs` + `dist/server-*.cjs`;
  smoke-test with `node ./dist/cli.cjs -u https://example.com/ --allow-private-network`.
- Real end-to-end runs cost public-engine budget: ask before bulk.

## Operational Notes

- `dsh-network doctor` is the canonical readiness probe and is safe to
  invoke offline.
- The `/dsh-network/config` HTTP route registered on `ctx.webServer`
  honors the same loopback + `sec-fetch-site: same-origin` + Origin ==
  Host fence dsh's own `/api` uses; the browser card therefore can be
  served from the same origin without leaking to cross-site pages.
- The `/dsh-network/search` route (sidebar search panel backend) sits
  behind the same fence and is additionally gated by the LIVE
  `config.webSearchTool` toggle — flipping 网络 → 工具 → 网络搜索 off
  answers 403 immediately and the `web_search` tool's next execute
  throws, so one switch disables both the model-facing tool and the
  user-facing panel without a reload.
- The browser half (the "网络" settings section and the legacy card)
  reads/writes the live `config` object the host's `apply()` owns;
  there is deliberately NO `dsh-network` settings namespace — a
  registered namespace would be persisted to the settings document,
  but the runtime reads the cordis row config + in-memory edits, so a
  `settings.yaml` section would silently do nothing.
- Durability comes from `dsh/persist.js`, not the settings document:
  every successful UI save atomically snapshots the live config to
  `~/.dsh/dsh-network.json` (`DSH_NETWORK_CONFIG_FILE` overrides), and
  `apply()` reloads it at boot — the persisted snapshot wins over the
  cordis row config (which stays the seed for a fresh install). Delete
  the file to reset to row config. `enabled` is never persisted and is
  stripped from any hand-written file: the row config is the only
  kill-switch. Secrets (`githubToken`, engine API keys) ride in the
  file like other plugins' keys in `settings.yaml`; the browser still
  only sees `hasApiKey`. A corrupted file is ignored with a warning.
- The loopback server (`dist/cli.cjs server`) is the ONLY child
  process the host spawns. `apply()` calls `client.ensure()` so the
  first user-visible tool call doesn't pay the cold-start cost;
  `ctx.effect(() => () => client.dispose())` binds its lifetime to
  the cordis fiber. If the host crashes outright, the server's stdin
  pipe closes and the `stdinWatch` handler in `src/server.ts` exits
  it. `client.invoke()` respawns on unexpected death.
