<div align="center">

# dsh-network

Let Deepseek Harness access the internet seamlessly.

[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-darkblue)](https://github.com/topics/dsh-plugin)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/naivg/dsh-network)

</div>

`dsh-network` replaces the official `tool-web` `web_search`/`web_fetch` with a long-lived loopback Node CLI that talks to the web through `undici`. It parses PDF and Office documents to Markdown via `officeparser`, and adds `http_request`, a "网络" settings section, a sidebar web-search panel, and web block renderers to the dsh web frontend.

The host keeps one persistent `dsh-network server` child process for its lifetime. Large results page through a server-side cache, so the model can read past the inline cap without re-issuing the request.

All UI elements are designed to match the official style, so they blend seamlessly into the app.

Works with `dsh: 0.1.0.rc1` or later.

> **Note:** This plugin is not yet published to npm.

## What it does

- `web_search` searches the public web. It returns citeable sources with title, snippet, and date, plus a summary, a status flag (`ok`, `degraded`, or `unavailable`), and arrays of uncertainty notes and warnings.
- `web_fetch` fetches one HTTP(S) URL and returns Markdown by default or the raw body on request, with outgoing links and warnings. It recognises PDF, OOXML (`docx`/`pptx`/`xlsx`), ODF (`odt`/`odp`/`ods`), and EPUB responses and routes them through `officeparser`, so the model sees clean Markdown instead of binary bytes. Bodies larger than about 20 KB are cached server-side and returned as a preview plus a `cacheId`. The model pages through the rest by calling the tool again with `cacheId`, `offset`, and `limit`.
- `http_request` issues a low-level HTTP(S) request with full method, header, and body control. It uses the same `cacheId` paging path as `web_fetch`.
- `web_config` reads the live dsh-network configuration, or applies a partial patch when the user has enabled the `allowConfigEdit` ("允许修改设置") safety toggle in **设置 → 网络 → 安全**. `get` always works. While the toggle is off, `set` returns a soft error that tells the user how to enable it. The toggle itself is hidden from the model — it does not appear in the `get` response or in the `set` patch schema — so a malformed patch cannot lock the model out of its own write path. Only the browser user can flip the toggle. Secrets like `githubToken` and per-engine API keys are also stripped from both the read and write paths.

Search engines, timeouts, SSRF protection, and other knobs are configurable from **设置 → 网络** in the dsh web UI.

### Sidebar web search (侧边栏网络搜索)

The dsh web UI gains a **网络搜索** entry in the sidebar, after Plugins and Schedules. It opens a search-engine-style panel with a query box, an engine picker that mirrors the live engine chain or pins one engine, and a result-count selector. Results render as cards under the engines' summary answer: title link (opens in a new tab), host, snippet, published date. Warnings, uncertainty notes, and per-engine attempt details sit alongside the cards. Recent queries stay one click away, and the last result set survives switching panels.

The backend is the `GET`/`POST /dsh-network/search` route on the host webServer, fenced like `/dsh-network/config` and gated by the same `webSearchTool` toggle as the `web_search` tool.

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

- The host spawns one persistent `node dist/cli.cjs server` child during `apply()` and binds its lifetime to the cordis fiber with `ctx.effect(() => () => client.dispose())`. `ensure()` failures are logged, not fatal; the next `invoke()` respawns on unexpected exit.
- The server announces its port on stdout as `{"type":"ready","port":N}`. The client parses that line and talks to the server over `127.0.0.1:<port>` HTTP. A per-call env snapshot from `configToEnv(config)` carries the live UI settings, so engine order, timeouts, allowlist, GitHub token, and SearXNG endpoint change on the next tool call. The server never restarts for them.
- Parent-death detection on the server side (`stdinWatch` watching `process.stdin.on('end'|'error', shutdown)`) handles the case where dsh itself crashes. `client.dispose()` POSTs `/shutdown` (best effort), then SIGTERM, then SIGKILL after 1 s.

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

When the loader sees this package, it applies `cordis.patch.yml` automatically: the `web` seam providers switch to `dsh-network`, the legacy `tool-web` `web_search`/`web_fetch` get disabled, and the `dsh-network` cordis row that loads `dsh/index.js` is inserted.

## CLI

```text
dsh-network search     -q <query>          [options]   Free web search
dsh-network fetch      -u <url>            [options]   Fetch URL → Markdown (or raw)
dsh-network            -X <METHOD> <url>   [options]   Low-level HTTP request
dsh-network web_sitemap [--query | --domain | --category ...]          Curated portals lookup
dsh-network doctor                                Readiness report (no network)
dsh-network server      [--port <n>]        Persistent loopback HTTP server (host uses this)
```

The single-shot CLI is a stdin-to-stdout Node child for manual runs, tests, and CI. The host only ever spawns the `server` subcommand.

### Shared options

| Flag | Meaning | Default |
|---|---|---|
| `-t`, `--timeout <ms>` | Per-call timeout | 25 000 (search 15 000) |
| `--allow-private-network` | Allow loopback, private, and reserved targets | off |
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

The server keeps an LRU cache of results (default cap: 48 entries / 16 MB total chars, 5-minute TTL). When a fetch or http body exceeds the inline cap (about 20 KB by default), the server returns:

```jsonc
{
  "status": "ok",
  "content":   "<first 20000 chars preview>…",
  "cacheId":   "abc123",
  "contentLength": 175432,
  "cacheSlice": { "offset": 0, "limit": 20000, "total": 175432 }
}
```

The host tools (`web_fetch` and `http_request`) pass those fields through to the model. To page further, the model re-invokes the same tool with `cacheId` plus optional `offset` and `limit`. The `url` and `cacheId` parameters are mutually exclusive.

`web_search` and `web_sitemap` do not page. Their result lists are bounded by `--max-results` (default 10, hard cap 20).

## Settings

The static seed lives in `cordis.patch.yml`:

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

Fields not listed here default from the host plugin and stay editable from **设置 → 网络**. The three protections (`ssrfProtection`, `redirectProtection`, `protocolLock`) default to on. `githubToken` and `searchEngineApiKeys` start empty. `githubIndexes` is empty. `githubSort` defaults to `"best"`.

Live edits come from **设置 → 网络**. The section reads `GET /dsh-network/config` and writes `PUT /dsh-network/config`. The host mutates the live config object, so policy fields take effect on the next tool call: the next `/invoke` body picks them up via `configToEnv`. The tool toggle switches (`webSearchTool`, `webFetchTool`, `httpRequestTool`, `webSitemapTool`) also work live. Flipping one off causes the matching tool's next call to fail fast, and the sidebar search route answers 403 while `webSearchTool` is off. Restarting dsh fully unregisters disabled tools. `enabled` stays row-config-only.

UI edits persist to `~/.dsh/dsh-network.json` (atomic write; `DSH_NETWORK_CONFIG_FILE` overrides the path). The persisted snapshot wins over the cordis row config. Delete the file to reset. `enabled` is never persisted; the cordis row remains the kill switch.

### SearXNG (self-hosted, opt-in)

Add `searxng` to `searchEngines` and set its endpoint in the UI or via `DSH_NETWORK_SEARXNG_URL` (default `http://127.0.0.1:8888`). The instance must enable `json` in `search.formats`.

### Brave Search API (keyed, opt-in, billed)

The first engine that authenticates with an API key. It is never part of the default chain: Brave removed its free tier in Feb 2026, so every query costs money. Opt in by adding `brave` to `searchEngines` (or pin it per call with `web_search`'s `engine: "brave"`).

1. Open **设置 → 网络 → 引擎**, pick **Brave Search** from the add-engine list.
2. Paste the subscription token into the dialog's **API Key** field. It is write-only: the host stores it in `~/.dsh/dsh-network.json` and the browser only ever reads back `hasApiKey`.
3. Optional per-engine parameters, one `key=value` per line in the same dialog:

| option | values | effect |
| --- | --- | --- |
| `country` | `DE`, `US`, … | two-letter country targeting |
| `searchLang` / `uiLang` | `de`, `de-DE` | content language / response metadata language |
| `freshness` | `pd` `pw` `pm` `py` or `2024-01-01to2024-06-30` | recency filter |
| `safesearch` | `off` `moderate` `strict` | adult-content filter |
| `goggles` | an `http(s)` URL | custom re-ranking |
| `offset` | `0`-`9` | result paging |

Anything outside that vocabulary is dropped before the request is built, so a typo cannot burn a billed call on a 422. `count` is taken from the call's result cap (max 20), `extra_snippets=true` is always on, and `page_age` is surfaced as the hit's date.

How the key travels (and why it only travels one way): the dialog's **API Key** field rides the settings PUT as `searchEngineConfigs[brave].apiKey`; the host moves it into `config.searchEngineApiKeys` (the browser never reads it back), and `configToEnv()` packs that map into the per-invoke `DSH_NETWORK_SEARCH_ENGINE_API_KEYS` env snapshot on the loopback `/invoke` body; the CLI resolves the engine's credential and injects the header the engine's `auth` block declares (`X-Subscription-Token` for Brave, `Bearer` for GitHub). Engines only ever see `hasApiKey`, and that flag is derived from the stored key — a green **已配置** badge means a key is really there, because the CLI reads the same map and would otherwise refuse to send the header. With no key, no request is sent at all — the engine reports the missing credential instead. Leaving the field empty when you save keeps the key you already stored (write-only: reopening the dialog never shows it).

## Safety

- All traffic goes through `undici`. The plugin never calls `curl.exe` or `nslookup.exe`.
- Per-redirect SSRF validation, IP pinning, and private/reserved range blocking are on by default.
- The transport refuses true binary content (image, audio, video, font, archive, generic octet-stream). A fixed allowlist of document MIME types (`application/pdf`, OOXML `docx`/`pptx`/`xlsx`, ODF `odt`/`odp`/`ods`, and `application/epub+zip`) gets parsed through `officeparser` and returned as Markdown.
- `githubToken` and engine API keys live in `~/.dsh/dsh-network.json`. The browser only sees `hasApiKey`.
- The loopback server binds to `127.0.0.1` only. There is no external listener. The `/invoke` body is capped at 4 MB.

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
2. Paging with `--cache-id --offset 1000 --limit 500` returns the exact echo slice `[1000, 1500)`.
3. `/health` reports the cache size, total chars, and hits.
4. `/shutdown` exits the server cleanly with code 0.

## License

MIT. See [LICENSE](LICENSE).