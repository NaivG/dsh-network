/**
 * dsh-network — evidence rendering (host side).
 *
 * Everything that turns a CLI envelope entry into the strings the model
 * sees (the tool contract's `render`) or the seam needs (`content`,
 * per-query source items), plus the presentationMeta helpers. Split out
 * of index.js; zero imports — pure functions over plain data.
 */

/** Map CLI search items to the seam's `WebSearchSource` shape. */
function toSearchSources(items) {
  if (!Array.isArray(items)) return []
  return items
    .filter((item) => item && typeof item.url === 'string' && item.url !== '')
    .map((item) => ({
      url: item.url,
      ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title } : {}),
      ...(typeof item.snippet === 'string' && item.snippet !== '' ? { snippet: item.snippet } : {}),
      ...(typeof item.published_at === 'string' && item.published_at !== ''
        ? { publishedAt: item.published_at }
        : {}),
    }))
}

const RENDER_CONTENT_CAP = 20_000
const RENDER_LINK_CAP = 20

/**
 * Build a presentationMeta-shaped object that survives a JSON
 * `stringify → parse` round-trip.
 *
 * `JSON.stringify` silently drops keys whose value is `undefined`, and the
 * harness validates every tool's `presentationMeta` for lossless round-trip
 * (a strict `JSON.parse(JSON.stringify(meta))` deep-equal against the
 * original). Any tool whose output carries optional fields must omit them
 * entirely when absent, otherwise the check trips with
 * "output.presentationMeta returned non-lossless JSON" and the tool call
 * is rejected before the model ever sees the result.
 *
 * `null` is preserved (it is JSON-safe), so callers can use either
 * `undefined` for "absent" or `null` for "explicitly empty" — both collapse
 * correctly in the rendered card.
 */
function compactPresentation(meta) {
  const out = {}
  for (const key of Object.keys(meta)) {
    const value = meta[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * Deep JSON-safe projection: drop every `undefined` at EVERY depth.
 *
 * `compactPresentation()` only scrubs the top level, which is enough for the
 * flat metas the other tools build but NOT for `web_config`, whose card meta
 * carries the live config summary. `summarize()` emits `endpoint: undefined`
 * for an engine that has no endpoint override, and the harness validates each
 * meta with a strict `JSON.parse(JSON.stringify(meta))` deep-equal against the
 * original — a nested `undefined` is silently dropped by `JSON.stringify`, so
 * the very first `web_config` call after a user cleared an engine endpoint
 * would be rejected with "output.presentationMeta returned non-lossless JSON"
 * and the model would never see its own config.
 *
 * Non-finite numbers collapse to `null` for the same reason (`JSON.stringify`
 * turns `NaN` / `Infinity` into `null`). Functions, symbols and `bigint` are
 * dropped like `undefined`; an array hole becomes `null`, because a hole
 * round-trips as one and the length must not shift. `depth` is a recursion
 * fence — this value is card decoration, never worth a stack overflow.
 */
function jsonSafeMeta(value, depth = 0) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type !== 'object') return undefined
  if (depth > 12) return undefined
  if (Array.isArray(value)) {
    return value.map((item) => {
      const safe = jsonSafeMeta(item, depth + 1)
      return safe === undefined ? null : safe
    })
  }
  const out = {}
  for (const key of Object.keys(value)) {
    const safe = jsonSafeMeta(value[key], depth + 1)
    if (safe !== undefined) out[key] = safe
  }
  return out
}

/**
 * Clip a tool body down to the card-side preview cap, marking the cut with a
 * single trailing `…`.
 *
 * Both `web_fetch` (contentPreview) and `http_request` (bodyPreview) persist a
 * preview in their `presentationMeta`, and their rows tell a truncated preview
 * from a complete one by exactly that marker — so the clip lives here, once,
 * rather than as a `slice(0, N) + '…'` inline in each registration.
 */
function previewText(text, cap = RENDER_CONTENT_CAP) {
  const body = typeof text === 'string' ? text : ''
  return body.length > cap ? `${body.slice(0, cap)}…` : body
}

function renderSearchEvidence(value) {
  const lines = []
  if (value.status === 'degraded') {
    lines.push(`[degraded: ${value.engine} answered second-hand, treat as indirect evidence]`)
  } else if (value.status === 'unavailable') {
    lines.push('[unavailable: all engines failed]')
  }
  lines.push(value.summary || '')
  const items = Array.isArray(value.items) ? value.items : []
  if (items.length > 0) {
    lines.push('', 'Sources:')
    items.forEach((item, index) => {
      const dated = item.published_at ? ` (${item.published_at})` : ''
      lines.push(`${index + 1}. ${item.title || item.url}${dated} — ${item.url}`)
      if (item.snippet) lines.push(`   ${item.snippet}`)
    })
  }
  if (Array.isArray(value.uncertainty) && value.uncertainty.length > 0) {
    lines.push('', `Uncertain: ${value.uncertainty.join('; ')}`)
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `Warnings: ${value.warnings.join('; ')}`)
  }
  if (Array.isArray(value.attempts) && value.attempts.length > 0) {
    lines.push('', `Attempts: ${value.attempts.map((a) => `${a.engine}: ${a.error || 'ok'}`).join('; ')}`)
  }
  return lines.join('\n')
}

// The CLI/server emits a six-field slice descriptor
// ({offset, limit, start, end, total, more}); the tool output schemas (and
// the documented envelope) expose only the three paging-relevant fields, so
// narrow here — before the value reaches output validation — or the strict
// additionalProperties:false schema rejects every paged response.
function toHostCacheSlice(slice) {
  return {
    offset: Number(slice.offset),
    limit: Number(slice.limit),
    total: Number(slice.total),
  }
}

function renderFetchEvidence(value) {
  const lines = [value.summary || '']
  // Paging descriptor BEFORE the body — same rationale as renderHttpEvidence:
  // output retention truncates long tails, and the cacheId must survive it.
  if (
    typeof value.cacheId === 'string' &&
    value.cacheId !== '' &&
    Number.isInteger(value.contentLength) &&
    value.contentLength > value.content.length
  ) {
    // The next-offset hint must be the ABSOLUTE position of the served slice
    // (cacheSlice.offset + shown chars), not the slice-local length: on a
    // paged read the body is a 1-2k-char slice, and hinting offset=<slice
    // length> would send the model back to the top of the page.
    const nextOffset =
      value.cacheSlice && Number.isInteger(value.cacheSlice.offset)
        ? value.cacheSlice.offset + value.content.length
        : value.content.length
    lines.push(
      `Paged: showing ${value.content.length.toLocaleString()} of ${Number(value.contentLength).toLocaleString()} chars. ` +
        `Read the rest with web_fetch: cacheId="${value.cacheId}", offset=${nextOffset}, limit=20000.`,
    )
  }
  const content = typeof value.content === 'string' ? value.content.trim() : ''
  if (content) {
    lines.push(
      '',
      'Content:',
      content.length > RENDER_CONTENT_CAP ? `${content.slice(0, RENDER_CONTENT_CAP)}…` : content,
    )
  }
  const links = Array.isArray(value.links) ? value.links.slice(0, RENDER_LINK_CAP) : []
  if (links.length > 0) {
    lines.push('', 'Links:')
    for (const link of links) lines.push(`- ${link.text} — ${link.url}`)
  }
  if (Array.isArray(value.uncertainty) && value.uncertainty.length > 0) {
    lines.push('', `Uncertain: ${value.uncertainty.join('; ')}`)
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `Warnings: ${value.warnings.join('; ')}`)
  }
  return lines.join('\n')
}

function renderHttpEvidence(value) {
  const lines = [`HTTP ${value.statusCode} ${value.statusText || ''} ${value.finalUrl}`]
  // Cache paging descriptor goes BEFORE the body: the harness's output
  // retention can cut a long body tail, and a cacheId trailing the body is
  // then lost with it (defect: the model could never see the id to page).
  const degraded =
    typeof value.cacheId === 'string' &&
    value.cacheId !== '' &&
    Number.isInteger(value.contentLength) &&
    value.contentLength > (typeof value.body === 'string' ? value.body.length : 0)
  if (degraded) {
    // Same next-offset rule as renderFetchEvidence: absolute position
    // (cacheSlice.offset + shown chars), never the slice-local length.
    const nextOffset =
      value.cacheSlice && Number.isInteger(value.cacheSlice.offset)
        ? value.cacheSlice.offset + value.body.length
        : value.body.length
    lines.push(
      `Paged: showing ${value.body.length.toLocaleString()} of ${Number(value.contentLength).toLocaleString()} chars. ` +
        `Read the rest with http_request: cacheId="${value.cacheId}", offset=${nextOffset}, limit=20000.`,
    )
  }
  if (value.contentType) lines.push(`Content-Type: ${value.contentType}`)
  for (const h of Array.isArray(value.headers) ? value.headers : []) {
    lines.push(`${h.name}: ${h.value}`)
  }
  const body = typeof value.body === 'string' ? value.body : ''
  lines.push('', body.length > RENDER_CONTENT_CAP ? `${body.slice(0, RENDER_CONTENT_CAP)}…` : body)
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `Warnings: ${value.warnings.join('; ')}`)
  }
  return lines.join('\n')
}

// ─────────── GFM source-item rendering (seam `content`) ───────────

// GFM hard break: exactly two trailing spaces. Inside one paragraph a bare
// `\n` is a soft break and renders as a space in dsh's markdown renderer —
// only a hard break produces a real second line.
const GFM_HARD_BREAK = '  '
// The description line's indent. Four spaces is the content column of a
// two-digit `10. ` marker, so the line stays a paragraph continuation of the
// list item for both one- and two-digit numbers (an indented code block
// would need content column + 4).
const SEARCH_DESC_INDENT = '    '

/**
 * Render one seam search source as a TWO-line markdown list item: the first
 * line is the linked label (the engine's title, or the bare hostname when it
 * gave none), the second line — one GFM hard break below — carries the
 * snippet and the date when present. The search card renders each hit as a
 * blue link with its description on a line of its own.
 *
 * The label is flattened to a single line and stripped of `[` / `]` so an
 * engine title can never break out of the surrounding link.
 */
function renderSearchSourceItem(source) {
  let label = source.url
  if (typeof source.title === 'string' && source.title !== '') {
    label = source.title
  } else {
    try {
      label = new URL(source.url).hostname
    } catch {
      label = source.url
    }
  }
  label = label.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim() || source.url
  const link = `[${label}](${source.url})`
  const meta = []
  if (typeof source.snippet === 'string' && source.snippet !== '') {
    meta.push(source.snippet.replace(/\s+/g, ' '))
  }
  if (typeof source.publishedAt === 'string' && source.publishedAt !== '') {
    meta.push(`(${source.publishedAt})`)
  }
  if (meta.length === 0) return link
  return `${link}${GFM_HARD_BREAK}\n${SEARCH_DESC_INDENT}${meta.join(' ')}`
}

// ───────────────────── web_config evidence ─────────────────────

function renderConfigEvidence(value) {
  const lines = []
  if (value.status === 'error') {
    lines.push(`[error: ${value.error || 'set refused'}]`)
  }
  lines.push(
    `action: ${value.action}`,
    '',
    'Config:',
    JSON.stringify(value.config, null, 2),
  )
  if (value.persisted === true) lines.push('', '(persisted to disk)')
  return lines.join('\n')
}

// ───────────────────── web_sitemap evidence ────────────────────

function renderSitemapEvidence(value) {
  const lines = []
  if (value.status === 'unavailable') {
    lines.push('[unavailable: web_sitemap returned no usable entry]')
  }
  lines.push(value.summary || '')
  const entries = Array.isArray(value.entries) ? value.entries : []
  if (entries.length > 0) {
    lines.push('', 'Portals:')
    entries.forEach((entry, index) => {
      const lang = entry.language ? ` [${entry.language}]` : ''
      const region = entry.region ? ` (${entry.region})` : ''
      const tail = entry.hasSearchUrl ? ' — has search URL' : ''
      lines.push(
        `${index + 1}. ${entry.domain}${lang}${region} (p${entry.priority}, ${entry.category})${tail} — ${entry.description}`,
      )
    })
  }
  const resolved = Array.isArray(value.resolved) ? value.resolved : []
  if (resolved.length > 0) {
    lines.push('', 'Resolved search URLs:')
    for (const r of resolved) lines.push(`- ${r.domain}: ${r.url}`)
  }
  if (typeof value.digest === 'string' && value.digest !== '') {
    lines.push('', 'Digest:', value.digest)
  }
  if (Array.isArray(value.uncertainty) && value.uncertainty.length > 0) {
    lines.push('', `Uncertain: ${value.uncertainty.join('; ')}`)
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `Warnings: ${value.warnings.join('; ')}`)
  }
  return lines.join('\n')
}

export {
  toSearchSources,
  compactPresentation,
  jsonSafeMeta,
  previewText,
  renderSearchEvidence,
  toHostCacheSlice,
  renderFetchEvidence,
  renderHttpEvidence,
  renderConfigEvidence,
  renderSitemapEvidence,
  renderSearchSourceItem,
  RENDER_CONTENT_CAP,
}
