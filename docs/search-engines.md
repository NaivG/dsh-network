# Search engines

`web_search` and the sidebar panel run against a chain of engines. This guide
covers the chain, per-call pinning, every engine's credential and options, and
the fields that shape search as a whole. For the rest of the settings see
[configuration.md](configuration.md); for the internal registry see
[architecture.md](architecture.md#search-engine-registry).

## The chain

Six engines ship with the plugin. The chain is tried **in order**, and the
first engine that returns hits wins:

| Engine id | Source | Default chain | Credential |
|---|---|---|---|
| `bing` | HTML scrape of `www.bing.com/search` | ✅ #1 | none |
| `duckduckgo` | HTML scrape of `html.duckduckgo.com/html` | ✅ #2 | none |
| `baidu` | HTML scrape of `www.baidu.com/s` | ✅ #3 | none |
| `github` | hybrid REST `/search/{index}`, RRF-fused | opt-in | token optional |
| `searxng` | self-hosted SearXNG JSON API | opt-in | none (endpoint-scoped) |
| `brave` | Brave Search JSON API | opt-in | **keyed, billed** |

The three scrapers are always reachable; the other three need something to be
worth adding — a token, a self-hosted instance, or a subscription — so they are
never enabled behind your back. Default chain order is
`['bing', 'duckduckgo', 'baidu']`.

A **pin** bypasses the chain and queries one engine directly:

- the `web_search` tool takes an `engine` argument;
- the sidebar panel's engine picker carries the same choice;
- the CLI takes `--engine <id>`.

When an engine fails, search keeps going: every attempt lands in the result's
`attempts` array (`{ engine, error }`), and a chain that produced nothing still
returns warnings and uncertainty notes instead of a bare "no results".

## Managing the chain

Open **设置 → 网络 → 搜索引擎**, or edit `searchEngines` directly:

- Engine rows appear in chain order; the **Edit** dialog changes one engine.
- **Add search engine** picks a category from the engine list and appends it.
- At least one engine must stay in the chain — the last one cannot be removed.

An engine that is configured but not in the chain still reports its settings
(the real order of operations is *paste the key first, then add the engine*),
so a saved key is never invisible while you decide about the chain.

## The engine dialog

Each engine row opens an **Edit** dialog with up to three parts:

| Part | What it is |
|---|---|
| **Endpoint** | The engine's base URL. Locked for the built-ins that have a fixed endpoint; editable for SearXNG. |
| **API Key** | The engine credential, where it needs one. Write-only: the host stores it, the browser only ever reads back `hasApiKey`, and saving with the field empty keeps the key you already stored. |
| **Custom options** | Free-form parameters, one `key=value` per line, appended to the request. |

Custom options are validated by the engine *before* the request is built: an
unknown key or an out-of-vocabulary value is dropped, so a typo can never burn
a call on a 422.

## Built-in scrapers

`bing`, `duckduckgo`, and `baidu` have locked endpoints, take no options, and
need no credential. Baidu remains the best of the three for Chinese-language
queries; DuckDuckGo is the privacy-first fallback. They exist because a keyless
chain is what makes the plugin work on a fresh install.

## GitHub

Hybrid REST search over **repositories / code / issues / users**, fused by
weighted RRF. Anonymous search is limited to **10 req/min per IP**; a token
raises the quota to 30/min and enables the `code` index — without one, that
request is never sent and the engine reports the missing credential instead.

| Setting | Values | Default | Effect |
|---|---|---|---|
| **Token (optional)** | a fine-grained PAT | empty | raises the quota and enables code search; stored write-only |
| **Indexes** | `repositories` `code` `issues` `users` | empty = auto | pins the indexes to ask |
| **Repository sort** | Best match / Stars / Recently updated | `best` | repository ordering |

The token lives in its own **GitHub-specific settings** group rather than in an
engine dialog, because it is shared by every GitHub index. It is write-only
like the engine keys, and a **Clear** button removes it.

A pinned index list overrides the automatic intent routing. Automatic routing
reads the query: a `@handle` or `user:` targets **users**, a qualifier such as
`repo:` or `language:` targets **repositories**, "how to" / "usage" intent adds
**code**, and bug or error intent adds **issues**.

## SearXNG

A self-hosted metasearch instance reached through its **JSON API** — so the
engine is only as good as the instance you point it at.

1. Add `searxng` to the chain, then set its **Endpoint** in the dialog (default
   `http://127.0.0.1:8888`), or set `DSH_NETWORK_SEARXNG_URL` for a CLI run.
2. Enable `json` under `search.formats` in the instance's `settings.yml`.
   Without it every request gets a **403**.
3. Optionally add parameters:

| Parameter | Accepted values | Default | Effect |
|---|---|---|---|
| `language` | e.g. `en`, `zh-CN` | instance default | result language |
| `safesearch` | `0` `1` `2` | instance default | 0 off, 1 moderate, 2 strict |
| `timeRange` | `day` `month` `year` | unset | recency filter |
| `categories` | e.g. `general`, `news`, `it` | instance default | category selector |
| `pageno` | integer > 1 | unset | result paging |

Private-network access is granted for this engine **only when the configured
endpoint is itself loopback/private**; SSRF guards stay on for everything else.
A 403, a non-JSON body, and a JSON error body all surface as warnings rather
than a silent "no results".

## Brave

The Brave Search API — the only engine here that costs money, because its free
tier was removed (Feb 2026). It is never part of the default chain and never
sends a request until a key exists: with no key the engine short-circuits and
reports the missing credential.

1. Add `brave` to the chain (or pin it per call with `engine: "brave"`).
2. Paste the subscription token into the dialog's **API Key** field. It is the
   `X-Subscription-Token` header; the browser never reads it back.
3. Optionally add parameters:

| Parameter | Accepted values | Default | Effect |
|---|---|---|---|
| `country` | `DE`, `US`, … (two letters) | unset | country targeting |
| `searchLang` | `de`, `de-DE`, … | unset | content language |
| `uiLang` | `de`, `de-DE`, … | unset | response-metadata language |
| `freshness` | `pd` `pw` `pm` `py`, or `2024-01-01to2024-06-30` | unset | recency filter |
| `safesearch` | `off` `moderate` `strict` | unset | adult-content filter |
| `goggles` | an `http(s)` URL | unset | custom re-ranking |
| `offset` | `0`-`9` | unset | result paging |

`count` follows the call's result cap (max 20) and `extra_snippets=true` is
always on, so extra excerpts reach the snippet. `page_age` becomes the hit's
date — but only after a plausibility gate that drops anything outside
`[1990, next year]`, because a wrong date in the evidence is worse than no
date.

Check the credential state without spending anything: `dsh-network doctor`
prints `apiKeys=[brave=no key]`, and probing the endpoint with no credential is
free too.

## Credentials

Engine credentials live in `~/.dsh/dsh-network.json`, next to the rest of the
settings, and the browser only ever reads back *whether* a key is set:

- **Write-only.** After a save lands, the plaintext key is dropped from the UI
  draft, so later saves never re-send it.
- **One truth.** The green *API key configured* badge is a view of the stored
  key map, not a separate flag — a badge that says configured really means the
  engine will send its auth header.
- **Resolution order** (CLI side): the host's per-engine key map →
  the engine's own single-engine variable → the legacy GitHub token channel.

Without a usable credential the CLI sends **no request at all** for a keyed
engine: it synthesizes an auth failure so "no credential" and "rejected
credential" are reported on one code path instead of a mystery 401.

## Engine-level settings

These fields shape the whole chain. See
[configuration.md](configuration.md#field-reference) for the complete list.

| Field | Meaning | Default |
|---|---|---|
| `searchEngines` | Ordered engine chain. | `['bing','duckduckgo','baidu']` |
| `searchMaxResults` | Result cap handed to engines (hard cap 20). | `10` |
| `searchTimeoutMs` | Per-engine search timeout. | `15000` |
| `searchEngineConfigs` | Per-engine rows: endpoint, `hasApiKey` (a derived view), options. | `{}` |
| `searchEngineApiKeys` | The actual engine credentials. Write-only via the UI. | `{}` |
| `githubToken` | GitHub credential; stored, never echoed to the browser. | `""` |
| `githubIndexes` | Pinned GitHub indexes; empty = automatic intent routing. | `[]` |
| `githubSort` | GitHub result ordering. | `"best"` |

For headless and CLI runs the equivalents are `DSH_NETWORK_SEARXNG_URL`,
`DSH_NETWORK_GITHUB_TOKEN` (legacy channel, still honored),
`DSH_NETWORK_BRAVE_API_KEY` (single-engine runs), and the two maps the host
packs into every call — `DSH_NETWORK_SEARCH_ENGINE_API_KEYS` and
`DSH_NETWORK_ENGINE_OPTIONS`. They are JSON maps and are not meant to be set by
hand; see [configuration.md](configuration.md#environment-variables).

---

See also: [README](../README.md) · [CLI and cache paging](cli.md) ·
[Configuration](configuration.md) · [Architecture](architecture.md)
