<div align="center">

![social-preview](assets/social-preview.png)

# dsh-network

Let DeepSeek Harness access the internet seamlessly.

**English** | [简体中文](README.ZH.md)

[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@naivg/dsh-network?logo=npm&color=cb3837)](https://www.npmjs.com/package/@naivg/dsh-network)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5_0.1.0.rc2-4D6BFE?logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-darkblue)](https://github.com/topics/dsh-plugin)
[![Listed on DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/naivg/dsh-network)

</div>

`dsh-network` gives DeepSeek Harness a complete web toolkit — **five model-facing
tools**, a **Network settings section**, a **sidebar web-search panel**, and
tool-card renderers that already look like the rest of the app.

It replaces the official `tool-web` `web_search` / `web_fetch` with a long-lived
loopback Node process that talks to the web through `undici`. Oversized results
page through a server-side cache, so the model reads past the inline cap
instead of losing the tail. No API key is needed for the default search chain,
and every opt-in engine stays opt-in.

Works with `dsh: 0.1.0.rc2` or later.

## Why this plugin

DeepSeek Harness ships `web_search` and `web_fetch`, and that covers a fair
amount of ground until the model walks into one of these walls:

- Long pages come back cut off.
- Direct links to documents are returned to the model in binary format.
- A feed URL comes back as a wall of XML instead of a list of articles.
- Two tools are not a web toolkit.
- None of it is yours to inspect.

`dsh-network` takes the `web` seam over and replaces that pair with a
long-lived Node process:

- **Multiple search engines** — Bing, DuckDuckGo, Baidu, tried in order by 
  default. GitHub, SearXNG and Brave join when you want them.
- **Nothing gets truncated.** Oversized fetch and HTTP bodies land in a
  server-side cache; the model pages through them with a `cacheId` instead of
  losing the tail.
- **Five tools** — search, fetch, raw `http_request`, a curated portal lookup
  (`web_sitemap`), and `web_config` for the live settings; plus `web_download`
  for saving binary files, **off by default** (see [Settings](#settings)).
- **Answers you can cite** — title, link, snippet and date per hit, plus an
  explicit uncertainty note when the engines disagree.
- **Documents and feeds arrive as Markdown.** PDF, Word, PowerPoint, Excel,
  ODF and EPUB responses are parsed instead of handed over as bytes. RSS 2.0,
  RSS 1.0 (RDF) and Atom 1.0 feeds render as one Markdown entry per item —
  title, date, author, link and body — instead of a wall of XML tags.
- **A settings section and a sidebar search panel**, so you can reorder the
  chain, paste a key, and search yourself without editing a config file. Edits
  land on the next tool call — no restart.
- **Safety on by default** — per-redirect SSRF validation, IP pinning,
  private-range blocking and a protocol lock, all in-process.
- **Integrate It into Your App**: dsh-network was designed with the official CSS 
  style in mind, so it renderers that already look like the rest of the app.

The trade is one extra Node process, owned by the plugin, and the `web` seam
stays claimed until you uninstall it.

## What you get

| Tool | What it does |
|---|---|
| `web_search` | Searches the web through the configured engine chain (default **Bing → DuckDuckGo → Baidu**). Returns citeable sources (title, link, snippet, date), a summary, a status flag, and uncertainty notes. One engine can be pinned per call. |
| `web_fetch` | Fetches one HTTP(S) URL and returns Markdown by default or the raw body on request, with outgoing links and warnings. PDF, OOXML (`docx`/`pptx`/`xlsx`), ODF (`odt`/`odp`/`ods`), and EPUB responses are converted to clean Markdown instead of binary bytes. **RSS 2.0, RSS 1.0 (RDF) and Atom 1.0 feeds are recognized by their root element** — `<rss>`, `<feed>`, `<rdf:RDF>` — and rendered item by item, so a subscription reads as entries rather than raw XML ([details](docs/cli.md#feeds)). |
| `http_request` | Issues a low-level HTTP(S) request with full method, header, and body control. |
| `web_sitemap` | Looks up a curated table of **178** authoritative portals — 23 categories spanning arxiv, MDN, package registries, Q&A sites, government, news, video… — by domain, category, priority, or free-text query, optionally returning a paste-able digest. |
| `web_config` | Reads the live dsh-network configuration, or applies a partial patch when you have enabled the safety toggle (see [Settings](#settings)). Full behaviour: [configuration.md](docs/configuration.md#web_config-tool-and-the-safety-toggle). |
| `web_download` | **Off by default** — turn it on under Settings → 网络 → 工具 and the model can save a binary file (image, archive, media, font) to disk and get its path back. It runs on the *same* transport as every other tool — same allowlist, same per-hop private-range block, same same-domain redirect lock — because the alternative is the model reaching for `curl`, and one injected page is enough to aim that at `169.254.169.254`. The extension comes from the payload rather than the URL (a `.png` that is really an HTML anti-bot page is not worth handing to an image reader), the path cannot escape its destination root, executable extensions are refused outright, and going over the size cap **fails instead of truncating**. Files land in the temp directory unless you explicitly ask for the workspace. |

### Tool cards

Every tool renders as a first-party-style dsh card — a borderless disclosure
row over the result body:

<div align="center" class="toolview">

<img src="assets/search-tool.png" width="600" alt="web_search card"/>

`web_search` tool

<img src="assets/sitemap-tool.png" width="600" alt="web_sitemap card"/>

`web_sitemap` tool

<img src="assets/httprequest-tool.png" width="600" alt="http_request card"/>

`http_request` tool

<img src="assets/config-tool.png" width="600" alt="web_config card"/>

`web_config` tool

</div>

`web_config` gets the same treatment. A read collapses to
`Network config · Read config · N engines`; a write opens on its own and lists
every field it changed **with the value that was actually stored**, so a
request the host clamped (ask for `searchMaxResults: 50`, get `20`) reads as a
clamp rather than as the request; and a write the safety toggle refused shows
as an amber *refused* block — never as a silent no-op, and never as a change
list of edits that did not happen. The live config itself sits underneath as
labelled groups (engine chain with key chips, timeouts, protections, allowlist,
caps, tool switches, GitHub) over the raw JSON.

`web_fetch` / `http_request` bodies above the inline cap (about 20 KB) come
back as a preview plus a `cacheId`, and the model pages through the rest with
one more call — see [CLI and cache paging](docs/cli.md#cache-paging). An
oversized feed degrades the same way, but its preview always stops on a whole
entry boundary, so the model can read the first items and jump straight to
entry 40 with one `cacheId` call instead of re-fetching the URL.

### Support search engines

| Engine id | Credential |
|---|---|
| `bing` | none |
| `duckduckgo` | none |
| `baidu` | none |
| `github` | token optional |
| `searxng` | none (endpoint-scoped) |
| `brave` | **keyed, billed** |

See [Search engines](docs/search-engines.md) for more details.

### Sidebar web search

The dsh web UI gains a **Web Search** entry in the sidebar, after Plugins and
Schedules. The panel runs the same search path as the `web_search` tool and is
gated by the same toggle.

## Install

```bash
# from npm:
dsh plugin --profile web add @naivg/dsh-network

# or from GitHub (builds the CLI bundle during install):
dsh plugin --profile web add github:NaivG/dsh-network --allow-build=@naivg/dsh-network

# or from a local checkout:
dsh plugin --profile web add link:<path-to-this-checkout>
cd <path-to-checkout>      # link installs only
pnpm install
pnpm build

dsh web
```

The loader then applies `cordis.patch.yml` for you: the `web` seam providers
switch to dsh-network, the legacy `tool-web` `web_search` / `web_fetch` get
disabled, and the plugin row is inserted with default settings.

> **Why `--allow-build`?** The CLI bundle (`dist/cli.cjs`) is built during
> install by the package's `prepare` script, and pnpm 12 blocks build scripts
> of git-hosted dependencies unless you allow them. If every tool call fails
> with `dsh-network CLI bundle is missing`, the prepare script did not run —
> reinstall with the flag above, or see
> [development.md](docs/development.md#git-installs-and-the-prepare-hook) for
> the `allowBuilds` alternative.

## Quick start

1. `dsh web`, then open **设置 → 网络** (Settings → Network). Flip
   **Allow the model to modify settings** on only if you want the model to be
   able to change this plugin's settings itself.
2. Ask something that needs the live web — "search for the latest TypeScript
   release notes and cite the sources". The `web_search` card shows the
   engines' answer with the sources underneath.
3. Prefer clicking to typing? Open **Web Search** in the sidebar and run the
   same query from there.
4. Add engines, paste a GitHub token, or tune timeouts in the same settings
   section — edits apply to the next tool call, no restart.

On a fresh install nothing needs configuring: the default chain is keyless, and
the engines that would cost you something (or need a server of yours) are never
enabled behind your back.

## Settings

Everything lives in **设置 → 网络** and takes effect on the next tool call:

- **Search engines** — the live chain (default Bing → DuckDuckGo → Baidu), with
  a per-engine **Edit** dialog for endpoint, **API Key**, and custom
  `key=value` options. See [search engines](docs/search-engines.md).
- **Tool switches** — `webSearchTool`, `webFetchTool`, `httpRequestTool`,
  `webSitemapTool`. Flipping one off makes the matching tool fail fast, and the
  sidebar search route answers 403 while Web search is off. Restarting dsh
  fully unregisters the disabled tools.
- **`downloadTool` is off by default.** It is the only tool here that writes to
  disk, so the user opts in; once on, the model can neither read nor flip that
  switch (handled exactly like `allowConfigEdit`).
- **Safety** — SSRF protection, redirect protection, and protocol lock are ON
  by default, next to the model-settings toggle above.
- Timeouts, User-Agent, result cap, redirect budget, allowed HTTP methods, and
  the host allowlist all sit in the same section.

Settings persist to `~/.dsh/dsh-network.json`; delete that file to reset.
Secrets (GitHub token, engine API keys) are stored there too — the browser only
ever shows whether a key is configured, never the key itself. The full field
reference, including the loopback routes, is in
[configuration.md](docs/configuration.md).

## Safety

- All traffic goes through `undici`. The plugin never shells out to
  `curl.exe`, `nslookup.exe`, or any other external binary.
- Per-redirect SSRF validation, IP pinning, and private/reserved range blocking
  are on by default; the allowlist is empty (unrestricted) until you set one.
- The transport refuses true binary content (image, audio, video, font,
  archive, generic octet-stream). Only a fixed allowlist of document MIME types
  is parsed to Markdown. The one exception is `web_download` asking to save a
  file — and it takes the same transport rather than opening its own socket.
- The loopback server binds to `127.0.0.1` only, and request bodies are capped.
- `web_config`'s `set` action is gated by a toggle the model can neither read
  nor write, so a bad patch can never lock the model out of its own write path.
- `web_download` adds three more fences: the filename cannot escape its
  destination root (separators, `..` and Windows device names are neutralized,
  and the resolved path is re-checked before the write); executable extensions
  (`.exe`/`.ps1`/`.sh`/`.js`/`.bat`/…) are refused, checking both the declared
  name and the sniffed one; and going over the byte cap **fails** rather than
  truncating, with an atomic `.part` → rename write, so a file that exists is a
  whole file.

## Troubleshooting

- **`npx @naivg/dsh-network doctor`** prints the resolved configuration — engine
  chain, timeouts, which API keys are configured — without contacting anything.
  Safe offline, and the first thing to check.
- **`dsh-network CLI bundle is missing`** — the CLI build was skipped, which can
  only happen on a git or link install (the published tarball ships `dist/`).
  Reinstall the GitHub route with `--allow-build=@naivg/dsh-network`, or run
  `pnpm install && pnpm build` in the checkout (link installs). See
  [development.md](docs/development.md#git-installs-and-the-prepare-hook).
- **A keyed engine says "no credential"** — paste the key in that engine's
  **Edit** dialog and save; the row badge turns green only when a key is really
  stored. See [search engines](docs/search-engines.md#credentials) for the
  credential rules.
- **SearXNG answers 403** — enable `json` under `search.formats` in your
  instance's `settings.yml`. See
  [search engines](docs/search-engines.md#searxng).
- **The sidebar search panel is missing** — it only mounts when the plugin is
  present and the Web search toggle is on.
- **Want to reset everything?** Delete `~/.dsh/dsh-network.json`
  (`DSH_NETWORK_CONFIG_FILE` overrides the path) and restart dsh.

## Documentation

- [Search engines](docs/search-engines.md) — chain, pinning, and every engine's
  credential and options.
- [CLI and cache paging](docs/cli.md) — the standalone CLI, the result
  envelope, and how the cache is paged.
- [Configuration](docs/configuration.md) — every field, every environment
  variable, the loopback routes.
- [Architecture](docs/architecture.md) — process model, transport, engine
  registry, browser half.
- [Development](docs/development.md) — building, testing, code layout.

## Thanks

- [Deepseek Harness](https://github.com/deepseek-ai/deepseek-harness) - Plugin Design, Implementation, and References.
- [Deepseek](https://deepseek.com) - Reference images of deepseek for our Social preview. 

## License

MIT. See [LICENSE](LICENSE).

