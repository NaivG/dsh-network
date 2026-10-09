# CLI and cache paging

The package ships a standalone CLI — the same binary the host drives in server
mode — so the search and fetch paths are usable from a terminal, a script, or
CI. This guide covers its commands, the JSON envelope it prints, and how the
server-side cache is paged. For the settings it reads see
[configuration.md](configuration.md).

## Commands

```bash
dsh-network search  -q <query>            [options]   Free Bing→DDG→Baidu search
dsh-network fetch   -u <url>             [options]   Fetch URL → Markdown (or raw)
dsh-network http | dsh-network -X <METHOD> <url>     Low-level HTTP request / cache paging
dsh-network sitemap                       [options]   Curated portals lookup (web_sitemap)
dsh-network doctor                                    Readiness report (no network)
dsh-network server                        [options]   Persistent loopback HTTP server
```

Engine choices for `search`: `bing`, `duckduckgo`, `baidu`, `github`,
`searxng`, `brave`. `--engine <id>` pins one; otherwise the chain runs in
order. See [search-engines.md](search-engines.md).

`doctor` is the readiness probe. It resolves the configuration and reports what
it found — engine chain, timeouts, `apiKeys=[brave=no key]` — without
contacting anything, which makes it safe offline and safe for a billed engine.

## Shared options

| Flag | Meaning | Default |
|---|---|---|
| `-q`, `--query <text>` | Search query. | — |
| `--engine <id>` | Pin one engine for this call (search mode). | chain fallback |
| `-u`, `--url <url>` | Target URL. | — |
| `-X`, `--method <METHOD>` | Method for `http` mode. | `GET` |
| `-t`, `--timeout <ms>` | Per-call timeout. | 25 000 (search 15 000) |
| `--max-results`, `--count <n>` | Search result cap (1-20). | 10 |
| `--format raw\|markdown` | `fetch` output format. | `markdown` |
| `--allow-private-network` | Allow loopback, private, and reserved targets. | off |
| `--no-redirect-protection` | Allow redirects to cross domains. | off |
| `--no-protocol-lock` | Allow redirects to switch between http and https. | off |
| `--no-follow` | `http_request`: do not follow redirects. | follows |
| `--headers <json>` | Request headers as a JSON object. | empty |
| `-d`, `--body <text>` | Request body. | empty |
| `--content-type <ct>` | Applied when the headers object lacks `content-type`. | unset |
| `--json-schema <json>` | Optional JSON-Schema guard for engine-side validation. | unset |
| `--cache-id <id>` | `fetch` / `http`: page a cached body by id (exclusive with `-u` / `-X`). | unset |
| `--offset <n>` | `cache-id` paging: starting character offset. | 0 |
| `--limit <n>` | `cache-id` paging: slice length (1-20000). | 4000 |

## Sitemap options

| Flag | Meaning | Default |
|---|---|---|
| `-d`, `--domain <domain>` | Resolve one entry by domain (e.g. `github.com`). | — |
| `-c`, `--category <name>` | Filter by category (`code-repos`, `qna`, `docs`, `ai-platforms`, …). | — |
| `-p`, `--min-priority <n>` | Drop entries whose priority is below N (1-10). | — |
| `--digest` | Also include a Markdown digest the model can paste into context. | off |
| `--limit <n>` | Cap on returned entries. | 10 |

## Server options

| Flag | Meaning | Default |
|---|---|---|
| `--port <n>` | Loopback port to listen on. | ephemeral, printed on stdout |

## Output

Every run prints one JSON envelope:

```jsonc
{
  "ok": true,
  "results": [ /* SearchEntry | FetchEntry | HttpEntry | SitemapEntry */ ],
  "elapsedMs": 412
}
```

Each entry carries `status` (`ok` / `degraded` / `unavailable`), a one-line
`summary`, the entry's own payload, and — when something went sideways —
`uncertainty`, `warnings`, and an `attempts` array of `{ engine, error }`. The
model sees the same fields, so anything a run reports is citeable in a
conversation.

## Cache paging

The server keeps a small LRU cache of results — **48 entries / 16 MB total
chars, 5-minute expiry** — deduplicated by `(fetch|format|url)` /
`(http|method|url)`. In **server mode** (how the host drives the CLI), a body
above the inline cap comes back as a preview plus a handle. The cap is a flat
20 000 chars (`INLINE_CAP` in `src/cache.ts`): at or below it the body is
returned whole, above it the preview is the first 20 000 chars.

```jsonc
{
  "status": "ok",
  "content":   "<first 20000 chars preview>…",
  "cacheId":   "abc123",
  "contentLength": 175432,
  "cacheSlice": { "offset": 0, "limit": 20000, "total": 175432, "end": 20000, "more": true }
}
```

> **One-shot runs do not cache.** The cache belongs to the long-lived server, so
> a plain `dsh-network fetch -u …` prints the whole body inline — no `cacheId`,
> no paging. The contract below is what the host's tool calls see; run
> `dsh-network server` if you need to exercise it by hand.

To read the rest, re-invoke the same tool with `cacheId` and optional `offset` /
`limit` **instead of** a URL (the two are mutually exclusive). The CLI can
reproduce that read against a running server:

```bash
dsh-network fetch --cache-id abc123 --offset 20000 --limit 20000   # the next slice
dsh-network http  --cache-id abc123 --offset 0 --limit 4000        # …or over the http path
```

`fetch` / `http` are the only modes that degrade, and `offset` + `limit` pick
the slice window: `limit` is capped at 20 000 chars, so a 175 432-char body
takes nine pages.

`web_search` and `web_sitemap` do not page: their result lists are bounded by
the result cap (default 10, hard cap 20), and `web_search` is deliberately not
cached at all — a stale hit list is its own defect.

## Loopback server mode

`dsh-network server` is the long-lived mode the host spawns exactly once and
reuses for every tool call. It announces its port on stdout as
`{"type":"ready","port":N}` and exposes:

| Route | Purpose |
|---|---|
| `POST /invoke` | Run one job with a per-call env snapshot (body capped at 4 MB) |
| `GET /content?c=&offset=&limit=` | Page a cached body by `cacheId` |
| `GET /health` | Cache size / total chars / hits (readiness probe) |
| `POST /shutdown` | Clean exit (code 0) |

Because the host sends its **live** configuration with every `/invoke`, a
settings edit takes effect on the next tool call — the server never restarts
for a configuration change. `dsh/serverClient.js` respawns the child if it dies
unexpectedly, and the server exits on its own when its stdin pipe closes (dsh
crashed). See [architecture.md](architecture.md#process-model).

---

See also: [README](../README.md) · [Search engines](search-engines.md) ·
[Configuration](configuration.md) · [Development](development.md)
