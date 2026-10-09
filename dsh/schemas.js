/**
 * dsh-network — output schemas + enum vocabularies (host side).
 *
 * Pure data split out of index.js: the JSON Schema objects the five tools
 * register (`output.schema` and the `parameters` fragments) plus the
 * closed vocabularies (GitHub indexes / sorts, sitemap categories).
 * tests/schema-check.mjs extracts these constants from every host-side
 * module by name, so renames must stay in lockstep with that guard.
 */

const GITHUB_INDEX_IDS = ['repositories', 'code', 'issues', 'users']
const GITHUB_SORTS = ['best', 'stars', 'updated']
// Kept in lockstep with src/schema.ts (when that file exists) by a future
// test; for now they are duplicated verbatim here so this plugin file stays
// dependency-free (no `import` from compiled dist files, no JSON-loader
// requirement).
// JSON Schema subset enforced by `dsh-tools`: `required` is only valid on
// `type: "object"` nodes and must be a string array of property names. The
// earlier versions of these constants placed `required: true` inside each
// property — invalid; the loader rejected them at boot.
const SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'engine', 'summary', 'items', 'uncertainty', 'warnings', 'attempts'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded', 'unavailable'] },
    engine: { type: 'string' },
    summary: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
        },
      },
    },
    uncertainty: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    attempts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { engine: { type: 'string' }, error: { type: 'string' } },
      },
    },
  },
}
const FETCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'url',
    'finalUrl',
    'statusCode',
    'contentType',
    'engine',
    'summary',
    'content',
    'links',
    'uncertainty',
    'warnings',
  ],
  properties: {
    url: { type: 'string' },
    finalUrl: { type: 'string' },
    statusCode: { type: 'integer' },
    contentType: { type: 'string' },
    engine: { type: 'string' },
    summary: { type: 'string' },
    content: { type: 'string' },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'url'],
        properties: {
          text: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
    uncertainty: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    // Server-side cache paging — present when the underlying result was
    // degraded to cacheId+preview because it exceeded the inline cap
    // (~20 KB). The model can re-invoke with cacheId + offset/limit to
    // page through the rest of the content, sidestepping both the
    // child-process stdout chunking and the model's own truncation.
    cacheId: { type: 'string' },
    contentLength: { type: 'integer' },
    cacheSlice: {
      type: 'object',
      additionalProperties: false,
      required: ['offset', 'limit', 'total'],
      properties: {
        offset: { type: 'integer' },
        limit: { type: 'integer' },
        total: { type: 'integer' },
      },
    },
  },
}
// Closed-set category vocabulary for `web_sitemap`. Mirrored verbatim from
// src/sitemap.ts (kept inline so this plugin file stays dependency-free —
// the same trade-off the search/fetch/http schemas make).
const WEB_SITEMAP_CATEGORIES = [
  'code-repos', 'code-search', 'package-registries', 'qna',
  'encyclopedia', 'docs', 'manuals', 'standards',
  'news', 'tech-news', 'academic', 'ai-platforms',
  'datasets', 'devops', 'government', 'search',
  'social', 'video', 'music', 'maps',
  'shopping', 'finance', 'forum',
]

const SITEMAP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'engine', 'summary', 'entries', 'resolved', 'uncertainty', 'warnings'],
  properties: {
    status: { type: 'string', enum: ['ok', 'unavailable'] },
    engine: { type: 'string', enum: ['web_sitemap'] },
    summary: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['domain', 'description', 'category', 'priority', 'hasSearchUrl'],
        properties: {
          domain: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string', enum: WEB_SITEMAP_CATEGORIES },
          priority: { type: 'integer' },
          hasSearchUrl: { type: 'boolean' },
          language: { type: 'string' },
          region: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    resolved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['domain', 'query', 'url'],
        properties: { domain: { type: 'string' }, query: { type: 'string' }, url: { type: 'string' } },
      },
    },
    digest: { type: 'string' },
    uncertainty: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

const HTTP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'url',
    'finalUrl',
    'method',
    'statusCode',
    'statusText',
    'contentType',
    'headers',
    'body',
    'warnings',
  ],
  properties: {
    url: { type: 'string' },
    finalUrl: { type: 'string' },
    method: { type: 'string' },
    statusCode: { type: 'integer' },
    statusText: { type: 'string' },
    contentType: { type: 'string' },
    headers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value'],
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
    body: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    // Server-side cache paging — see FETCH_OUTPUT_SCHEMA. http_request
    // also degrades body+raw-headers when the response is too large for
    // a single round-trip across the loopback socket / the model.
    cacheId: { type: 'string' },
    contentLength: { type: 'integer' },
    cacheSlice: {
      type: 'object',
      additionalProperties: false,
      required: ['offset', 'limit', 'total'],
      properties: {
        offset: { type: 'integer' },
        limit: { type: 'integer' },
        total: { type: 'integer' },
      },
    },
  },
}

// web_config — read or modify the dsh-network configuration. The set
// action is gated by the user-controlled `allowConfigEdit` safety toggle;
// get always works so the model can read what it would otherwise be
// allowed to change. Secrets (githubToken, searchEngineApiKeys) are
// filtered out by `summarize()` — the model never sees them, only the
// `hasGithubToken` / `hasApiKey` booleans the editor card needs.
//
// The toggle itself is deliberately hidden from the model — neither in
// the output nor in the patch schema. The model never reads
// `allowConfigEdit` and can never write it. If it could, a single bad
// batched patch (e.g. `set({ allowConfigEdit: false, … })`) would
// lock the model out of its own write path for the rest of the
// session. The user is the only actor that can flip the toggle, and
// they do it from the browser's 网络 → 安全 section. The set error
// message ("the user must enable the `allowConfigEdit` safety toggle
// in …") is how the model learns the gate exists at all.
const WEB_CONFIG_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'action', 'config'],
  properties: {
    status: { type: 'string', enum: ['ok', 'error'] },
    action: { type: 'string', enum: ['get', 'set'] },
    config: { type: 'object' },
    // Set-action only: explanation when status === 'error' (most often
    // because the safety toggle is off), or persistence confirmation
    // when the change was written to disk.
    error: { type: 'string' },
    persisted: { type: 'boolean' },
  },
}

// JSON Schema for the `patch` argument on web_config.set. Mirrors what
// `applyCardSettings()` accepts so the model can only set fields the
// browser UI also edits. `allowConfigEdit` is deliberately omitted:
// the model has no business toggling its own write gate, and surfacing
// it would invite the "model locked itself out" footgun. Secrets
// (`githubToken`, per-engine API keys) are kept off the list for the
// same reason — the browser still doesn't expose them either.
const WEB_CONFIG_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    userAgent: { type: 'string' },
    allowlist: {
      type: 'array',
      items: { type: 'string' },
      description: 'Hostname allowlist (e.g. ["*.example.com"]); empty array = unrestricted.',
    },
    ssrfProtection: { type: 'boolean' },
    redirectProtection: { type: 'boolean' },
    protocolLock: { type: 'boolean' },
    fetchTimeoutMs: { type: 'integer' },
    searchTimeoutMs: { type: 'integer' },
    httpTimeoutMs: { type: 'integer' },
    maxBodyChars: { type: 'integer' },
    maxRedirects: { type: 'integer' },
    searchMaxResults: { type: 'integer' },
    searchEngines: {
      type: 'array',
      items: { type: 'string' },
      description: 'Search-engine chain order; one of bing, duckduckgo, baidu, github, searxng, brave.',
    },
    searchEngineConfigs: {
      type: 'object',
      description: 'Per-engine overrides (endpoint, hasApiKey, options). Engine API keys are NOT writable here — set them from the settings page.',
    },
    httpMethods: {
      type: 'array',
      items: { type: 'string' },
      description: 'Allowed http_request methods (uppercase).',
    },
    githubIndexes: {
      type: 'array',
      items: { type: 'string', enum: ['repositories', 'code', 'issues', 'users'] },
    },
    githubSort: { type: 'string', enum: ['best', 'stars', 'updated'] },
  },
}

/**
 * The subset of a `web_config.set` patch argument the tool actually forwards,
 * in schema order. ONE function, two readers: `execute()` writes it into the
 * live config, and `presentationMeta` names the fields a landed change touched
 * (the card's 变更 list). Keeping it here means the model cannot reach
 * `applyCardSettings()` with a field the schema does not list — a stray
 * `githubToken` or per-engine `apiKey` is dropped before the write path.
 */
function pickConfigPatch(patch) {
  const out = {}
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const key of Object.keys(WEB_CONFIG_PATCH_SCHEMA.properties)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key]
  }
  return out
}

export {
  GITHUB_INDEX_IDS,
  GITHUB_SORTS,
  pickConfigPatch,
  SEARCH_OUTPUT_SCHEMA,
  FETCH_OUTPUT_SCHEMA,
  WEB_SITEMAP_CATEGORIES,
  SITEMAP_OUTPUT_SCHEMA,
  HTTP_OUTPUT_SCHEMA,
  WEB_CONFIG_OUTPUT_SCHEMA,
  WEB_CONFIG_PATCH_SCHEMA,
}
