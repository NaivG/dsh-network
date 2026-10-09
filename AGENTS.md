# Project Overview (for AI Agent)

## Goal

Ship the `dsh-network` DeepSeek Harness plugin: it replaces the official
`tool-web` (`web_search` / `web_fetch`) and adds a free, keyless
`http_request` tool. The host keeps ONE persistent `dsh-network server`
child alive for its lifetime; every tool call is an HTTP round-trip to that
loopback server. The CLI does the network I/O and **server-side caches** any
body bigger than ~20 KB, so large results page through `cacheId` instead of
being truncated (handbook #717 — child-process stdout chunking is the
symptom, the server-side cache is the fix). `web_config` reads/patches the
same live config the browser UI edits, gated by a user-controlled safety
toggle the model can neither read nor set.

Everything user-facing (install, config fields, engine catalog, CLI
reference, code layout) lives in [`docs/`](docs/README.md). This file holds
only what you need to **change the code without breaking it**.

## Architecture

- **Hand-written host plugin** (`dsh/index.js`, plain ESM, no build). The
  entry owns only the contract exports (`name` / `inject`) and `apply()`; the
  rest is split by concern into `dsh/schemas.js`, `cli-runner.js`,
  `evidence.js`, `providers.js`, `tools.js`, `routes.js`,
  `config-summary.js`. It must stay hand-written — vite's lib mode silently
  replaces `node:*` with browser externals.
- **Loopback server-client** (`dsh/serverClient.js`). Exactly one persistent
  `node dist/cli.cjs server` child, spoken to over `127.0.0.1:<port>`; the
  server announces its port on stdout as `{"type":"ready","port":N}`.
  `ensure()` spawns it (eagerly from `apply()`), and if the child dies the
  next `invoke()` respawns it; `dispose()` POSTs `/shutdown`, then
  SIGTERM → SIGKILL after 1 s.
- **Server-side cache + routes** (`src/cache.ts`, `src/server.ts`):
  `POST /invoke` (one job + per-call env snapshot), `GET /content` (paging),
  `GET /health`, `POST /shutdown`. The cache dedups by
  `(fetch|format|url)` / `(http|method|url)`, evicts LRU at 48 entries /
  16 MB / 5-minute TTL, and degrades any body over the inline cap
  (20 000 chars) to a preview + `cacheId` + `contentLength` + `cacheSlice`.
- **Eager start + lifetime binding.** `apply()` calls `client.ensure()` so the
  first tool call doesn't pay the ~2 s cold start, and registers
  `ctx.effect(() => () => client.dispose())`. If dsh itself crashes, the
  server's stdin pipe closes and `stdinWatch` (`process.stdin.on('end'|'error')`)
  exits it.
- **Per-call env snapshot.** `configToEnv(config)` carries the host's LIVE
  config (engine order, timeouts, allowlist, GitHub token, SearXNG endpoint,
  engine keys, engine options) on every `/invoke`, so UI edits land on the
  next tool call with no server restart.
- **Vite SSR build for the CLI** (`dist/cli.cjs`, `vite.cli.config.ts`) so
  `node:*` imports stay Node-side. `src/server.ts` is dynamically imported by
  `src/cli.ts`, so it lands in a hashed chunk (`dist/server-*.cjs`) that the
  single-shot CLI never loads.
- **Undici + pinned dispatcher** for SSRF: every redirect hop is validated
  (URL parse → allowlist → DNS → private/reserved IP rejection) and pinned to
  one IP for the socket. No shelling out to `curl.exe` / `nslookup.exe`.
- **Documents via officeparser** (`src/document.ts`). `client.ts` recognises a
  fixed MIME allowlist (PDF, OOXML, ODF, EPUB) and returns raw bytes, which
  `fetch.ts` pipes through `officeparser`'s `ast.to('md')`. Loaded via
  `await import` so tesseract.js stays out of the cold-start bundle. OCR is
  intentionally off.
- **HTML → Markdown stays hand-written** (`src/html.ts`): real web pages need
  a nav/footer/cookie-banner pre-filter that officeparser's HTML input does
  not provide. officeparser is for binary documents, where that noise profile
  does not exist.
- **Version-locked CLI**: `serverClient.js` resolves `dist/cli.cjs` relative
  to the plugin's own URL; `DSH_NETWORK_CLI` overrides it for tests.
- **Cordis patch toppling** (`cordis.patch.yml`): pins both `web` seam
  providers to dsh-network and disables `tool-web`, so tool names never
  collide (the tools registry refuses duplicates).
- **Single responsibility**: this package owns live web (search + fetch +
  http + document parsing). Image parsing lives in `modlens`.

## Invariants — change these carefully

### Entity decoding is ONE helper, at the CLI boundary

`src/html-extract.ts` `decodeEntities` / `cleanHtmlText`, re-exported to the
engines as `cleanText`. Source markup is entity-encoded (a Bing date is
literally `Aug 19, 2026&nbsp;&#0183;&#32;DeepSeek`) and nothing downstream
can rescue a raw reference — the renderer prints `&nbsp;` as six characters
and the model reads it as content and reproduces it in its reply. Stripping
and decoding are therefore ONE step, and every text extraction (engine
titles/snippets, link labels, the visible-text pass, `htmlToMarkdown`'s final
pass) goes through the same table. The rules that are load-bearing:

- **One pass, or the escaped text re-enters as markup.** Each reference is
  resolved exactly once against the ORIGINAL string, so `&amp;lt;` yields
  `&lt;` and never a `<`. `htmlToMarkdown` decodes once at the very END,
  after `stripTags`, for that same reason.
- **The whitespace pass runs even with no `&` in the string.** A fast path
  guarding on `includes('&')` silently skips U+00A0 normalization whenever
  the space is a raw character rather than an entity. The guard belongs on
  the reference pass only.
- **Unicode whitespace becomes a space, invisible characters are deleted**
  (`\u00a0` / `\u2000-\u200a` / `\u3000` → `' '`;
  `\u200b\u200c\u200d\u2060\ufeff\u00ad` → `''`), so `**&nbsp;a**` still
  renders bold and a zero-width space cannot hide inside a keyword.
  U+200E / U+200F are deliberately KEPT — they carry bidi intent, and
  dropping them flips reading order in the rendered card.
- **Unknown references stay visible** instead of being blanked, and numeric
  references outside the scalar range (surrogates, > U+10FFFF, `&#0;`) emit
  nothing rather than a lone surrogate that would break the UTF-8 encode.
- The table is a hand-curated ~130 lowercase names, NOT the full HTML5 set
  (2231 — the tail is math/emoji codepoints that never appear in result
  markup). Lookup lowercases first, so `&NBSP;` still decodes.
- The host half deliberately does NOT decode (`dsh/evidence.js` is a pure
  pass-through): a second decode would corrupt a snippet whose content IS an
  entity example. Mind this boundary when adding a format.
- `extractVisibleTextFromHtml` reads `<title>` BEFORE it drops `<head>`.

### Keyed engines and the credential chain

An engine declares `auth = { header, scheme, apiKeyEnv }` (Brave:
`X-Subscription-Token`; GitHub's Bearer token folds into the same map). The
CLI — never the engine — holds the secret: it resolves
`DSH_NETWORK_SEARCH_ENGINE_API_KEYS[engineId]` (a JSON map `configToEnv()`
packs into every `/invoke`), falls back to the engine's single-engine
`apiKeyEnv`, then to the legacy `DSH_NETWORK_GITHUB_TOKEN`, and injects the
header. Engines only ever see `hasApiKey`. With no key the CLI sends NO
request at all: it synthesizes a 401 body so "no credential" and "rejected
credential" classify on one code path.

The chain has FOUR hops, and they are only correct together:

```
browser dialog → commitEngineDialog (PUT patch)
              → applyCardSettings (fills config.searchEngineApiKeys)
              → configToEnv (packs the map onto /invoke)
              → CLI resolves the credential and injects the header
```

- **`hasApiKey` is a VIEW of the key map, never a stored claim.** Both
  `summarize()` and `applyCardSettings` derive it from
  `searchEngineApiKeys[id]`, so a drifted `true` heals on the next save.
  `summarize()` also unions the key map into its iteration, so an engine
  holding a key but no `searchEngineConfigs` entry (row config, hand-written
  `config.yaml`) stays visible — the real order of operations is "paste the
  key, THEN add the engine to the chain".
- **The key is write-only**: `stripApiKeys` removes it from the draft once the
  save lands, so later debounced saves never re-send a plaintext copy. The
  browser only ever reads back `hasApiKey`.
- **`tests/engine-config-wiring.spec.ts`** pins the env-var NAMES on both
  sides — a rename on one side alone degrades silently to "unset".
  **`tests/client-chunks.spec.ts`** drives the real dialog (react-dom/server
  drops handlers, so it uses a recording `createElement` spy to reproduce
  typing and saving). Those two specs are what hold the four hops together.

### Per-engine options

`DSH_NETWORK_ENGINE_OPTIONS` carries the settings dialog's free-form
`key=value` textarea as `{ engineId: { … } }`; an engine reads its own slice
with `readEngineEnvOptions(id)` (pure, never throws) and validates every
field itself before it reaches a URL, so a typo cannot burn a billed call on
a 422. `buildBraveUrl` is the reference: unknown keys and out-of-vocabulary
values are dropped, `count` comes from the call cap (`perPage`, clamped to
Brave's 20) with `max` as the standalone fallback, and `extra_snippets=true`
is always on so `page_age` / extra excerpts reach `published_at` and the
snippet. Brave's `plausiblePublishedAt` accepts only an ISO-8601 timestamp
whose year lands in [1990, next year] — upstream returns epoch-seconds read
as ms, and a wrong date in the evidence is worse than no date.

### `web_search` is NOT cached

Only fetch/http bodies are, so two identical searches in one turn bill the
engine twice. Known and accepted: a search cache needs an explicit
invalidation story, and a stale hit list is its own defect. Revisit only if a
billed engine joins the DEFAULT chain.

### Browser half: chunks

`dsh/client.js` is the browser entry; surfaces load from `client.<name>.js`
chunks via the loader's OFFICIAL `require.async` protocol:
`client.settings.js` ("网络" section + legacy card), `client.toolviews.js`
(block renderers + `tool.call.toolview` rows), `client.searchpanel.js`
(sidebar panel). The entry owns the shared surface (engine constants,
`DICTS`, `fetchConfig` / `putConfig` / `fetchHealth`, `labelText`, `STYLES`).

A chunk must be SELF-CONTAINED: seed words (`react`) and the entry via
`require('dsh-network')` only — never another chunk — and it registers with
`window.__ModuleLoader__.load({ id, chunk, factory })`. **A chunk has no view
of the entry's file scope**, so every shared symbol (`ENGINES`,
`ENGINE_LABELS`, …) must be re-bound from the `require('dsh-network')` object
by name. A leftover free variable is not a syntax error, load error or
warning: the chunk registers, materializes and exports happily, then throws
`ReferenceError` inside React's render and takes the whole section down.
`tests/client-chunks.spec.ts` guards this statically (TypeScript `checkJs`
unresolved names) and dynamically.

Per-plugin revisions derive from the ENTRY file's mtime/ctime/size: after
editing a chunk, touch `dsh/client.js` (or reinstall) to bump the rev,
otherwise browsers keep the immutable-cached old copy.

### Search answer contract

`dsh/providers.js` `makeSearchProvider`. dsh's own `tool-web` wraps each
query's `content` in a `### <query>` heading and pools ALL sources into one
list capped at `searchMaxResults`, round-robin — so a provider returning
only a summary renders empty headings above a truncated list. The provider
therefore renders **each query's full hit list** into `content`, making every
`###` section self-contained; `sources` still carries the complete set for
any other consumer. Whitespace is part of the contract
(`tests/search-source-format.spec.ts` pins it): each hit is TWO lines —
`N. [title](url)` closed by a GFM hard break (two trailing spaces; a bare
`\n` renders as a space) with the snippet/date indented four spaces on the
next — and sections join on blank lines so a trailing `Uncertain:` note can
never lazy-continue the last list item.

### Toolview rows

- `tool.call.toolview` is a KEYED slot: one cell per tool name, only the
  **lowest-priority** live entry renders, and re-registering a key at an
  already-taken priority **throws**. dsh claims `web_search` at priority 0,
  so the plugin claims `-900`; the registration is try/caught so an upstream
  change can't take down the browser half. Styling is composed to read like
  a first-party dsh card under `dshn-` class names, because the upstream
  hashed classes are internal to the dsh bundle.
- Read arguments via `argsOf`: a settled dsh block carries them ONLY as the
  raw JSON string `block.call.argsRaw` (there is no pre-parsed `call.args`),
  with a literal `call.args` fallback for hosts/tests.
- A settled block is detected by meta PRESENCE (a finished zero-hit call
  persists a meta object), never by hit count.
- Every answer/body string goes through the host's `ui.MarkdownText`,
  detected with `isRenderable(value)` — NEVER `typeof value === 'function'`.
  dsh exports it through `React.memo`, so the shipped value is a memo object
  and a function-only test silently falls through to the raw-text `<pre>`
  fallback. `isRenderable` accepts functions, memo / forwardRef / lazy tags
  and `render`-carrying objects; it rejects null, plain objects and the
  strings of the degraded `{ Input: 'input' }` host surface. `MarkdownText`
  also needs its `labels` seats, which the entry supplies per locale.

### Sidebar search panel

`client.searchpanel.js` + `registerSearchRoute`, on the same two-registration
protocol the built-in (order 0) and schedules (order 10) panels use: an icon
in the root-scoped `sidebar.panellist` list slot `{ id: 'dsh-network-search',
order: 20, label }`, plus the page component in the layout's root-scoped KEYED
`main` slot under the SAME key (`layout.selectPanel(id)` validates them
against each other). The page POSTs `{ query, count, engine }` to
`/dsh-network/search`, which runs the SAME `runCli(['search', …])` path as
the `web_search` tool. The panel mounts only after a `/dsh-network/config`
probe proves the host is present AND `webSearchTool !== false`; state
survives unmounts in a module-level cache.

### Config, routes and persistence

- The `/dsh-network/config` and `/dsh-network/search` routes sit behind
  `isTrustedRequest` — the same loopback + `sec-fetch-site: same-origin` +
  Origin == Host fence dsh's own `/api` uses. `/dsh-network/search` is also
  gated by the LIVE `config.webSearchTool`, so one switch disables both the
  model-facing tool and the user-facing panel without a reload.
- The browser half reads/writes the live `config` object `apply()` owns. There
  is deliberately NO `dsh-network` settings namespace — the runtime reads the
  cordis row config + in-memory edits, so a `settings.yaml` section would
  silently do nothing.
- Durability comes from `dsh/persist.js`, not the settings document: every
  successful save atomically snapshots to `~/.dsh/dsh-network.json`
  (`DSH_NETWORK_CONFIG_FILE` overrides) and `apply()` reloads it at boot. The
  snapshot wins over the cordis row config (the seed for a fresh install);
  delete the file to reset. `enabled` is never persisted — the row config is
  the only kill-switch. Secrets ride in the file; a corrupted one is ignored
  with a warning.
- `web_config`'s `set` is gated by the user-controlled `allowConfigEdit`
  toggle in **网络 → 安全** (off by default), which is hidden from the model
  on both `get` and `set` so a botched batched patch can never lock the model
  out of its own write path.

## CLI

```bash
dsh-network search  -q "typescript 5.9 release notes"
dsh-network fetch   -u "https://example.com/docs"      --cache-id <id> --offset 4000 --limit 4000
dsh-network         -X GET https://api.example.com/v1/users
dsh-network web_sitemap --query "github" --domain github.com
dsh-network doctor                                     # no network
dsh-network server   [--port <n>]                     # long-lived mode the host spawns
```

`fetch` / `-X` store any body over the inline cap on the server and return a
`cacheId` + `contentLength` + preview; re-invoke with `--cache-id` (plus
optional `--offset` / `--limit`) to page without re-issuing the request —
`url` and `cacheId` are mutually exclusive. `web_search` / `web_sitemap` don't
page; their lists are bounded by `--max-results` (default 10, cap 20). Full
reference in [docs/cli.md](docs/cli.md).

## Verification

| Command | Runs |
|---|---|
| `pnpm test` | vitest unit suite, zero network, ~6 s |
| `pnpm run test:server` | loopback server smoke (degrade → page → `/health` → `/shutdown`) |
| `pnpm run test:persist` | durable store + `/dsh-network/search` route contract |
| `pnpm run test:schema` | tool schemas pass `dsh-tools.assertSupportedJsonSchema` (skips cleanly without dsh) |
| `pnpm run test:all` | all of the above |

Notes worth carrying:

- The entity block (`decodeEntities`, `cleanHtmlText`, per-engine parser
  decode, `htmlToMarkdown` decode) is the fence around the `&nbsp;`-in-a-card
  class of defect; the end-to-end case asserts no `&…;` reference survives ANY
  of the three scraped engines.
- `tests/client-chunks.spec.ts` and `tests/engine-config-wiring.spec.ts` are
  the credential-chain guards — run them whenever you touch the engine dialog,
  `summarize()`, `applyCardSettings` or `configToEnv`.
- `tests/schema-check.mjs` matches line breaks as `\r?\n` on purpose: with
  `core.autocrlf=true` the tree is CRLF and a bare `\n` matches ZERO blocks on
  Windows, silently turning the guard into a no-op. Don't "simplify" it.
- `dist/` is gitignored, so a git install can only build via the `prepare`
  hook — `dsh plugin add github:NaivG/dsh-network` reports success and every
  later tool call dies with `dsh-network CLI bundle is missing` without it.
  pnpm 12 also needs a **spec-qualified** `allowBuilds` key. See
  [docs/development.md](docs/development.md#git-installs-and-the-prepare-hook).
- Real end-to-end runs cost public-engine budget — ask before bulk. Brave is
  BILLED PER QUERY (its free tier is gone), sits last in the registry and is
  absent from the default chain; `doctor`'s `apiKeys=[brave=no key]` checks it
  for free, as does probing the endpoint without a credential (422,
  `header.x-subscription-token: Field required`).

## Layout

`dsh/` host half (hand-written ESM) · `dsh/client*.js` browser half ·
`src/` CLI (vite SSR → `dist/cli.cjs`) · `tests/` vitest specs + plain-node
smokes. Per-file roles, the engine catalog and the config field reference are
in [docs/development.md](docs/development.md),
[docs/architecture.md](docs/architecture.md),
[docs/search-engines.md](docs/search-engines.md) and
[docs/configuration.md](docs/configuration.md).