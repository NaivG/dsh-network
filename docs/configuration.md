# Configuration reference

How `dsh-network` is configured: where the settings live, what every field
does, and which environment variables the CLI and host honor. For the search
engine chain and per-engine options see [search-engines.md](search-engines.md);
for the CLI see [cli.md](cli.md); for the internal design see
[architecture.md](architecture.md).

## Where settings live

- **Edit them in the dsh web UI: 设置 → 网络.** The section reads
  `GET /dsh-network/config` and writes `PUT /dsh-network/config` against the
  host's live config object, so policy fields take effect on the **next tool
  call** — no restart. The tool toggle switches (`webSearchTool`,
  `webFetchTool`, `httpRequestTool`, `webSitemapTool`) work live too:
  flipping one off makes the matching tool's next call fail fast, and the
  sidebar search route answers 403 while `webSearchTool` is off. Restarting
  dsh fully unregisters disabled tools.
- **Persistence** comes from a dedicated store, not dsh's settings document:
  every successful UI save atomically snapshots the live config to
  `~/.dsh/dsh-network.json` (`DSH_NETWORK_CONFIG_FILE` overrides the path).
  The persisted snapshot wins over the cordis row config. Delete the file to
  reset to the seed. A corrupted file is ignored with a warning.
- **The kill switch** is the `enabled` field of the cordis row config only.
  It is never persisted and is stripped from any hand-written file.
- **Secrets** (`githubToken`, engine API keys) ride in the persisted file
  like other plugins' keys in `settings.yaml`. The browser only ever reads
  back `hasApiKey`, never the key itself.

## Seed defaults

These are the values `cordis.patch.yml` writes into the cordis row on a
fresh install:

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

Fields not listed here default from the host plugin: the three protections
(`ssrfProtection`, `redirectProtection`, `protocolLock`) default to ON;
`githubToken` and `searchEngineApiKeys` start empty; `githubIndexes` is
empty; `githubSort` defaults to `"best"`; `allowConfigEdit` defaults to
`false`.

## Field reference

| Field | Meaning | Default |
|---|---|---|
| `enabled` | Plugin kill switch. Row-config only; never persisted by UI saves. | `true` |
| `allowlist` | Extra hostnames the fetch/HTTP transport may reach even if SSRF rules would reject them. | `[]` |
| `userAgent` | User-Agent for all outbound traffic (Firefox-154 baseline). | see seed |
| `fetchTimeoutMs` | Per-call timeout for `web_fetch`. | `25000` |
| `searchTimeoutMs` | Per-call timeout for `web_search`. | `15000` |
| `httpTimeoutMs` | Per-call timeout for `http_request`. | `25000` |
| `maxBodyChars` | Largest response body accepted. | `3000000` |
| `maxRedirects` | Redirect hop budget. | `3` |
| `searchEngines` | Live engine chain, tried in order. | `['bing','duckduckgo','baidu']` |
| `searchMaxResults` | Result cap handed to engines (hard cap 20). | `10` |
| `webSearchTool` | Enables the `web_search` tool AND the sidebar search route. | `true` |
| `webFetchTool` | Enables the `web_fetch` tool. | `true` |
| `httpRequestTool` | Enables the `http_request` tool. | `true` |
| `webSitemapTool` | Enables the `web_sitemap` tool. | `true` |
| `httpMethods` | Methods `http_request` may send. | all seven |
| `ssrfProtection` | Reject loopback/private/reserved targets. Supersedes the legacy `allowPrivateNetwork` flag. | `true` |
| `redirectProtection` | Reject redirects that leave the original domain. | `true` |
| `protocolLock` | Reject redirects that switch between http and https. | `true` |
| `githubToken` | GitHub credential: raises search quota and enables the code index. Stored, never echoed to the browser. | `""` |
| `githubIndexes` | Pin GitHub index selection (`repositories` / `code` / `issues` / `users`). Empty = automatic intent routing. | `[]` |
| `githubSort` | GitHub result ordering. | `"best"` |
| `searchEngineConfigs` | Per-engine rows: endpoint, `hasApiKey` (a derived view), free-form `options`. | `{}` |
| `searchEngineApiKeys` | The actual engine credentials. Write-only via the UI. | `{}` |
| `allowConfigEdit` | Gates `web_config`'s `set` action. Visible ONLY in 设置 → 网络 → 安全; hidden from the model on both `get` and `set`. | `false` |

## Engines

The default chain is **Bing → DuckDuckGo → Baidu**. Three more engines are
available, all opt-in, and they need nothing beyond the fields above:

- **GitHub** — hybrid REST search over repositories / code / issues / users,
  fused by RRF. Anonymous search is limited to 10 req/min per IP; a token
  raises the quota and enables the code index. Configure it in the
  **GitHub-specific settings** group (or the legacy `DSH_NETWORK_GITHUB_TOKEN`
  env var).
- **SearXNG** — add `searxng` to `searchEngines` and set its endpoint in the UI
  or via `DSH_NETWORK_SEARXNG_URL` (default `http://127.0.0.1:8888`). The
  instance must enable `json` in `search.formats`, or every request gets a
  403. Private-network access is granted for this engine only when the
  configured endpoint is itself loopback/private.
- **Brave** — keyed and billed per query, so it is never in the default chain.
  Paste the subscription token in the engine dialog, then add `brave` to
  `searchEngines` (or pin it per call). Without a key, no request is sent at
  all.

The dialogs, the full per-engine option tables (`country`, `freshness`,
`categories`, `pageno`, …), and how credentials are stored and resolved live in
[search-engines.md](search-engines.md).

## Environment variables

| Variable | Read by | Purpose |
|---|---|---|
| `DSH_NETWORK_CONFIG_FILE` | host (`dsh/persist.js`) | Override the persisted-config path (default `~/.dsh/dsh-network.json`). |
| `DSH_NETWORK_CLI` | host (`dsh/serverClient.js`) | Override the CLI bundle path; resolves `dist/cli.cjs` relative to the plugin by default. Used by tests. |
| `DSH_NETWORK_SEARXNG_URL` | CLI | SearXNG endpoint (default `http://127.0.0.1:8888`). |
| `DSH_NETWORK_GITHUB_TOKEN` | CLI | Legacy GitHub credential channel (still honored after the engine API-key map). |
| `DSH_NETWORK_BRAVE_API_KEY` | CLI | Standalone Brave key for a single-shot CLI run outside the host. |
| `DSH_NETWORK_SEARCH_ENGINE_API_KEYS` | CLI | JSON map `{ engineId: key }` the host packs into every `/invoke` env snapshot. Not meant to be set by hand. |
| `DSH_NETWORK_ENGINE_OPTIONS` | CLI | JSON map `{ engineId: { … } }` of per-engine options from the settings dialog's `key=value` textarea. |
| `DSH_TOOLS_PATH` | tests only | Helps `tests/schema-check.mjs` locate the dsh-tools package. |

## `web_config` tool and the safety toggle

- `web_config` `get` always works. `set` applies a partial patch to the same
  fields the browser UI edits, but only while the user has enabled the
  `allowConfigEdit` toggle in **设置 → 网络 → 安全**. While it is off, `set`
  returns a soft error that tells the user how to enable it.
- The toggle is hidden from the model — it does not appear in the `get`
  response or in the `set` patch schema — so a malformed batched patch cannot
  lock the model out of its own write path. Only the browser user can flip
  it.
- Secrets (`githubToken`, `searchEngineApiKeys`) are stripped from both the
  read and write paths of the tool.
- Each call renders as a card in the transcript (see
  [architecture](architecture.md#tool-card-overrides)). A read collapses to
  `网络配置 · 读取配置 · N 个引擎`; a write opens and lists every field it
  changed **with the value the host actually stored**, so a clamped value reads
  as a clamp; a write the toggle refused shows as an amber *已被拒绝* block.
  The card's config snapshot is the same model-facing summary, so the toggle and
  the secrets are absent there too.

## Loopback routes

The host registers on `ctx.webServer`, all behind the same fence dsh's own
`/api` uses (loopback + `sec-fetch-site: same-origin` + Origin == Host):

| Route | Purpose |
|---|---|
| `GET/PUT /dsh-network/config` | The settings section's read/write API |
| `GET/POST /dsh-network/search` | Sidebar search panel backend; additionally gated by the live `webSearchTool` toggle (403 when off) |
| `GET /dsh-network/health` | Readiness / cache stats |

---

See also: [README](../README.md) · [Search engines](search-engines.md) ·
[CLI and cache paging](cli.md) · [Architecture](architecture.md)
