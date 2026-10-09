# dsh-network documentation

Everything beyond the [README](../README.md): how to configure the plugin, what
its tools and engines do, how it is built, and how it works inside.

## Start here

- [Search engines](search-engines.md) — the chain, per-call pinning, every
  engine's credential and options, and the engine-level fields.
- [CLI and cache paging](cli.md) — the standalone CLI (`dsh-network search`,
  `fetch`, `-X`, `sitemap`, `doctor`, `server`), the JSON envelope, and how the
  server-side cache is paged.
- [Configuration](configuration.md) — where settings live, the seed defaults,
  the full field reference, environment variables, and the loopback routes.

## Under the hood

- [Architecture](architecture.md) — process model, per-call env snapshot, the
  result cache, the SSRF transport, the engine registry, the browser half, and
  `cordis.patch.yml`.
- [Development](development.md) — building, the test suite and smokes, the code
  layout, and the git-install `prepare` hook.

## Common questions

| I want to… | Read |
|---|---|
| add an engine, or pin one for a single search | [Search engines](search-engines.md) |
| use a GitHub token / a Brave key / my own SearXNG | [Search engines](search-engines.md#credentials) |
| turn a tool off, or change timeouts and the allowlist | [Configuration](configuration.md) |
| understand the `cacheId` / `offset` / `limit` paging | [CLI and cache paging](cli.md#cache-paging) |
| call the search or fetch path from a script or CI | [CLI and cache paging](cli.md) |
| let the model change settings by itself | [Configuration](configuration.md#web_config-tool-and-the-safety-toggle) |
| find out why a tool call failed | [README troubleshooting](../README.md#troubleshooting) |
| build, test, or ship a change | [Development](development.md) |

---

See also: [README](../README.md) — features, install, quick start.
