/**
 * dsh-network — web seam providers (host side).
 *
 * makeSearchProvider / makeFetchProvider adapt the CLI runner to dsh's
 * `web` seam contract (the searchProvider / fetchProvider rows consumed
 * by tool-web's model-facing tools). Split out of index.js.
 */
import { runCli } from './cli-runner.js'
import { toSearchSources, renderSearchSourceItem } from './evidence.js'

function makeSearchProvider(config) {
  return {
    id: 'dsh-network',
    available: () => true,
    async search(request, signal) {
      const args = ['search', '-q', request.query, '-t', String(60_000)]
      if (typeof request.maxResults === 'number') {
        args.push('--max-results', String(request.maxResults))
      }
      const entry = await runCli(args, signal, config)
      const sources = toSearchSources(entry.items)
      const truncated =
        typeof request.maxResults === 'number' && sources.length >= request.maxResults
      // `content` is ONE query's own slice of the answer. dsh's tool-web
      // merges several queries into a single card: it wraps each query's
      // content in a `### <query>` heading and pools every query's sources
      // into one list capped at `maxResults`. Returning only the summary left
      // those headings empty and let the pooled cap hide every source past
      // the first `maxResults` — a four-query call lost three quarters of its
      // hits for BOTH the model and the card. Listing this query's hits here
      // keeps each section self-contained; the full set still travels as
      // `sources` for any consumer of the seam contract.
      //
      // Sections join on BLANK lines: in the card's markdown a text line at
      // column 0 right after the list would lazy-continue the last item's
      // paragraph, and the old single-`\n` join could not even express a
      // blank line (an empty string was filtered out of `lines`).
      const sections = []
      if (entry.summary) sections.push(entry.summary)
      if (sources.length > 0) {
        sections.push(
          sources
            .map((source, index) => `${index + 1}. ${renderSearchSourceItem(source)}`)
            .join('\n'),
        )
      }
      const uncertainty = Array.isArray(entry.uncertainty) ? entry.uncertainty : []
      if (uncertainty.length > 0) sections.push(`Uncertain: ${uncertainty.join('; ')}`)
      return {
        content: sections.join('\n\n'),
        sources,
        truncated,
      }
    },
  }
}

function makeFetchProvider(config) {
  // The SSRF protection switch is read at every fetch — the settings
  // toggle mutates `config.ssrfProtection` in place, and the next tool
  // call picks up the new value without a plugin reload. Protections
  // default ON: only a disabled one is pushed to the CLI as a flag.
  //
  // dsh 0.1.5 note: the model-facing `web_fetch` tool is mounted per-session
  // by the agent preset's tool-web row, which consumes THIS provider through
  // the web seam. The seam contract (`WebFetchResult`) has no cacheId field,
  // so the server-side degrade (preview + cacheId) cannot travel structurally.
  // A degraded body is therefore flagged `truncated: true` and carries an
  // inline paging hint that routes the model to `http_request cacheId=...`
  // — the plugin's own tool, whose paging path shares the same server cache.
  // Dropping the cacheId silently (the 0.1.2-era behavior) left over-cap
  // pages as an unpageable 20k preview with `truncated: false`.
  return {
    id: 'dsh-network',
    available: () => true,
    async fetch(request, signal) {
      const cliArgs = ['fetch', '-u', request.url, '-t', String(60_000)]
      if (config && config.ssrfProtection === false) cliArgs.push('--allow-private-network')
      if (config && config.redirectProtection === false) cliArgs.push('--no-redirect-protection')
      if (config && config.protocolLock === false) cliArgs.push('--no-protocol-lock')
      const entry = await runCli(cliArgs, signal, config)
      let body = typeof entry.content === 'string' ? entry.content : ''
      const contentType = typeof entry.contentType === 'string' ? entry.contentType : ''
      const finalUrl = typeof entry.finalUrl === 'string' ? entry.finalUrl : request.url
      const status = typeof entry.statusCode === 'number' ? entry.statusCode : 0
      const truncatedByCache =
        typeof entry.cacheId === 'string' &&
        entry.cacheId !== '' &&
        Number.isInteger(entry.contentLength) &&
        entry.contentLength > body.length
      let truncated =
        truncatedByCache ||
        (Array.isArray(entry.warnings) && entry.warnings.some((w) => /truncated/i.test(w)))
      if (truncatedByCache) {
        const nextOffset = body.length
        body =
          `${body}\n\n[dsh-network] This is a ${body.length.toLocaleString()}-char preview of a ` +
          `${Number(entry.contentLength).toLocaleString()}-char page (server-side paging cache). ` +
          `Read the rest with the http_request tool: cacheId="${entry.cacheId}", ` +
          `offset=${nextOffset}, limit=20000 (url and cacheId are mutually exclusive).`
      }
      // The CLI emits Markdown by default; the seam accepts only `html` and
      // `text`. Markdown is text; the renderer on top of the seam will
      // surface it as-is.
      return {
        url: finalUrl,
        statusCode: status,
        body: { kind: 'text', content: body },
        truncated,
      }
    },
  }
}

export { makeSearchProvider, makeFetchProvider }
