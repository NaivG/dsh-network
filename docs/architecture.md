# Architecture

Internal design notes for `dsh-network` — how the host plugin, the loopback
server, and the browser half fit together. For installation and usage see the
[README](../README.md); for the operators' view of the engines see
[search-engines.md](search-engines.md); for the configuration field reference
see [configuration.md](configuration.md).

```
┌──────────────────┐     loopback HTTP     ┌────────────────────────┐
│ dsh host         │ ◀───────────────────▶ │ dsh-network server     │
│ (dsh/index.js)   │  POST /invoke         │ (dist/cli.cjs server)  │
│  + serverClient  │  GET  /content        │  + src/cache.ts        │
│  + persist       │  GET  /health         │  + src/server.ts       │
│  + client.js     │  POST /shutdown       │  + undici + officeparser│
└──────────────────┘                       └────────────────────────┘
```

## Process model

- The host plugin (`dsh/index.js`) owns only the plugin contract exports
  (`name` / `inject`) and `apply()`. Everything else is split by concern into
  in-tree plain-ESM modules: `dsh/schemas.js` (tool JSON Schemas + enum
  vocabularies), `dsh/cli-runner.js` (server-client singleton + `runCli`),
  `dsh/evidence.js` (model-facing evidence rendering), `dsh/providers.js`
  (web seam providers), `dsh/tools.js` (the six tool registrations),
  `dsh/routes.js` (loopback routes), `dsh/config-summary.js` (config
  projection / mutation / request fence). The host must stay hand-written:
  vite's lib mode silently replaces `node:*` imports with browser externals.
- `apply()` spawns exactly one persistent `node dist/cli.cjs server` child
  and calls `client.ensure()` immediately, so the first user-visible tool
  call does not pay the Node + undici + officeparser cold start (~2 s on
  Windows). `ensure()` failures are logged, not fatal; the next `invoke()`
  respawns.
- The server announces its port on stdout as `{"type":"ready","port":N}`.
  The client parses that line and talks to the server over
  `127.0.0.1:<port>` HTTP.
- Lifetime binding: `ctx.effect(() => () => client.dispose())` kills the
  server with the cordis fiber. `dispose()` POSTs `/shutdown` (best effort),
  then SIGTERM, then SIGKILL after 1 s. Parent-death detection on the server
  side (`stdinWatch` → `process.stdin.on('end'|'error', shutdown)`) covers
  the case where dsh itself crashes. `client.invoke()` respawns the child on
  unexpected exit.
- The child is spawned through `dsh/spawnHidden.js`, the single
  child-process boundary of the package.

## Per-call env snapshot

`configToEnv(config)` in `dsh/serverClient.js` carries the host's LIVE
config on every `POST /invoke` body: engine order, timeouts, allowlist,
GitHub token, SearXNG endpoint, the engine API-key map, per-engine
options, and the workspace root `web_download` writes into. UI edits
therefore take effect on the **next tool call** — the server never restarts
for a settings change.

`DSH_NETWORK_WORKSPACE_DIR` is the one value in that snapshot that is a
filesystem path rather than a network knob, and it is the reason the
snapshot exists in the direction it does: the server child is long-lived
and its own cwd is wherever dsh was launched, so it cannot resolve "the
user's workspace" for itself. The host resolves it once
(`defaultConfig()`), the model picks a `dest` between two fixed roots, and
an absent value means the `workspace` destination is **unavailable** — the
CLI fails the call rather than guessing a root.

## Server routes and the result cache

The loopback server (`src/server.ts`) exposes:

| Route | Purpose |
|---|---|
| `POST /invoke` | Run one job with a per-call env snapshot (body capped at 4 MB) |
| `GET /content?c=&offset=&limit=` | Page a cached body by `cacheId` |
| `GET /health` | Cache size / total chars / hits (used as readiness probe) |
| `POST /shutdown` | Clean exit (code 0) |

`src/cache.ts` (`ResultCache`) dedups by `(fetch|format|url)` /
`(http|method|url)` keys, evicts LRU at 48 entries / 16 MB total chars,
expires entries after 5 minutes, and degrades any body above the inline cap
(default 20 000 chars) to a preview + `cacheId` + `contentLength` +
`cacheSlice`. The cache lives on the **server** side on purpose: child-process
stdout chunking is what truncates big results when the CLI runs one-shot, and
solving it in the server lets the model page with `cacheId` without
re-issuing the request (handbook #717).

`web_search` is deliberately NOT cached: a stale hit list is its own defect,
and a search cache would need an explicit invalidation story. Two identical
searches in one turn bill the engine twice. Worth revisiting only if a billed
engine ever joins the default chain.

## Transport and document handling

- All traffic goes through `undici` with a pinned dispatcher. The plugin
  never shells out to `curl.exe` or `nslookup.exe`.
- SSRF: every redirect hop is validated (URL parse → allowlist → DNS →
  private/reserved IP rejection) and pinned to one IP for the socket.
- True binary content (image, audio, video, font, archive, generic
  octet-stream) is refused. A fixed allowlist of document MIME types —
  `application/pdf`, OOXML (`docx`/`pptx`/`xlsx`), ODF (`odt`/`odp`/`ods`),
  `application/epub+zip` — is routed through `officeparser`
  (`src/document.ts`) and returned to the model as clean Markdown.
  officeparser is loaded via `await import` so tesseract.js (and its 80 MB
  core) stays out of the cold-start bundle. OCR is intentionally off; gate it
  behind a `--ocr` flag if a scanned-PDF workload ever shows up.
- HTML → Markdown stays hand-written (`src/html.ts`): real-world fetched
  pages need a nav/footer/cookie-banner pre-filter that officeparser's HTML
  input format does not provide, and the existing converter is tuned for
  that noise profile. officeparser's value is for binary documents, where
  the noise problem does not exist.
- Feeds get their own renderer (`src/feed.ts`, also hand-written, no XML
  dependency) and are claimed by ROOT ELEMENT, ahead of the HTML branch in
  `src/fetch.ts`: a body opening with `<rss>`, `<feed>` or `<rdf:RDF>` becomes
  a labelled, per-item Markdown view; a `sitemap.xml`, an OPML export or a JS
  app shell does not match and falls through untouched. The point is labelling
  — the HTML converter has no notion of `<item>`, and a feed is the one
  document type that arrives enormous. The renderer emits a `previewCutAt` —
  the end of the last complete item block under the inline cap — so the
  cache degrades an oversized feed at an item boundary and the model pages it
  by `cacheId` with no second network GET. See [cli.md](cli.md#feeds) for the
  rendered shape and the two remaining caps (per-item body, 500-item ceiling).
- A tolerant scanner, not a strict parser: an unescaped `&`, an unclosed
  `<link>`, `dc:` / `content:` / `itunes:` namespaces and HTML entities inside
  CDATA are all routine in real feeds. DOCTYPEs — internal subsets and
  `<!ENTITY>` included — are skipped, never expanded, so there is no entity
  expansion to abuse.

## Search engine registry

Each engine lives in its own file under `src/engines/` with a URL builder, a
parser, and a header profile (Firefox-127 baseline plus per-engine overlays
in `header-profiles.ts`). The CLI iterates engines via
`SearchEngineRegistry`; the legacy `src/search-engines.ts` is a re-export
shim.

Keyed engines declare `auth = { header, scheme, apiKeyEnv }` (Brave:
`X-Subscription-Token`; GitHub's Bearer token is folded into the same map).
The CLI — never the engine — holds the secret: it resolves
`DSH_NETWORK_SEARCH_ENGINE_API_KEYS[engineId]` (a JSON map `configToEnv()`
packs into every `/invoke` env snapshot), falls back to the engine's
single-engine `apiKeyEnv`, then to the legacy `DSH_NETWORK_GITHUB_TOKEN`, and
injects the header. Engines receive only `hasApiKey`. With no key the CLI
sends NO request at all: it synthesizes a 401 body so the engine classifies
"no credential" and "rejected credential" on one code path (the general form
of the `requiresToken` trick the GitHub code index already used).

Engine-specific notes (the user-facing version, with the option tables, is in
[search-engines.md](search-engines.md)):

- **GitHub** is a hybrid REST search (repositories / code / issues / users)
  fused by RRF. Code search needs a token; anonymous search is limited to
  10 req/min per IP. `githubIndexes` pins the index selection (empty =
  automatic intent routing), `githubSort` defaults to `best`.
- **Brave** is billed per query (its free tier is gone), so it sits last in
  the registry, is absent from the default chain, and — because the CLI
  short-circuits a keyed engine with no key — sends no request until a key
  exists. `plausiblePublishedAt` accepts only an ISO-8601 timestamp whose
  year lands in [1990, next year]; real responses have carried broken
  `page_age` values (an epoch-seconds field read as ms), and a wrong date in
  the evidence is worse than no date. Per-engine options ride
  `DSH_NETWORK_ENGINE_OPTIONS` as `{ engineId: { … } }`; the engine validates
  every field itself (`buildBraveUrl` is the reference) so a typo cannot burn
  a billed call on a 422.
- **SearXNG** is a self-hosted JSON-API engine; its endpoint comes from
  `DSH_NETWORK_SEARXNG_URL` (default `http://127.0.0.1:8888`), and
  private-network access is granted only when the configured endpoint is
  itself loopback/private.

## Search answer contract

dsh's own `tool-web` merges every query of one call into a single card: it
wraps each query's `content` in a `### <query>` heading and pools all sources
into ONE list capped at `searchMaxResults`, interleaved round-robin. A
provider that returns only a summary therefore renders two empty headings
above an A/B/A/B list and hides every source past the cap. `makeSearchProvider`
(`dsh/providers.js`) instead renders **each query's full hit list** into
`content`, so each `###` section is self-contained; `sources` still carries
the complete set for any other consumer. Each hit is TWO lines —
`N. [title](url)` closed by a GFM hard break (two trailing spaces; a bare
`\n` is a soft break and renders as a space in dsh's markdown renderer) with
the snippet/date indented four spaces on the next line — and the sections
join on blank lines so the trailing `Uncertain:` note can never
lazy-continue the last list item. `tests/search-source-format.spec.ts` pins
the whitespace.

## The credential chain (four hops)

```
browser dialog ──▶ commitEngineDialog (PUT patch)
              ──▶ applyCardSettings (fills config.searchEngineApiKeys)
              ──▶ configToEnv (packs DSH_NETWORK_SEARCH_ENGINE_API_KEYS on /invoke)
              ──▶ CLI resolves the credential, injects the auth header
```

- `hasApiKey` is a VIEW of the key map, never a stored claim: both
  `summarize()` and `applyCardSettings` derive it from
  `searchEngineApiKeys[id]`, and `summarize()` unions the KEY map into its
  iteration so an engine that holds a key but no `searchEngineConfigs` entry
  is still visible (the real order of operations is "paste the key, THEN add
  the engine to the chain").
- The key is write-only: after a save lands, `stripApiKeys` removes it from
  the draft so later debounced saves never re-send a plaintext copy. The
  browser only ever reads back `hasApiKey`.
- History, for the record: the third hop (`commitEngineDialog` built the
  patch from `endpoint` / `hasApiKey` / `options` only, dropping `apiKey`)
  was broken longer than the fourth (`configToEnv` never sent the map at
  all). Every layer below was correct, which is why no snapshot test caught
  it — `tests/client-chunks.spec.ts` now drives the real dialog with a
  recording `createElement` spy (react-dom/server drops handlers), and
  `tests/engine-config-wiring.spec.ts` pins the env-var NAMES on both sides
  (a rename on one side only degrades silently to "unset").

## Browser half (`dsh/client.js` + chunks)

The dsh web half is a lazy-CJS module; the factory MUST declare its `require`
parameter. The entry owns the SHARED surface — engine constants, `DICTS`
i18n, the config API helpers (`fetchConfig` / `putConfig` / `fetchHealth`),
`labelText`, `STYLES` — and `apply()`, which loads the surfaces from chunks
via the loader's OFFICIAL `require.async` protocol (what a bundler's dynamic
`import()` compiles to):

- `client.settings.js` — the "网络" settings section + the legacy
  `settings.plugin.item` card
- `client.toolviews.js` — the block renderers on `tool.web.item` /
  `tool.web.fetch.item` for older dsh plus the five
  `tool.call.toolview` rows (`web_search`, `http_request`, `web_fetch`,
  `web_sitemap`, `web_config`)
- `client.searchpanel.js` — the sidebar search panel

Chunk rules (from `@deepseek-ai/dsh-client-modules`): a chunk must be
SELF-CONTAINED — it may require seed words (`react`) and the entry via
`require('dsh-network')` (always materialized before a chunk runs), never
another chunk — and it registers with
`window.__ModuleLoader__.load({ id, chunk, factory })`. A chunk has NO view
of the entry's file scope: every shared symbol (including the engine
vocabulary `ENGINES` / `ENGINE_LABELS`) must be re-bound from the
`require('dsh-network')` object by name. A leftover free variable is not a
syntax error, a load error or a warning — the chunk registers, materializes
and exports happily, and then throws `ReferenceError` inside React's render,
which takes the whole section down (`ENGINE_LABELS` in `client.settings.js`
blanked the entire 网络 page that way).
`tests/client-chunks.spec.ts` guards the class statically (TypeScript
`checkJs` unresolved names) and dynamically (every surface rendered through a
faithful chunk loader).

The dsh host serves each chunk on demand at
`/plugins/dsh-network/<chunk>?rev=…` with zero configuration (it reads any
`client.*.js` sitting in the client entry's directory; package.json `files`
already ships `dsh/`). Each chunk load is caught separately, so one failed
surface never takes the others down. Per-plugin revisions derive from the
ENTRY file's mtime/ctime/size: after editing a chunk, touch `dsh/client.js`
(or reinstall) to bump the rev, otherwise browsers keep the immutable-cached
old copy.

### Tool card overrides

`tool.call.toolview` is a KEYED slot: one cell per tool name, only the
**lowest-priority** live entry of a cell renders, and re-registering a key at
an already-taken priority **throws**. dsh claims `web_search` at the default
priority 0, so the plugin claims `-900` to shadow the native row; the
registration is try/caught so an upstream change can never take the whole
browser half down. The same priority is claimed for `http_request`,
`web_fetch`, `web_sitemap` and `web_config` — this package REPLACES dsh's
`tool-web`, so those four cells have no native entry at all and ours renders
unconditionally. The search row renders the per-query answer and deliberately
does NOT re-render the pooled source list; it falls back to a plain source list
for this plugin's own `web_search` meta (`{engine, status, sources}` — no
`answer`). Styling is composed to read like a first-party dsh tool card:
a borderless disclosure row (16px leading box whose globe crossfades to a
chevron on hover, 13px title, 2px dot separators, one ellipsing summary) over
a WebBlock-styled body card. The rules are copied from dsh's own
DisclosureRow / ToolRow / WebBlock module CSS under `dshn-` class names
(injected once per document) because the upstream hashed classes are internal
to the dsh bundle; primitives exports (TextShimmer, flow icons,
LinkIconMedium) are used when present with identical inline-SVG fallbacks.

The six rows and what each body card carries:

| tool | header fragments | body |
|---|---|---|
| `web_search` | query (or "N queries") · hit count | the provider's per-query answer, else the source list |
| `http_request` | `METHOD url` · status · content-type · cache id | raw response bytes (monospace) + response headers |
| `web_fetch` | url · `→ final url` when redirected · status · content-type · link count | the page rendered as Markdown (`format: 'raw'` stays monospace) + outgoing links |
| `web_sitemap` | domain / category / query · match counts | portal rows with badges, resolved search URLs, digest |
| `web_config` | read/update · engine count (read) or change count (write) · persisted / refused | the 变更 list, then the live config as labelled groups + raw JSON |
| `web_download` | filename · dest · byte size · content-type · status | the written **path** and the source URL |

`web_download`'s row is open by default (like `web_fetch`, unlike
`http_request`): its body is two short fields and the path is the entire reason
to open the row. The path is rendered as selectable text, not a link — a
`tmp` link would 404 and a `workspace` link would navigate the IDE out of the
conversation. `dest` gets a `warn`-toned badge when it says `workspace`, since
that is the only file the user is expected to still own tomorrow. A throwing
call lands no meta at all, so a refusal (executable extension, over the size
cap, blocked address) is detected by dsh's canonical `isError` check — never by
meta presence — and opens itself, because the refusal text IS the answer.

`web_config`'s row is the one whose subject IS the result, so its meta is
unusually wide: `presentationMeta` persists the secret-free summary the model
received (`config`) plus the field names a **landed** `set` forwarded
(`changes`), because dsh hands the row `block.meta` and never the tool's value.
Two rules keep it honest:

- **A nested `undefined` is a rejected call.** The harness validates every meta
  with a strict `JSON.parse(JSON.stringify(meta))` **deep**-equal, and
  `summarize()` emits `endpoint: undefined` for an engine with no endpoint
  override — which `JSON.stringify` silently drops. The meta therefore goes
  through `jsonSafeMeta()` (dsh/evidence.js), the deep scrub
  `compactPresentation()` deliberately is not. `presentationmeta.spec.ts` pins
  the trap itself: the raw summary is shown to FAIL the deep round-trip while
  the same value through `jsonSafeMeta` passes.
- **Only a landed write has changes.** Both the safety gate and
  `applyCardSettings`' own rejections answer `status: 'error'` with the config
  untouched, so `changes` is emitted only for `status === 'ok' && action ===
  'set'` — and it names exactly the fields `pickConfigPatch()` forwarded
  (dsh/schemas.js), never the raw request. The row renders each change with the
  value from the POST-write `config`, so a clamped write shows the clamp.

The card body is built from the same DICTS field labels the 网络 settings page
uses, and it reads `meta.config` defensively: a meta without it (a session
recorded by an older build) renders the action, status and badges over a
无配置数据 note instead of throwing. A refusal (soft `status: 'error'`) is an
amber `.dshn-refused` block rather than the red error block a THROWN call
gets — nothing failed, the tool declined, and the message tells the user which
toggle to flip. `allowConfigEdit` can never appear in the card: the meta's
config comes from `summarizeForModel()`, which strips it.

`web_fetch`'s row reads `meta.contentPreview` — the host persists a page-sized
preview of `value.content` in `presentationMeta` (same `previewText` clip and
same trailing `…` marker as `http_request`'s `bodyPreview`, so a truncated
preview is distinguishable from a complete one) together with `format`, the
outgoing `links` and the cache descriptor. The row opens by default (a fetch IS
the page the user asked to see), and its paging hint quotes the ABSOLUTE next
offset — `cacheSlice.offset + shown`, never the slice-local length — for the
same reason `renderFetchEvidence` does: a slice-local hint sends the next read
back to the top of the document.

Arguments are read via `argsOf`: a settled dsh block carries its arguments
ONLY as the raw JSON string `block.call.argsRaw` (the native rows JSON.parse
it — there is no pre-parsed `call.args`), with a literal `call.args` fallback
for hosts/tests. Reading `call.args` alone is what once hid the "N 个查询"
bit from the multi-query header. Settled state comes from dsh's canonical
`kind === 'tool-result'` (plus `isError`) check, with meta presence as a
fallback — never from hit count, which left zero-hit calls and every THROWN
call (a failing tool never lands a meta) shimmering forever.

### Markdown rendering in the tool cards

Every answer/body string the rows show (`meta.answer`, the `web_fetch`
`contentPreview`, the `web_sitemap` digest, the search panel's summary) goes
through the host's `ui.MarkdownText` primitive — except a `web_fetch` /
`http_request` body whose `format` is `raw`, which stays monospace because
those bytes are not markdown. That primitive MUST be detected with
`isRenderable(value)`, never
`typeof value === 'function'`: dsh exports `MarkdownText` / `TextShimmer`
through `React.memo`, so the shipped value is a memo object
(`{ $$typeof: Symbol(react.memo), type, compare }`) and the function-only
test silently evaluated FALSE on every build. The rows then took the
raw-text `<pre>` fallback and the card showed literal `### <query>`,
`[title](url)` and `&nbsp;` in a proportional font while the plain icons
(real functions) kept working — the "web search does not render" defect.
`isRenderable` accepts functions, memo / forwardRef / lazy tag objects and
`render`-carrying objects, and rejects null, plain objects and the strings
of the degraded `{ Input: 'input' }` host surface. `MarkdownText` also
requires its `labels` seats (dsh's own `markdownLabels(t)`); they are read
lazily (only a code fence touches `labels.code.copyLabel`, only a footnote
`labels.footnotes`), and the entry supplies them per locale so a
memo-wrapped renderer never throws on a missing seat.

### Sidebar search panel

Built on the same two-registration protocol the built-in plugins (order 0)
and schedules (order 10) panels use: an icon in the root-scoped
`sidebar.panellist` list slot with `{ id: 'dsh-network-search', order: 20,
label }`, and the page component registered into the layout's root-scoped
KEYED `main` slot under the same key — `layout.selectPanel(id)` validates
the key against `main` entries, so id and key must match. The page POSTs
`{ query, count, engine }` to the host's `/dsh-network/search` route (fenced
by `isTrustedRequest` like the config route; `GET ?q=` is also accepted)
which runs the SAME `runCli(['search', …])` path as the `web_search` tool —
live engine chain, per-call env snapshot. The route is dynamically gated by
`config.webSearchTool`, and `applyCardSettings` honors the tool toggles via
the config PUT. The panel only mounts after the `/dsh-network/config` probe
proves the host plugin is present AND `webSearchTool !== false` in the
summary; panel state (last query/results/history) survives unmounts in a
module-level cache so peeking at the conversation never loses results.

## Configuration and persistence

- The browser half reads/writes the live `config` object the host's `apply()`
  owns. There is deliberately NO `dsh-network` settings namespace: a
  registered namespace would be persisted to the settings document, but the
  runtime reads the cordis row config + in-memory edits, so a `settings.yaml`
  section would silently do nothing.
- Durability comes from `dsh/persist.js`, not the settings document: every
  successful UI save atomically snapshots the live config to
  `~/.dsh/dsh-network.json` (`DSH_NETWORK_CONFIG_FILE` overrides), and
  `apply()` reloads it at boot — the persisted snapshot wins over the cordis
  row config (which stays the seed for a fresh install). Delete the file to
  reset to row config. `enabled` is never persisted and is stripped from any
  hand-written file: the row config is the only kill-switch. Secrets
  (`githubToken`, engine API keys) ride in the file like other plugins' keys
  in `settings.yaml`; the browser still only sees `hasApiKey`. A corrupted
  file is ignored with a warning.
- The `/dsh-network/config` HTTP route registered on `ctx.webServer` honors
  the same loopback + `sec-fetch-site: same-origin` + Origin == Host fence
  dsh's own `/api` uses, so the browser card can be served from the same
  origin without leaking to cross-site pages.
- `web_config`'s `set` action is gated by the user-controlled
  `allowConfigEdit` safety toggle in **网络 → 安全** (off by default). The
  toggle itself is intentionally hidden from the model — neither echoed on
  `get` nor accepted on `set` — so a botched batched patch can never lock the
  model out of its own write path. The user, from the browser, is the only
  actor that can flip the toggle.

## `cordis.patch.yml`

The bundle patch makes three moves when a profile installs the package:

1. Pin the `web` seam's `searchProvider` AND `fetchProvider` to the
   dsh-network providers (`dsh/providers.js`).
2. Disable `tool-web` (`search: false, fetch: false`) so duplicate
   `web_search` / `web_fetch` tool names never land (the tools registry
   refuses duplicates).
3. Insert the `dsh-network` cordis row whose `config:` block seeds the
   defaults the host's `apply()` reads.

---

See also: [README](../README.md) · [Search engines](search-engines.md) ·
[CLI and cache paging](cli.md) · [Configuration](configuration.md) ·
[Development](development.md)
