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
dsh-network download -u <url>            [options]   Save a binary file to disk (web_download)
dsh-network sitemap                       [options]   Curated portals lookup (web_sitemap)
dsh-network doctor                                    Readiness report (no network)
dsh-network server                        [options]   Persistent loopback HTTP server
```

The binary is named `dsh-network`, but the **package** is `@naivg/dsh-network`
(the unscoped npm name belongs to an unrelated project), so a one-off run must
spell out the scope — a bare `npx dsh-network` would fetch the wrong package:

```bash
npx @naivg/dsh-network doctor
```

Engine choices for `search`: `bing`, `duckduckgo`, `baidu`, `github`,
`searxng`, `brave`. `--engine <id>` pins one; otherwise the chain runs in
order. See [search-engines.md](search-engines.md).

`doctor` is the readiness probe. It resolves the configuration and reports what
it found — engine chain, timeouts, `apiKeys=[brave=no key]` — without
contacting anything, which makes it safe offline and safe for a billed engine.

### Feeds

A body whose **root element** is `<rss>`, `<feed>` or `<rdf:RDF>` is rendered
as a feed instead of being pushed through the HTML→Markdown converter, which
knows nothing about `<item>` and would flatten a whole feed into one unlabeled
wall of text. Detection is by root element, not content type, because feeds
are routinely served as `text/html` or plain `application/xml`; a
`sitemap.xml`, an OPML export or a JS app shell never matches and falls
through untouched. RSS 2.0, RSS 1.0 (RDF) and Atom 1.0 are all covered.

```markdown
# Hacker News 中文摘要 - 每日 AI 论文精选 | Zeli

Home: <https://zeli.app/zh>
Feed: <https://zeli.app/zh/rss.xml>

实时翻译 Hacker News 首页每条热帖……

## 1. HN Digest 2026-10-08 · 美国叫停科技公司签证

2026-10-08 · <https://zeli.app/zh/digest/2026-10-08>

- [美国叫停科技公司签证](https://zeli.app/zh/story/50006832) — ▲ 865 · …
```

- `Feed:` is the `rel="self"` URL — the one to subscribe to.
- `format: 'raw'` returns the XML verbatim, unrendered.
- Item bodies are HTML and go through the same converter as a web page.
- `links` stays empty: every URL is already in the body, and the host
  renderer prints `links` into the answer text.

**Token budget — in server mode the cache carries the tail.** One item's body
is still clipped at 8 000 characters, on a block boundary and never
mid-sentence, and the clip states the real rendered length:

```
_… body clipped at 8000 of 37373 characters._
```

The WHOLE feed carries no character budget, and the item count is not capped at
25 either. The server already downloaded every byte, so the complete render
goes to the result cache — discarding the tail would force a second GET against
an origin that serves a *different* feed on the next request. The inline part
is previewed at the end of the last WHOLE item under 20 000 characters:

```json
{
  "content": "# Hacker News … ## 7. Entry 6 …",
  "cacheId": "9f2c…",
  "contentLength": 65823,
  "warnings": ["Content is 65,823 chars — previewed here; read the rest with web_fetch cacheId=\"9f2c…\" (offset 19735, limit)."]
}
```

`web_fetch cacheId=… offset=19735` then serves the rest from server memory —
no network at all — and resumes on an item boundary, so the model reads whole
entries instead of fragments. A warm hit on the same URL previews at the same
place.

Only the single-shot CLI (no cache behind it, so the body would have to cross
a child-process stdout pipe) keeps the 20 000-character whole-feed budget, and
there the cut is stated in place:

```
_… 5 more of 7 items not shown (rendered 2 of 7 within a 20000-character budget). Re-fetch with format=raw for the source._
```

The 500-item render ceiling is the one stop that applies in both modes, and it
exists to bound work on a pathological document rather than to save context.

Parsing is a hand-written tolerant scanner (`src/feed.ts`), no XML
dependency: real feeds carry unescaped `&`, unclosed `<link>`, `dc:` /
`content:` / `itunes:` namespaces and HTML entities inside CDATA, and a
strict parser turns any of those into a hard failure. DOCTYPEs — internal
subsets and `<!ENTITY>` included — are skipped, never expanded.

## Download options

`fetch` refuses binary content on purpose — every model-facing tool returns
text, and a base64 blob blows the inline budget while telling the model
nothing. `download` is the one path that writes bytes to disk, and it runs on
the **same transport** as everything else: same allowlist, same private-IP
rejection, same same-domain redirect lock, same TLS/UA pin.

```bash
dsh-network download -u https://example.com/photo.jpg                       # → os.tmpdir()/dsh-network/
dsh-network download -u https://example.com/photo.jpg --dest workspace     # → <workspace>/downloads/
dsh-network download -u https://example.com/x.bin --filename report.bin    # preferred name
```

| Flag | Meaning | Default |
|---|---|---|
| `--dest tmp\|workspace` | `tmp` → `os.tmpdir()/dsh-network/`; `workspace` → `<workspace>/downloads/`. | `tmp` |
| `--filename <name>` | Preferred filename. Still sanitized, and the extension is decided by the payload. | from `Content-Disposition`, else the URL |
| `--max-bytes <n>` | Byte cap for one transfer. | 100 000 000 |

`workspace` needs `DSH_NETWORK_WORKSPACE_DIR`; without it the call **fails**
rather than falling back to the server child's own cwd, which is wherever dsh
happens to have been launched.

Four rules do the real work:

- **The extension comes from the bytes.** Magic bytes first, then the
  `Content-Type`, and only then the filename — each rung exists because the
  one above it can lie. A server answering an image request with an HTML
  anti-bot page lands as `x.html`, not `x.png`.
- **Names cannot leave the root.** Separators, control characters, `..`,
  Windows device names and trailing dots/spaces are all neutralized, and the
  resolved path is checked against the destination root before the write.
- **Executables are refused.** `.exe`, `.ps1`, `.sh`, `.js`, `.bat`, … — a
  file in the workspace is one `pwsh -File` away from running. The check runs
  on the declared name AND the sniffed one, so `setup.exe` is refused whether
  or not its bytes look like an executable.
- **Nothing is ever truncated.** Past `--max-bytes` the transfer FAILS; the
  write is atomic (`.part` → rename), so a file that exists is a whole file.

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
  "results": [ /* SearchEntry | FetchEntry | HttpEntry | DownloadEntry | SitemapEntry */ ],
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

`download` is **never** cached, on purpose. The cache stores strings keyed by
`fetch|format|url` and serves previews; a download's product is a file, so a
warm hit could only rewrite it or hand back a stale copy of it. Re-downloading
is cheap, a silently clobbered workspace file is not — which is also why the
writer refuses to overwrite and picks `name-1.ext` instead.

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
