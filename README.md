# dsh-network

Let Deepseek Harness access the internet seamlessly.

Works with `dsh: 0.1.0.rc1` or later.

Replaces the official `tool-web` `web_search`/`web_fetch` with a long-lived loopback Node CLI over `undici`, parses PDF / Office / EPUB documents to Markdown via `officeparser`, and contributes `http_request`, a dedicated "网络" settings section, a sidebar web-search panel (search-engine-style UI over the same engine chain, backed by `/dsh-network/search`), and web block renderers to the dsh web frontend. The host keeps **one** persistent `dsh-network server` child for its lifetime and pages oversized results via a server-side cache instead of truncating across the child-process boundary.

> **Note:** This plugin is not yet published to npm.

## What it does

- `web_search` — search the public web. Returns citeable sources with title/snippet/date, a summary, status (`ok`/`degraded`/`unavailable`), and uncertainty/warnings arrays.
- `web_fetch` — fetch one HTTP(S) URL and return Markdown (default) or raw body, plus outgoing links and warnings. Recognises PDF, OOXML (`docx`/`pptx`/`xlsx`), ODF (`odt`/`odp`/`ods`), and EPUB responses and routes them through `officeparser` so the model gets clean Markdown instead of binary garbage. Bodies larger than ~20 KB are cached server-side and returned as a preview + `cacheId`; the model pages through the rest with `cacheId` + `offset` / `limit` (instead of `url`) without re-downloading.
- `http_request` — low-level HTTP(S) request with full method/header/body control. Same `cacheId` paging path as `web_fetch`.
- `web_config` — read the live dsh-network configuration, or apply a partial patch when the user has flipped the `allowConfigEdit` ("允许修改设置") safety toggle in **设置 → 网络 → 安全**. `get` always works; `set` returns a soft error and tells the user how to enable it while the toggle is off. The toggle itself is intentionally hidden from the model — it's not part of `get`'s response nor of the `set` patch schema — so a botched batched patch can never lock the model out of its own write path. Only the user, from the browser, can flip the toggle. Secrets (`githubToken`, per-engine API keys) are also filtered out of both the read and write paths.

Search engines, timeouts, SSRF protection, and other knobs are configurable from **设置 → 网络** in the dsh web UI.

### Sidebar web search (侧边栏网络搜索)

The dsh web UI gains a **网络搜索** entry in the sidebar (after Plugins and Schedules). It opens a search-engine-style panel: one query box plus an engine picker that mirrors the live engine chain (or pin one engine) and a result-count selector. Results render as cards — title link opening in a new tab, host, snippet, published date — under the engines' summary answer, with warnings/uncertainty notes and per-engine attempt details. Recent queries stay one click away, and the last result set survives switching panels. The backend is the `GET|POST /dsh-network/search` route on the host webServer, fenced like `/dsh-network/config` and gated by the same `webSearchTool` toggle as the `web_search` tool.

## Architecture

```
┌──────────────────┐     loopback HTTP     ┌────────────────────────┐
│ dsh host         │ ◀───────────────────▶ │ dsh-network server     │
│ (dsh/index.js)   │  POST /invoke         │ (dist/cli.cjs server)  │
│  + serverClient  │  GET  /content        │  + src/cache.ts        │
│  + persist       │  GET  /health         │  + src/server.ts       │
│  + client.js     │  POST /shutdown       │  + undici + officeparser│
└──────────────────┘                       └────────────────────────┘
```

- The host spawns **one** persistent `node dist/cli.cjs server` child during `apply()` and binds its lifetime to the cordis fiber via `ctx.effect(() => () => client.dispose())`. `ensure()` fails are logged but not fatal; the next `invoke()` respawns on unexpected exit.
- The server announces its port on stdout as `{"type":"ready","port":N}`; the client parses that line, then talks to the server over `127.0.0.1:<port>` HTTP. Per-call env snapshots (`configToEnv(config)`) carry the live UI settings, so engine order / timeouts / allowlist / GitHub token / SearXNG endpoint change on the next tool call without restarting the server.
- Parent-death detection on the server side (`stdinWatch` → `process.stdin.on('end'|'error', shutdown)`) catches the case where dsh crashes outright. `client.dispose()` POSTs `/shutdown` (best effort) then SIGTERM → SIGKILL after 1 s.

## Install

```bash
# from a git checkout or release archive:
dsh plugin --profile web add github:NaivG/dsh-network
# or, when developing in this repo:
dsh plugin --profile web add link:<path-to-this-checkout>

cd <path-to-checkout>
pnpm install
pnpm build
dsh web
```

When the loader sees this package, `cordis.patch.yml` is applied automatically:

- sets the `web` seam providers to `dsh-network`
- disables the legacy `tool-web` `web_search`/`web_fetch`
- inserts the `dsh-network` cordis row that loads `dsh/index.js`

## CLI

```text
dsh-network search     -q <query>          [options]   Free web search
dsh-network fetch      -u <url>            [options]   Fetch URL → Markdown (or raw)
dsh-network            -X <METHOD> <url>   [options]   Low-level HTTP request
dsh-network web_sitemap [--query | --domain | --category ...]          Curated portals lookup
dsh-network doctor                                Readiness report (no network)
dsh-network server      [--port <n>]        Persistent loopback HTTP server (host uses this)
```

The single-shot CLI is a `stdin → stdout` Node child for manual runs, tests, and CI; the host only ever spawns the `server` subcommand.

### Shared options

| Flag | Meaning | Default |
|---|---|---|
| `-t`, `--timeout <ms>` | Per-call timeout | 25 000 (search 15 000) |
| `--allow-private-network` | Allow loopback / private / reserved targets | off |
| `--no-redirect-protection` | Allow redirects to cross domains | off |
| `--no-protocol-lock` | Allow redirects to switch between http and https | off |
| `--headers <json>` | Request headers as JSON object | empty |
| `-d`, `--body <text>` | Request body (text mode) | empty |
| `--content-type <ct>` | Apply when the headers dict lacks `content-type` | unset |
| `--max-results`, `--count <n>` | Search result cap (1-20) | 10 |
| `--format raw\|markdown` | `fetch` output format | markdown |
| `--cache-id <id>` | `fetch` / `http_request`: page a cached body by id (mutually exclusive with `-u`/`-X`) | unset |
| `--offset <n>` | `cache-id` paging: starting char offset | 0 |
| `--limit <n>` | `cache-id` paging: slice length, 1-20000 | 4000 |
| `--json-schema <json>` | Optional schema guard for engine-side validation | unset |

### Server options

| Flag | Meaning | Default |
|---|---|---|
| `--port <n>` | Loopback port to listen on | ephemeral, printed on stdout as `{"type":"ready","port":N}` |

## Cache paging

The server keeps an LRU cache of results (default cap: 48 entries / 16 MB total chars, 5-minute TTL). When a fetch / http body exceeds the inline cap (~20 KB by default) the server returns:

```jsonc
{
  "status": "ok",
  "content":   "<first 20000 chars preview>…",
  "cacheId":   "abc123",
  "contentLength": 175432,
  "cacheSlice": { "offset": 0, "limit": 20000, "total": 175432 }
}
```

…and the host tools (`web_fetch` / `http_request`) pass those fields through to the model. To page further, the model re-invokes the same tool with `cacheId` + optional `offset` / `limit` (instead of `url`); `url` and `cacheId` are mutually exclusive.

`web_search` and `web_sitemap` don't page — their result lists are bounded by `--max-results` (default 10, hard cap 20).

## Settings

The static seed is in `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-network
      name: dsh-network
      config:
        enabled: true
        allowlist: []
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0"
        fetchTimeoutMs: 25000
        searchTimeoutMs: 15000
        httpTimeoutMs: 25000
        maxBodyChars: 3000000
        maxRedirects: 3
        searchEngines: ['bing', 'duckduckgo', 'baidu']
        searchMaxResults: 10
        webSearchTool: true
        webFetchTool: true
        httpRequestTool: true
        webSitemapTool: true
        httpMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
```

Fields not listed here are defaulted by the host plugin and stay editable from **设置 → 网络**: the three protections (`ssrfProtection`, `redirectProtection`, `protocolLock`) default to **on**, `githubToken` starts empty, `githubIndexes` empty, `githubSort: "best"`, and per-engine API keys (`searchEngineApiKeys`) start empty.

Live edits are made from **设置 → 网络**. The section reads `GET /dsh-network/config` and writes `PUT /dsh-network/config`; the host mutates the live config object, so policy fields take effect on the next tool call (the next `/invoke` body picks them up via `configToEnv`). The tool toggle switches (`webSearchTool`, `webFetchTool`, `httpRequestTool`, `webSitemapTool`) are applied live too: the matching tool's next call fails fast and the sidebar search route answers 403 while `webSearchTool` is off — restarting dsh fully unregisters disabled tools. `enabled` stays row-config-only.

UI edits are persisted to `~/.dsh/dsh-network.json` (atomic write; `DSH_NETWORK_CONFIG_FILE` overrides the path). The persisted snapshot wins over the cordis row config. Delete the file to reset. `enabled` is never persisted; the cordis row remains the kill-switch.

### SearXNG (self-hosted, opt-in)

Add `searxng` to `searchEngines` and set its endpoint in the UI or via `DSH_NETWORK_SEARXNG_URL` (default `http://127.0.0.1:8888`). The instance must enable `json` in `search.formats`.

## Safety

- No `curl.exe` or `nslookup.exe`; all traffic goes through `undici`.
- Per-redirect SSRF validation, IP pinning, and private/reserved range blocking are on by default.
- True binary content (image / audio / video / font / archive / generic octet-stream) is refused at the body level. A fixed allowlist of document MIME types — `application/pdf`, OOXML (`docx` / `pptx` / `xlsx`), ODF (`odt` / `odp` / `ods`), and `application/epub+zip` — is parsed through `officeparser` and returned as Markdown.
- `githubToken` and engine API keys are stored in `~/.dsh/dsh-network.json`; the browser only sees `hasApiKey`.
- The loopback server binds to `127.0.0.1` only — no external listener is ever exposed. `/invoke` body is capped at 4 MB.

## Development

```bash
pnpm install
pnpm test                # vitest: ~115 pure-module cases, no network
pnpm run test:server     # loopback server smoke (echo → /invoke → cache paging → /shutdown)
pnpm run test:client     # browser-half smoke test
pnpm run test:persist    # durable config store smoke test
pnpm run test:schema     # host-plugin tool-schema guard (skips cleanly when dsh is absent)
pnpm run test:all        # everything above in one go
pnpm build               # vite SSR build → dist/cli.cjs + dist/server-*.cjs
pnpm dev                 # vite SSR watch
```

`tests/server-smoke.mjs` spawns the built `dist/cli.cjs server`, points it at a local 25 000-char echo server, and asserts:

1. `/invoke` on `fetch` returns a degraded preview with `contentLen` = 20 000 and a `cacheId`.
2. paging with `--cache-id --offset 1000 --limit 500` returns the exact echo slice `[1000, 1500)`.
3. `/health` reports the cache size + total chars + hits.
4. `/shutdown` exits the server cleanly with code 0.

## License

MIT — see [LICENSE](LICENSE).
