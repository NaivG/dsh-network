/* dsh-web browser half for dsh-network — tool-call card renderers
 * (package-local chunk, materialized via require.async from dsh/client.js).
 *
 * Five `tool.call.toolview` rows (web_search / http_request / web_fetch /
 * web_sitemap / web_config) styled to read like dsh's own first-party tool
 * cards — a borderless disclosure row over a WebBlock-styled body card — plus
 * the legacy `tool.web.item` / `tool.web.fetch.item` block renderers for older
 * dsh builds. All renderers are reactive, fall back to the raw body when a
 * piece of structured data is missing, and never mutate session state.
 *
 * Chunk protocol: this file sits next to dsh/client.js and matches the
 * loader's `client.<name>.js` chunk naming, so the dsh host serves it on
 * demand at /plugins/dsh-network/client.toolviews.js?rev=… The factory
 * requires the entry ('dsh-network') for the shared i18n label helper and
 * must stay SELF-CONTAINED otherwise — chunks cannot synchronously
 * require each other.
 */

window.__ModuleLoader__.load({
  id: 'dsh-network',
  chunk: 'client.toolviews.js',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    // Shared surface from the entry module (dsh/client.js).
    var shared = require('dsh-network')
    var labelText = shared.labelText
    // `isRenderable` — NOT a `typeof … === 'function'` test. dsh ships
    // MarkdownText / TextShimmer through React.memo, so they arrive as memo
    // objects; the function-only guard this file used to carry always failed
    // and sent every answer to the raw `<pre>` fallback (literal `###`, raw
    // `[title](url)`, `&nbsp;`). `markdownLabels` supplies the renderer's
    // required label seats (see markdownLabels(t) in dsh-client-ui-tool).
    var isRenderable = shared.isRenderable
    var markdownLabels = shared.markdownLabels

    // The renderers below are wired into `slot.tool.web.*` slots when
    // they exist on the host page. They never re-fetch; they read the
    // tool's `result.meta` (the structured projection already persisted
    // by `presentationMeta` in `dsh/index.js`) and add badges / collapsers
    // around the native cards. When the slot does not exist, dsh falls
    // back to the native web card unchanged.

    function Badge(react, label, tone) {
      return react.createElement('span', {
        title: label,
        style: {
          display: 'inline-block', padding: '1px 6px', margin: '0 4px 0 0',
          fontSize: '11px', lineHeight: 1.4, borderRadius: '6px',
          color: tone === 'warn' ? '#a16207' : tone === 'uncertain' ? '#475569' : tone === 'ok' ? '#16a34a' : tone === 'error' ? '#dc2626' : 'inherit',
          background: tone === 'warn' ? 'rgba(250, 204, 21, 0.15)' : tone === 'uncertain' ? 'rgba(148, 163, 184, 0.18)' : tone === 'ok' ? 'rgba(34, 197, 94, 0.15)' : tone === 'error' ? 'rgba(220, 38, 38, 0.12)' : 'transparent',
          border: '1px solid rgba(127,127,127,0.35)',
        },
      }, label)
    }

    function Renderer(react, ui) {
      return function SearchBlock(props) {
        // `props.meta` is the `presentationMeta` projection produced by
        // the host tools. We render:
        //   - a status pill + engine chip (degraded / unavailable / ok)
        //   - the structured sources list (kept from the native card)
        //   - a collapsible group of `attempts` when no source answered
        //   - "uncertainty" + "warnings" badges when present
        var meta = (props && props.meta) || {}
        var sources = Array.isArray(meta.sources) ? meta.sources : []
        var attempts = Array.isArray(meta.attempts) ? meta.attempts : []
        var uncertainty = Array.isArray(meta.uncertainty) ? meta.uncertainty : []
        var warnings = Array.isArray(meta.warnings) ? meta.warnings : []

        var headerBadges = react.createElement(react.Fragment, null,
          meta.status && Badge(react, meta.status, meta.status === 'ok' ? 'ok' : meta.status === 'degraded' ? 'warn' : 'uncertain'),
          meta.engine && Badge(react, 'engine: ' + meta.engine, 'meta'),
          warnings.length ? Badge(react, warnings.length + ' warning' + (warnings.length > 1 ? 's' : ''), 'warn') : null,
          uncertainty.length ? Badge(react, uncertainty.length + ' uncertain', 'uncertain') : null,
        )

        var attemptsList = attempts.length ? react.createElement('details', {
          style: { marginTop: '8px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' },
        },
          react.createElement('summary', { style: { cursor: 'pointer' } },
            attempts.length + ' engine attempt' + (attempts.length === 1 ? '' : 's')),
          react.createElement('pre', { style: { whiteSpace: 'pre-wrap', margin: '6px 0 0' } },
            attempts.map(function (a) { return (a.engine || 'engine') + ': ' + (a.error || 'ok') }).join('\n'))
        ) : null

        var sourcesList = sources.length ? react.createElement('ul', {
          style: { listStyle: 'none', padding: 0, margin: '8px 0 0' },
        },
          sources.map(function (s, i) {
            return react.createElement('li', {
              key: i,
              style: { padding: '4px 0', borderTop: i === 0 ? 'none' : '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))' },
            },
              react.createElement('a', {
                href: s.url, target: '_blank', rel: 'noreferrer',
                style: { color: 'var(--dsw-alias-link, inherit)', textDecoration: 'none', fontWeight: 600 },
              }, s.title || s.url),
              s.snippet ? react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } }, s.snippet) : null,
            )
          })
        ) : null

        return react.createElement('section', {
          style: {
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: '8px', padding: '10px 12px', margin: '8px 0',
            background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))',
          },
        },
          react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, headerBadges),
          react.createElement('div', { style: { marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } },
            'dsh-network · undici · ' + (warnings.length || uncertainty.length ? 'see notes' : 'clean')),
          sourcesList,
          attemptsList,
        )
      }
    }

    function FetchBlockRenderer(react, ui) {
      return function FetchBlock(props) {
        var meta = (props && props.meta) || {}
        var uncertainty = Array.isArray(meta.uncertainty) ? meta.uncertainty : []
        var warnings = Array.isArray(meta.warnings) ? meta.warnings : []
        return react.createElement('section', {
          style: {
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: '8px', padding: '10px 12px', margin: '8px 0',
            background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))',
          },
        },
          react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
            meta.engine && react.createElement('span', {
              style: { display: 'inline-block', padding: '1px 6px', fontSize: '11px', lineHeight: 1.4, borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)' },
            }, 'engine: ' + meta.engine),
            typeof meta.statusCode === 'number' && react.createElement('span', {
              style: { display: 'inline-block', padding: '1px 6px', fontSize: '11px', lineHeight: 1.4, borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)' },
            }, 'HTTP ' + meta.statusCode),
            typeof meta.contentType === 'string' && react.createElement('span', {
              style: { display: 'inline-block', padding: '1px 6px', fontSize: '11px', lineHeight: 1.4, borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)' },
            }, meta.contentType.split(';')[0]),
            typeof meta.linksCount === 'number' && react.createElement('span', {
              style: { display: 'inline-block', padding: '1px 6px', fontSize: '11px', lineHeight: 1.4, borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)' },
            }, meta.linksCount + ' outgoing links'),
            meta.truncated && react.createElement('span', {
              style: { display: 'inline-block', padding: '1px 6px', fontSize: '11px', lineHeight: 1.4, borderRadius: '6px', color: '#a16207', background: 'rgba(250, 204, 21, 0.15)', border: '1px solid rgba(127,127,127,0.35)' },
            }, 'truncated'),
          ),
          uncertainty.length ? react.createElement('ul', { style: { paddingLeft: '18px', margin: '6px 0', fontSize: '12px' } },
            uncertainty.map(function (u, i) { return react.createElement('li', { key: i }, u) })
          ) : null,
          warnings.length ? react.createElement('ul', { style: { paddingLeft: '18px', margin: '6px 0', fontSize: '12px', color: '#a16207' } },
            warnings.map(function (w, i) { return react.createElement('li', { key: i }, w) })
          ) : null
        )
      }
    }

    /**
     * `tool.call.toolview` row for `web_search` — the card system dsh 0.2.x
     * ships (`dsh-client-ui-tool` dispatches every tool row through this slot
     * and a keyed registration REPLACES the native row).
     *
     * Why we take it over: the native web card renders one flat `sources` list
     * for the whole call. dsh's tool-web merges several queries into a single
     * call — each query's own `content` lands under a `### <query>` heading,
     * while every query's sources are pooled, de-duplicated, interleaved
     * round-robin and capped at `searchMaxResults`. Two queries therefore
     * rendered as two empty headings above an A/B/A/B list, plus a
     * "sources truncated" note — and the hits that did not fit the cap reached
     * neither the model nor the card.
     *
     * This row renders the provider's per-query answer instead, so every query
     * keeps its own heading and its own hits in engine rank order.
     * `meta.sources` is left untouched for any other consumer of the block —
     * it is simply not re-rendered here.
     *
     * Style: the row is composed to read like a first-party dsh tool card —
     * a borderless disclosure row (16px leading box whose globe crossfades to
     * a chevron on hover, 13px title, 2px dot separators, one ellipsing
     * summary) over a WebBlock-styled body card. The rules are copied from
     * dsh's own DisclosureRow / ToolRow / WebBlock module CSS under our own
     * `dshn-` class names (injected once per document), because the upstream
     * hashed class names are internal to the dsh bundle. Primitives exports
     * (TextShimmer, flow icons, LinkIconMedium) are used when present; inline
     * SVG fallbacks keep the structure identical everywhere else.
     *
     * Two meta shapes reach this row: dsh's own web_search persists
     * `{ answer, sources, truncated }` (the answer carries the `###` sections),
     * while this plugin's own web_search persists
     * `{ status, engine, sources, uncertainty, warnings, attempts }` with a
     * single query and no answer. The second shape falls back to the source
     * list plus the engine/uncertainty badges.
     *
     * Argument reading: a settled dsh block carries its arguments ONLY as the
     * raw JSON string `block.call.argsRaw` — the native rows JSON.parse it
     * (see `parsedToolCall` in dsh-client-ui-tool) and there is no pre-parsed
     * `call.args`. Reading `call.args` alone is why the header's query count
     * never appeared ("网络搜索 · 16 个来源" without the "N 个查询" bit).
     * `argsOf` parses `argsRaw` first and falls back to a literal `call.args`
     * object for hosts/tests that provide one.
     */

    // ───────── native-style toolview styles (copied from dsh 0.2.x) ─────────
    var TOOLVIEW_CSS = [
      // DisclosureRow + ToolRow header: borderless flow row, 24px line, hover lift.
      '.dshn-toolview{display:flex;flex-direction:column;width:100%;min-width:0}',
      '.dshn-toolview-row{position:relative;overflow:hidden;display:flex;align-items:center;min-height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;margin:0;padding:0;border:none;background:none;font:inherit;text-align:left;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8));transition:color 100ms ease;cursor:pointer}',
      '.dshn-toolview-row:hover{color:var(--dsw-alias-label-secondary,rgba(127,127,127,0.9))}',
      '.dshn-toolview-row[data-static]{cursor:default}',
      // 16px leading box; 14px glyphs; globe ⇄ chevron crossfade on hover.
      '.dshn-leading{position:relative;flex:none;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;margin-right:6px}',
      '.dshn-leading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}',
      '.dshn-icon-idle{display:inline-flex;opacity:1;transition:opacity 100ms ease}',
      '.dshn-chevron-hover{position:absolute;inset:0;margin:auto;display:inline-flex;align-items:center;justify-content:center;opacity:0;transition:opacity 100ms ease}',
      '.dshn-toolview-row:hover .dshn-icon-idle{opacity:0}',
      '.dshn-toolview-row:hover .dshn-chevron-hover{opacity:1}',
      // Title · summary fragments, joined by 2px dot separators.
      '.dshn-title{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit;font-weight:400}',
      '.dshn-sep{background:var(--dsw-alias-label-caption,rgba(127,127,127,0.55));border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}',
      '.dshn-summary{min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}',
      '.dshn-summary-fill{flex:1 1 auto}',
      '.dshn-suffix{flex:none;white-space:nowrap;margin-left:4px}',
      '.dshn-suffix:empty{display:none}',
      '.dshn-textwrap{display:flex;align-items:center;min-width:0;max-width:100%;flex:0 1 auto}',
      // WebBlock-styled body card: the markdown-code-block surface.
      '.dshn-body{display:flex;flex-direction:column;min-width:0}',
      '.dshn-card{margin:16px 0 4px 4px;padding:12px 14px;min-width:0;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,0.08));border-radius:var(--dsw-radius-lg,10px)}',
      '.dshn-answer{margin-bottom:8px;min-width:0}',
      // Numbered source list (WebBlock `.sources` geometry).
      '.dshn-sources{margin:0;padding-left:2.5em;display:flex;flex-direction:column;gap:10px;max-height:320px;overflow-y:auto}',
      '.dshn-source{min-width:0}',
      '.dshn-source-link{color:var(--dsw-alias-link,inherit);font-size:14px;font-weight:500;line-height:20px;word-break:break-word;text-decoration:none}',
      '.dshn-source-link:hover,.dshn-source-link:focus-visible{text-decoration:underline dotted;text-underline-offset:3px}',
      '.dshn-link-icon{width:1.1em;height:1.1em;vertical-align:-0.25em;margin-right:5px}',
      '.dshn-snippet{margin-top:2px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,0.9));font-size:13px;line-height:19px;word-break:break-word}',
      '.dshn-published{margin-top:2px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8));font:var(--dsw-font-xs-13,12px)}',
      '.dshn-note{margin-top:8px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8));font:var(--dsw-font-xs-13,12px)}',
      '.dshn-empty{color:var(--dsw-alias-label-secondary,rgba(127,127,127,0.9));font:var(--dsw-font-xs-13,12px)}',
      '.dshn-attempts{margin-top:8px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8));font:var(--dsw-font-xs-13,12px)}',
      '.dshn-attempts summary{cursor:pointer}',
      '.dshn-attempts pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;font:inherit}',
      // Failed-call body (tool threw → ToolResultNode without meta): red-tinted
      // alert block showing the structured error text the model already saw.
      '.dshn-error{border-left:3px solid var(--dsw-alias-state-error-primary,#dc2626);padding-left:10px;display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dshn-error-title{font-size:12px;font-weight:600;letter-spacing:0.2px;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dshn-error-detail{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;color:var(--dsw-alias-label-secondary,rgba(127,127,127,0.9));font:var(--dsw-font-xs-13,12px)}',
      // http_request body: the response is typically a raw byte stream (JSON
      // payload, HTML page, text body), so render it in monospace inside a
      // scrollable box — same width rhythm as .dshn-answer so the two cards
      // line up when they sit next to each other.
      '.dshn-body-pre{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,0.06));max-height:320px;overflow:auto;font:var(--dsw-alias-mono,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}',
      // http_request response-headers table (name + value, two columns).
      '.dshn-headers{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.22));padding-top:8px;display:flex;flex-direction:column;gap:4px}',
      '.dshn-headers-title{margin:0 0 2px;font-size:11px;font-weight:600;letter-spacing:0.2px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8))}',
      '.dshn-headers-row{display:flex;gap:12px;font:var(--dsw-alias-mono,monospace);font-size:11px;line-height:16px;word-break:break-word}',
      '.dshn-headers-name{flex:none;color:var(--dsw-alias-label-secondary,rgba(127,127,127,0.9));min-width:0}',
      '.dshn-headers-value{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}',
      // web_sitemap portal list — each row is a domain with optional search-URL
      // link, plus a one-line meta strip (category · priority · language/region).
      '.dshn-portals{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}',
      '.dshn-portal{min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dshn-portal-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshn-portal-link{color:var(--dsw-alias-link,inherit);font-size:14px;font-weight:500;line-height:20px;word-break:break-word;text-decoration:none}',
      '.dshn-portal-link:hover,.dshn-portal-link:focus-visible{text-decoration:underline dotted;text-underline-offset:3px}',
      '.dshn-portal-badge{display:inline-block;padding:1px 6px;font-size:10px;font-weight:600;line-height:14px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.08));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.22));color:var(--dsw-alias-label-secondary,inherit);font:var(--dsw-alias-mono,monospace);text-transform:lowercase;letter-spacing:0.2px;flex:none}',
      '.dshn-portal-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8))}',
      '.dshn-portal-desc{margin-top:2px;font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,0.9));word-break:break-word}',
      '.dshn-resolved{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.22));padding-top:8px;display:flex;flex-direction:column;gap:6px}',
      '.dshn-resolved-title{margin:0;font-size:11px;font-weight:600;letter-spacing:0.2px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8))}',
      '.dshn-resolved-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;word-break:break-all}',
      '.dshn-resolved-domain{flex:none;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8));min-width:0}',
      '.dshn-resolved-link{flex:1 1 auto;min-width:0;color:var(--dsw-alias-link,inherit);text-decoration:none;overflow-wrap:anywhere}',
      '.dshn-resolved-link:hover,.dshn-resolved-link:focus-visible{text-decoration:underline dotted;text-underline-offset:3px}',
      // web_fetch body: the page is Markdown, so it renders through the host's
      // MarkdownText inside a scroll box — a long article must not push the
      // rest of the transcript off screen.
      '.dshn-page{max-height:480px;overflow-y:auto;overflow-x:hidden;min-width:0;margin-bottom:8px}',
      // Outgoing-links list (web_fetch): the link label anchors, the raw URL
      // sits dimmed next to it, both ellipsized in a two-column row.
      '.dshn-links{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.22));padding-top:8px;display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto}',
      '.dshn-links-title{margin:0 0 2px;font-size:11px;font-weight:600;letter-spacing:0.2px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8))}',
      '.dshn-link-row{display:flex;align-items:baseline;gap:10px;font-size:12px;line-height:18px;min-width:0}',
      '.dshn-link-text{flex:0 1 auto;min-width:0;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-link,inherit);text-decoration:none}',
      '.dshn-link-text:hover,.dshn-link-text:focus-visible{text-decoration:underline dotted;text-underline-offset:3px}',
      '.dshn-link-url{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8));font:var(--dsw-alias-mono,monospace);font-size:11px}',
      // web_config card: the config itself, as label/value rows grouped by
      // surface, plus chips for the closed vocabularies (engine chain, host
      // allowlist, protection + tool switches). Same geometry as the other
      // rows' sub-blocks so a config call sitting next to a fetch call reads as
      // one card family.
      '.dshn-cfg{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.dshn-cfggroup{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dshn-cfggroup-title{margin:0;font-size:11px;font-weight:600;letter-spacing:0.2px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8))}',
      '.dshn-cfgrow{display:flex;align-items:baseline;gap:12px;font-size:12px;line-height:18px;min-width:0}',
      '.dshn-cfgname{flex:0 0 150px;min-width:0;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8));overflow-wrap:anywhere}',
      '.dshn-cfgvalue{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}',
      '.dshn-cfgvalue[data-mono]{font:var(--dsw-alias-mono,monospace);font-size:11px;line-height:17px}',
      '.dshn-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.dshn-chip{display:inline-block;flex:none;padding:1px 6px;font-size:10px;font-weight:600;line-height:14px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.08));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.22));color:var(--dsw-alias-label-secondary,inherit);font:var(--dsw-alias-mono,monospace);letter-spacing:0.2px}',
      // A switch chip carries its state as an attribute: on = the accent green,
      // off = dimmed, and a keyed engine marks the credential it holds.
      '.dshn-chip[data-state="on"]{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.dshn-chip[data-state="off"]{opacity:0.6}',
      '.dshn-chip[data-state="key"]{color:var(--dsw-alias-state-warning-primary,#d97706)}',
      // Refused (NOT failed): the safety gate answered a soft `status: 'error'`
      // with the config untouched, so the block is amber rather than red — an
      // alert-red card would read as a crash the user has to fix.
      '.dshn-refused{border-left:3px solid var(--dsw-alias-state-warning-primary,#d97706);padding-left:10px;display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dshn-refused-title{font-size:12px;font-weight:600;letter-spacing:0.2px;color:var(--dsw-alias-state-warning-primary,#d97706)}',
      '.dshn-refused-detail{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;color:var(--dsw-alias-label-secondary,rgba(127,127,127,0.9));font:var(--dsw-font-xs-13,12px)}',
      '.dshn-details{margin-top:4px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,0.8));font:var(--dsw-font-xs-13,12px)}',
      '.dshn-details summary{cursor:pointer}',
      '.dshn-details pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;font:inherit;max-height:280px;overflow:auto}',
    ].join('')
    var TOOLVIEW_CSS_TAG = 'style[data-plugin-css="dsh-network/toolview.module.css"]'
    /** Inject the toolview stylesheet once; skipped where document.head is absent (tests, SSR). */
    function ensureToolviewStyles() {
      try {
        if (typeof document === 'undefined' || !document || !document.head) return
        if (typeof document.querySelector === 'function' && document.querySelector(TOOLVIEW_CSS_TAG)) return
        if (typeof document.createElement !== 'function') return
        var tag = document.createElement('style')
        tag.setAttribute('data-plugin', 'dsh-network')
        tag.setAttribute('data-plugin-css', 'dsh-network/toolview.module.css')
        tag.textContent = TOOLVIEW_CSS
        document.head.appendChild(tag)
      } catch (error) { /* decorative only — never block registration */ }
    }

    // Inline SVG fallbacks for the primitives flow icons, so the row keeps the
    // native glyph geometry whether or not the host exports the icon set.
    var GLOBE_ICON_PATH = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z'
    var CHEVRON_DOWN_PATH = 'm6 9 6 6 6-6'
    var CHEVRON_UP_PATH = 'm18 15-6-6-6 6'
    var LINK_ICON_PATHS = [
      'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
      'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
    ]
    // Code / terminal icon for http_request — a left + right chevron
    // resembling `</>` from Material Icons (`code`).
    var CODE_ICON_PATHS = [
      'M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4z',
      'm14.6 7.4 4.4 4.6-4.6 4.6 1.4 1.4 6-6-6-6-1.2 1.4z',
    ]
    // Sitemap / tree icon for web_sitemap — three boxes connected by
    // horizontal + vertical lines, representing a hierarchical catalog.
    var SITEMAP_ICON_PATH = 'M3 3h6v4H3zM15 3h6v4h-6zM9 17h6v4H9zM6 7v4h12V7M12 11v6'
    // Document icon for web_fetch — the Material `description` glyph (a sheet
    // with a folded corner and three text lines).
    var DOCUMENT_ICON_PATH = 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z'
    // Sliders icon for web_config — the Material `tune` glyph (three rails with
    // a knob each), i.e. "settings", not a second globe.
    var TUNE_ICON_PATH = 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z'

    // ───────── shared toolview helpers ─────────
    // The ToolResultNode shape (records.d.ts in @deepseek-ai/dsh-client-ui-chat)
    // carries `kind: 'tool-result'` once a call settles, with `isError: true`
    // when the body threw and an optional `meta` (only set on success when the
    // tool defined a presentationMeta). The previous `meta PRESENCE` settled
    // check therefore left every throwing tool (http_request / web_fetch) stuck
    // in the running state — meta never lands, so the row kept shimmering
    // "搜索中…" even though the model already saw a structured error. The
    // canonical check is the same one dsh itself uses (`"kind" in block`),
    // and a failed call additionally exposes the error text on `content` /
    // `error` so we can surface it in the body.
    function isSettledToolCall(block) {
      return !!block && typeof block === 'object' && (block.kind === 'tool-result' || block.isError === true)
    }
    function isErroredToolCall(block) {
      return isSettledToolCall(block) && block.isError === true
    }
    /** First text segment of an errored block's content, with dsh's `Error: …`
     *  envelope prefix stripped so the row shows just the actionable message.
     *  Falls back to the structured `error` envelope (`name: code`). */
    function errorMessageOf(block) {
      if (!block || typeof block !== 'object') return ''
      var content = Array.isArray(block.content) ? block.content : []
      for (var i = 0; i < content.length; i++) {
        var c = content[i]
        if (c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string') {
          return c.text.replace(/^Error:\s*/, '')
        }
      }
      if (block.error && typeof block.error === 'object') {
        var parts = []
        if (typeof block.error.name === 'string' && block.error.name !== '') parts.push(block.error.name)
        if (typeof block.error.code === 'string' && block.error.code !== '') parts.push(block.error.code)
        if (typeof block.error.message === 'string' && block.error.message !== '') {
          var prefix = parts.length > 0 ? parts.join(': ') + ' — ' : ''
          return prefix + block.error.message.replace(/^Error:\s*/, '')
        }
        if (parts.length > 0) return parts.join(': ')
      }
      return ''
    }
    /** Parse the call's arguments from whatever shape the block carries.
     *  dsh writes `block.call.argsRaw` on a settled ToolResultNode and
     *  `block.argsRaw` directly on a RunningToolCall; tests often pre-parse
     *  to `call.args`. Each shape falls through to the next so the row keeps
     *  working on hosts / harnesses that diverge. */
    function argsOf(block) {
      if (!block || typeof block !== 'object') return {}
      var call = block.call
      if (call && typeof call === 'object') {
        if (typeof call.argsRaw === 'string' && call.argsRaw !== '') {
          try {
            var parsed = JSON.parse(call.argsRaw)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
          } catch (error) { /* partial/streaming argsRaw — fall through */ }
        }
        if (call.args && typeof call.args === 'object' && !Array.isArray(call.args)) return call.args
      }
      if (typeof block.argsRaw === 'string' && block.argsRaw !== '') {
        try {
          var parsed = JSON.parse(block.argsRaw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
        } catch (error) { /* partial/streaming argsRaw — fall through */ }
      }
      return {}
    }

    // ───────── shared row primitives ─────────
    // Chunk scope, not per component: all four rows need them and the
    // per-component copies had already drifted (the http row grew a
    // `raw`-safe `safeContentType` the sitemap row never had). They take
    // `react` as their first argument because a chunk has no view of the
    // entry's file scope — `react` arrives per component from apply().
    function flowIcon(react, pathD, stroke) {
      return react.createElement('svg', {
        viewBox: '0 0 24 24',
        fill: stroke ? 'none' : 'currentColor',
        stroke: stroke ? 'currentColor' : 'none',
        strokeWidth: stroke ? 2 : undefined,
        strokeLinecap: stroke ? 'round' : undefined,
        strokeLinejoin: stroke ? 'round' : undefined,
        'aria-hidden': true,
      }, react.createElement('path', { d: pathD, fill: stroke ? 'none' : 'currentColor' }))
    }

    /** http(s) URLs only — mirrors the primitives' SafeLink allowlist, so a
     *  `javascript:`/`data:` URL never reaches the DOM as an href. */
    function safeHref(url) {
      if (typeof url !== 'string' || url === '') return null
      try {
        var protocol = new URL(url).protocol
        return protocol === 'http:' || protocol === 'https:' ? url : null
      } catch (error) { return null }
    }

    /** Title or hostname label, never blank (mirrors WebBlock's linkLabel). */
    function linkLabel(url, fallback) {
      if (typeof fallback === 'string' && fallback !== '') return fallback
      try {
        var hostname = new URL(url).hostname
        return hostname === '' ? url : hostname
      } catch (error) { return url }
    }

    /** `text/html; charset=utf-8` → `text/html`. */
    function safeContentType(raw) {
      if (typeof raw !== 'string' || raw === '') return ''
      return raw.split(';')[0].trim().toLowerCase()
    }

    /** Badge tone for an HTTP status code. */
    function statusTone(code) {
      if (!Number.isInteger(code)) return 'meta'
      if (code >= 200 && code < 300) return 'ok'
      if (code >= 300 && code < 400) return 'meta'
      if (code >= 400 && code < 500) return 'warn'
      return 'error'
    }

    /** Fill `{name}` placeholders in a locale label (see fetchToolPaged). */
    function fill(template, values) {
      return String(template == null ? '' : template).replace(/\{(\w+)\}/g, function (match, key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      })
    }

    function SearchToolview(react, ui, localeRef) {
      var MarkdownText = ui && isRenderable(ui.MarkdownText) ? ui.MarkdownText : null
      var TextShimmer = ui && isRenderable(ui.TextShimmer) ? ui.TextShimmer : null
      var IconGlobe = ui && ui.IconGlobeOutlineRegular ? ui.IconGlobeOutlineRegular : null
      var IconChevronDown = ui && ui.IconChevronDownOutlineRegular ? ui.IconChevronDownOutlineRegular : null
      var IconChevronUp = ui && ui.IconChevronUpOutlineRegular ? ui.IconChevronUpOutlineRegular : null
      var LinkIcon = ui && ui.LinkIconMedium ? ui.LinkIconMedium : null

      ensureToolviewStyles()

      /** The call's parsed arguments: see the shared `argsOf` helper above. */

      /** The queries of a call, accepting both arg shapes (`queries` array /
       *  this plugin's single `query` string). */
      function queriesOf(block) {
        var args = argsOf(block)
        if (Array.isArray(args.queries)) {
          return args.queries.filter(function (q) { return typeof q === 'string' && q.trim() !== '' })
        }
        return typeof args.query === 'string' && args.query.trim() !== '' ? [args.query] : []
      }

      function sourceList(sources) {
        if (sources.length === 0) return null
        return react.createElement('ol', { className: 'dshn-sources' },
          sources.map(function (s, i) {
            var url = typeof s.url === 'string' ? s.url : ''
            var href = safeHref(url)
            var label = linkLabel(url, s.title)
            var iconNode = null
            if (href) {
              iconNode = LinkIcon
                ? react.createElement(LinkIcon, { key: 'icon', kind: 'url', href: href, className: 'dshn-link-icon' })
                : react.createElement('svg', {
                  key: 'icon', className: 'dshn-link-icon', viewBox: '0 0 24 24',
                  fill: 'none', stroke: 'currentColor', strokeWidth: 2,
                  strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
                }, LINK_ICON_PATHS.map(function (d, pi) {
                  return react.createElement('path', { key: pi, d: d, fill: 'none' })
                }))
            }
            var linkProps = { className: 'dshn-source-link' }
            if (href) {
              linkProps.href = href
              linkProps.target = '_blank'
              linkProps.rel = 'noopener noreferrer'
            }
            return react.createElement('li', { key: i, className: 'dshn-source' },
              react.createElement(href ? 'a' : 'span', linkProps, iconNode, label),
              s.snippet ? react.createElement('div', { className: 'dshn-snippet' }, s.snippet) : null,
              s.publishedAt ? react.createElement('div', { className: 'dshn-published' }, s.publishedAt) : null,
            )
          })
        )
      }

      return function DshNetworkSearchRow(props) {
        var t = labelText(localeRef, '')
        var block = (props && props.block) || {}
        var rawMeta = block.meta && typeof block.meta === 'object' && !Array.isArray(block.meta) ? block.meta : null
        var meta = rawMeta || {}
        var queries = queriesOf(block)
        var answer = typeof meta.answer === 'string' ? meta.answer : ''
        var sources = Array.isArray(meta.sources) ? meta.sources : []
        var uncertainty = Array.isArray(meta.uncertainty) ? meta.uncertainty : []
        var warnings = Array.isArray(meta.warnings) ? meta.warnings : []
        var attempts = Array.isArray(meta.attempts) ? meta.attempts : []
        // Settled detection uses dsh's canonical `"kind" in block` check, NOT
        // meta presence. A throwing tool (e.g. http_request) never lands a
        // meta — only the ToolResultNode shape with `isError: true` — so the
        // old `rawMeta !== null` rule left every throwing call stuck in the
        // running state ("搜索中…") even though the model already saw the
        // error. The old `meta === 0` test also left a finished zero-hit
        // successful call showing 搜索中… forever, hence the canonical check.
        var settled = isSettledToolCall(block) || rawMeta !== null
        var errored = isErroredToolCall(block)
        var errorMessage = errored ? errorMessageOf(block) : ''

        // Multi-query calls are exactly the case the native card renders
        // badly, so they start expanded; a plain single-query call keeps the
        // native collapsed-by-default rhythm. A failed call also starts
        // expanded so the user sees the error without an extra click.
        var openState = react.useState(queries.length > 1 || errored)
        var open = settled && openState[0]
        var setOpen = openState[1]
        var toggle = function () { setOpen(function (v) { return !v }) }

        // Header summary, native rhythm: title · fragment · fragment with 2px
        // dot separators. The fragments are the query itself (single query),
        // the query count (multi), and the hit count of what the BODY shows.
        // With an answer present that is every hit of every query, while
        // `meta.sources` is dsh's pooled list already cut down to
        // `searchMaxResults` — counting that would report "8 sources" above
        // sixteen rendered hits. Count the answer's own numbered items
        // instead, and fall back to the source list when the answer carries
        // none (this plugin's own web_search).
        var answerHits = answer === '' ? 0 : (answer.match(/^\s*\d+\.\s/gm) || []).length
        var fragments = []
        if (queries.length === 1) fragments.push(queries[0])
        else if (queries.length > 1) fragments.push(queries.length + ' ' + t.searchToolQueries)
        if (errored) {
          fragments.push(t.searchToolFailed)
        } else if (settled) {
          var hits = answerHits || sources.length
          if (hits > 0) fragments.push(hits + ' ' + t.searchToolSources)
        } else fragments.push(t.searchToolRunning)

        var badges = react.createElement('span', { className: 'dshn-suffix', key: 'badges' },
          errored ? Badge(react, 'error', 'error') : null,
          meta.engine ? Badge(react, 'engine: ' + meta.engine, 'meta') : null,
          meta.status ? Badge(react, meta.status, meta.status === 'ok' ? 'ok' : 'warn') : null,
          warnings.length ? Badge(react, warnings.length + ' warning' + (warnings.length > 1 ? 's' : ''), 'warn') : null,
          uncertainty.length ? Badge(react, uncertainty.length + ' uncertain', 'uncertain') : null,
        )

        var headerText = [react.createElement('span', { className: 'dshn-title', key: 'title' }, t.searchToolTitle)]
        fragments.forEach(function (fragment, i) {
          headerText.push(react.createElement('span', { className: 'dshn-sep', 'data-shimmer-decoration': true, 'aria-hidden': true, key: 'sep' + i }))
          headerText.push(react.createElement('span', {
            className: 'dshn-summary' + (i === fragments.length - 1 ? ' dshn-summary-fill' : ''),
            key: 'frag' + i,
          }, fragment))
        })
        headerText.push(badges)
        // Running rows shimmer exactly like the native ones when the host
        // exports TextShimmer; the plain span keeps the same structure else.
        var textWrap = TextShimmer
          ? react.createElement(TextShimmer, { active: !settled }, headerText)
          : react.createElement('span', { className: 'dshn-textwrap' }, headerText)

        // 16px leading box: globe at rest, chevron on hover (crossfade via
        // CSS), chevron-up while expanded — the DisclosureRow pattern.
        var leading = react.createElement('span', { className: 'dshn-leading', 'aria-hidden': true },
          open
            ? (IconChevronUp ? react.createElement(IconChevronUp, { size: 14 }) : flowIcon(react, CHEVRON_UP_PATH, true))
            : [
                react.createElement('span', { className: 'dshn-icon-idle', key: 'idle' },
                  IconGlobe ? react.createElement(IconGlobe, { size: 14 }) : flowIcon(react, GLOBE_ICON_PATH, false)),
                react.createElement('span', { className: 'dshn-chevron-hover', key: 'chev' },
                  IconChevronDown ? react.createElement(IconChevronDown, { size: 14 }) : flowIcon(react, CHEVRON_DOWN_PATH, true)),
              ],
        )

        var rowProps = {
          type: 'button',
          className: 'dshn-toolview-row',
          onClick: settled ? toggle : undefined,
          // An unsettled call has nothing to expand, so its state lives in
          // the header — the native row does the same.
          'aria-expanded': settled ? open : undefined,
        }
        if (!settled) rowProps['data-static'] = 'true'

        var body = !settled
          ? null
          : errored
            ? react.createElement('div', { className: 'dshn-body' },
                react.createElement('div', { className: 'dshn-card' },
                  react.createElement('div', { className: 'dshn-error', role: 'alert' },
                    react.createElement('div', { className: 'dshn-error-title' }, t.searchToolFailed),
                    react.createElement('pre', { className: 'dshn-error-detail' }, errorMessage))))
            : react.createElement('div', { className: 'dshn-body' },
              react.createElement('div', { className: 'dshn-card' },
                answer !== ''
                  ? react.createElement('div', { className: 'dshn-answer' },
                    MarkdownText
                      ? react.createElement(MarkdownText, { text: answer, labels: markdownLabels(localeRef) })
                      : react.createElement('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, font: 'inherit' } }, answer))
                  : (sources.length
                    ? sourceList(sources)
                    : react.createElement('div', { className: 'dshn-empty' }, t.searchToolNoResults)),
                meta.truncated ? react.createElement('div', { className: 'dshn-note' }, t.searchToolTruncated) : null,
                attempts.length ? react.createElement('details', { className: 'dshn-attempts' },
                  react.createElement('summary', null, attempts.length + ' engine attempt' + (attempts.length === 1 ? '' : 's')),
                  react.createElement('pre', null,
                    attempts.map(function (a) { return (a.engine || 'engine') + ': ' + (a.error || 'ok') }).join('\n')))
                : null,
              ))

        return react.createElement('div', { className: 'dshn-toolview' },
          react.createElement('button', rowProps, leading, textWrap),
          open ? body : null,
        )
      }
    }

    /**
     * `tool.call.toolview` row for `http_request` — low-level HTTP tool. Like
     * SearchToolview, it shadows the dsh native row at a sub-zero priority and
     * keeps the first-party rhythm: a borderless disclosure row over a
     * WebBlock-styled body card. The body carries the raw HTTP response (text /
     * JSON / HTML bytes) inside a scrollable monospace box, plus a compact
     * response-headers table — the same pieces of information the model got
     * from the tool, so the user can audit what actually went over the wire.
     *
     * When the body was degraded to a preview by the server-side cache, the
     * `bodyPreview` ends with a trailing `…` ellipsis and the meta carries a
     * `cacheId` / `contentLength` / `cacheSlice`. The row surfaces a "预览"
     * badge plus an offset hint so the user knows the body is incomplete and
     * how to page the rest (`http_request` again with `cacheId` + offset).
     */
    function HttpRequestToolview(react, ui, localeRef) {
      var MarkdownText = ui && isRenderable(ui.MarkdownText) ? ui.MarkdownText : null
      var TextShimmer = ui && isRenderable(ui.TextShimmer) ? ui.TextShimmer : null
      var IconChevronDown = ui && ui.IconChevronDownOutlineRegular ? ui.IconChevronDownOutlineRegular : null
      var IconChevronUp = ui && ui.IconChevronUpOutlineRegular ? ui.IconChevronUpOutlineRegular : null
      var LinkIcon = ui && ui.LinkIconMedium ? ui.LinkIconMedium : null

      ensureToolviewStyles()

      // Two-path "code" icon (left chevron + right chevron), matching the
      // Material Icons `code` glyph used by dsh's primitives exports.
      function codeIcon() {
        return react.createElement('svg', {
          viewBox: '0 0 24 24',
          fill: 'none', stroke: 'currentColor', strokeWidth: 2,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true,
        }, CODE_ICON_PATHS.map(function (d, pi) {
          return react.createElement('path', { key: pi, d: d, fill: 'none' })
        }))
      }

      return function DshNetworkHttpRequestRow(props) {
        var t = labelText(localeRef, '')
        var block = (props && props.block) || {}
        var args = argsOf(block)
        var rawMeta = block.meta && typeof block.meta === 'object' && !Array.isArray(block.meta) ? block.meta : null
        var meta = rawMeta || {}
        // args win where they reflect the request the user just issued —
        // `meta` is the post-execute view, but `args.url` / `args.method`
        // are the values the user actually typed (and they survive the
        // paged-read path where meta finalUrl comes from the cache entry).
        var method = typeof args.method === 'string' && args.method !== ''
          ? args.method.toUpperCase()
          : (typeof meta.method === 'string' && meta.method !== '' ? meta.method : 'GET')
        var requestedUrl = typeof args.url === 'string' && args.url !== ''
          ? args.url
          : (typeof args.cacheId === 'string' && args.cacheId !== ''
            ? 'cache:' + args.cacheId.slice(0, 8)
            : '')
        var finalUrl = typeof meta.url === 'string' && meta.url !== '' ? meta.url : requestedUrl
        var statusCode = Number.isInteger(meta.statusCode) ? meta.statusCode : null
        var statusText = typeof meta.statusText === 'string' && meta.statusText !== '' ? meta.statusText : ''
        var contentType = safeContentType(meta.contentType)
        var body = typeof meta.bodyPreview === 'string' ? meta.bodyPreview : ''
        var isPreview = typeof body === 'string' && body.length > 0 && body.charCodeAt(body.length - 1) === 0x2026 /* … */
        var headers = Array.isArray(meta.headers) ? meta.headers : []
        var cacheId = typeof meta.cacheId === 'string' && meta.cacheId !== '' ? meta.cacheId : ''
        var contentLength = Number.isInteger(meta.contentLength) ? meta.contentLength : null
        var cacheSlice = meta.cacheSlice && typeof meta.cacheSlice === 'object' ? meta.cacheSlice : null
        var warnings = Array.isArray(meta.warnings) ? meta.warnings : []

        // Settled detection uses dsh's canonical `"kind" in block` check, not
        // meta presence. The host's http_request execute() throws on CLI
        // failure, and dsh's tool registry then builds a ToolResultNode with
        // `isError: true` and NO `meta` — the old `rawMeta !== null` rule
        // therefore left every failing POST stuck in the running state
        // ("搜索中…") even though the model already saw a structured error.
        var settled = isSettledToolCall(block) || rawMeta !== null
        var errored = isErroredToolCall(block)
        var errorMessage = errored ? errorMessageOf(block) : ''

        // The row reads like a first-party dsh tool card. Single fetch →
        // collapsed; the user clicks the row to inspect the body. A body
        // preview with a `…` ending, or a failed call, is opened by default
        // so the user sees the truncation / error hint without expanding.
        var openState = react.useState(isPreview || errored)
        var open = settled && openState[0]
        var setOpen = openState[1]
        var toggle = function () { setOpen(function (v) { return !v }) }

        // Header rhythm: METHOD · URL · status · content-type · warnings
        // (success) / METHOD · URL · 请求失败 (failure). Each fragment is a
        // dot-separated label, exactly like SearchToolview.
        var headerFragments = []
        var headerLabel = method + ' ' + finalUrl
        headerFragments.push(headerLabel)
        if (errored) {
          headerFragments.push(t.searchToolFailed)
        } else if (settled) {
          if (statusCode !== null) {
            var statusLabel = statusCode + (statusText !== '' ? ' ' + statusText : '')
            headerFragments.push(statusLabel)
          }
          if (contentType !== '') headerFragments.push(contentType)
          if (cacheId !== '') headerFragments.push('cache:' + cacheId.slice(0, 8))
        } else {
          headerFragments.push(t.searchToolRunning)
        }

        var badges = react.createElement('span', { className: 'dshn-suffix', key: 'badges' },
          errored ? Badge(react, 'error', 'error') : null,
          settled && !errored && statusCode !== null ? Badge(react, statusCode + (statusText !== '' ? ' ' + statusText : ''), statusTone(statusCode)) : null,
          settled && !errored && contentType !== '' ? Badge(react, contentType, 'meta') : null,
          settled && !errored && cacheId !== '' ? Badge(react, 'cache:' + cacheId.slice(0, 8), 'warn') : null,
          warnings.length ? Badge(react, warnings.length + ' warning' + (warnings.length > 1 ? 's' : ''), 'warn') : null,
        )

        var headerText = [react.createElement('span', { className: 'dshn-title', key: 'title' }, 'HTTP 请求')]
        headerFragments.forEach(function (fragment, i) {
          headerText.push(react.createElement('span', { className: 'dshn-sep', 'data-shimmer-decoration': true, 'aria-hidden': true, key: 'sep' + i }))
          headerText.push(react.createElement('span', {
            className: 'dshn-summary' + (i === headerFragments.length - 1 ? ' dshn-summary-fill' : ''),
            key: 'frag' + i,
          }, fragment))
        })
        headerText.push(badges)
        var textWrap = TextShimmer
          ? react.createElement(TextShimmer, { active: !settled }, headerText)
          : react.createElement('span', { className: 'dshn-textwrap' }, headerText)

        var leading = react.createElement('span', { className: 'dshn-leading', 'aria-hidden': true },
          open
            ? (IconChevronUp ? react.createElement(IconChevronUp, { size: 14 }) : flowIcon(react, CHEVRON_UP_PATH, true))
            : [
              react.createElement('span', { className: 'dshn-icon-idle', key: 'idle' }, codeIcon()),
              react.createElement('span', { className: 'dshn-chevron-hover', key: 'chev' },
                IconChevronDown ? react.createElement(IconChevronDown, { size: 14 }) : flowIcon(react, CHEVRON_DOWN_PATH, true)),
            ],
        )

        var rowProps = {
          type: 'button',
          className: 'dshn-toolview-row',
          onClick: settled ? toggle : undefined,
          'aria-expanded': settled ? open : undefined,
        }
        if (!settled) rowProps['data-static'] = 'true'

        var bodyChildren = []
        if (errored) {
          // A throwing call never lands a meta, so there is no body/status to
          // show — render the structured error text the model already saw so
          // the user can audit the same failure without opening the trajectory.
          bodyChildren.push(react.createElement('div', { className: 'dshn-error', role: 'alert', key: 'error' },
            react.createElement('div', { className: 'dshn-error-title' }, t.searchToolFailed),
            errorMessage !== '' ? react.createElement('pre', { className: 'dshn-error-detail' }, errorMessage) : null,
          ))
        }
        if (!errored && cacheId !== '' && contentLength !== null && contentLength > body.length) {
          bodyChildren.push(react.createElement('div', { className: 'dshn-note', key: 'paged' },
            '预览 — 共 ' + contentLength.toLocaleString() + ' 字符（显示了 ' + body.length.toLocaleString() +
              '）。以 cacheId="' + cacheId + '" 配合 offset=' + body.length + ', limit=20000 继续分页。'))
        }
        if (!errored && body !== '') {
          bodyChildren.push(react.createElement('pre', { className: 'dshn-body-pre', key: 'body' }, body))
        } else if (!errored && settled) {
          bodyChildren.push(react.createElement('div', { className: 'dshn-empty', key: 'empty' }, '响应体为空'))
        }
        if (!errored && headers.length > 0) {
          bodyChildren.push(react.createElement('div', { className: 'dshn-headers', key: 'headers' },
            react.createElement('div', { className: 'dshn-headers-title' }, '响应头 (' + headers.length + ')'),
            headers.map(function (h, i) {
              var name = h && typeof h.name === 'string' ? h.name : ''
              var value = h && typeof h.value === 'string' ? h.value : ''
              return react.createElement('div', { className: 'dshn-headers-row', key: 'h' + i },
                react.createElement('span', { className: 'dshn-headers-name' }, name),
                react.createElement('span', { className: 'dshn-headers-value' }, value))
            }),
          ))
        }
        if (warnings.length) {
          bodyChildren.push(react.createElement('ul', { key: 'warns', style: { paddingLeft: '18px', margin: '8px 0 0', fontSize: '12px' } },
            warnings.map(function (w, i) { return react.createElement('li', { key: i }, w) })))
        }

        var bodyNode = !settled
          ? null
          : react.createElement('div', { className: 'dshn-body' },
            react.createElement('div', { className: 'dshn-card' }, bodyChildren),
          )

        return react.createElement('div', { className: 'dshn-toolview' },
          react.createElement('button', rowProps, leading, textWrap),
          open ? bodyNode : null,
        )
      }
    }

    /**
     * `tool.call.toolview` row for `web_fetch` — the page reader.
     *
     * Why it needs its own row: the native/default fetch row is a bare
     * status line, while everything interesting about a fetch — the page the
     * model actually read, where it linked to, whether the body was degraded
     * to a preview — lives in the tool's `meta` and is otherwise invisible in
     * the transcript. This row shows exactly that: a borderless disclosure row
     * (URL · status · content-type · link count, with the usual 2px dot
     * separators) over a WebBlock-styled card carrying the rendered page.
     *
     * The body is MARKDOWN by default, so it goes through the host's
     * `ui.MarkdownText` (never a raw `<pre>` — see `isRenderable`). `format:
     * 'raw'` is the exception: those bytes are not markdown, so the row keeps
     * them monospace in a scroll box exactly like `http_request` does. The
     * host decides which by persisting `format` in the meta.
     *
     * A cached page (`cacheId` + a `contentPreview` ending in `…`, or a paged
     * re-read) opens with the paging hint on screen. The hint's offset is
     * ABSOLUTE — `cacheSlice.offset + shown` — for the same reason the
     * model-facing evidence renderer uses it: hinting the slice-local length
     * would send the next read back to the top of the page.
     */
    function WebFetchToolview(react, ui, localeRef) {
      var MarkdownText = ui && isRenderable(ui.MarkdownText) ? ui.MarkdownText : null
      var TextShimmer = ui && isRenderable(ui.TextShimmer) ? ui.TextShimmer : null
      var IconChevronDown = ui && ui.IconChevronDownOutlineRegular ? ui.IconChevronDownOutlineRegular : null
      var IconChevronUp = ui && ui.IconChevronUpOutlineRegular ? ui.IconChevronUpOutlineRegular : null

      ensureToolviewStyles()

      return function DshNetworkFetchRow(props) {
        var t = labelText(localeRef, '')
        var block = (props && props.block) || {}
        var args = argsOf(block)
        var rawMeta = block.meta && typeof block.meta === 'object' && !Array.isArray(block.meta) ? block.meta : null
        var meta = rawMeta || {}
        // The requested URL is what the caller asked for; the meta carries the
        // FINAL url, which differs after a redirect. Both are shown when they
        // disagree — a silent redirect is exactly what a reader wants to see.
        var requestedUrl = typeof args.url === 'string' && args.url !== ''
          ? args.url
          : (typeof args.cacheId === 'string' && args.cacheId !== ''
            ? 'cache:' + args.cacheId.slice(0, 8)
            : '')
        var finalUrl = typeof meta.url === 'string' && meta.url !== '' ? meta.url : requestedUrl
        var statusCode = Number.isInteger(meta.statusCode) ? meta.statusCode : null
        var contentType = safeContentType(meta.contentType)
        var body = typeof meta.contentPreview === 'string' ? meta.contentPreview : ''
        // A single trailing `…` is the host's clip marker (previewText): it is
        // what tells a truncated preview from a complete page.
        var clipped = body !== '' && body.charCodeAt(body.length - 1) === 0x2026 /* … */
        var shownChars = clipped ? body.length - 1 : body.length
        var cacheId = typeof meta.cacheId === 'string' && meta.cacheId !== '' ? meta.cacheId : ''
        var contentLength = Number.isInteger(meta.contentLength) ? meta.contentLength : null
        var cacheSlice = meta.cacheSlice && typeof meta.cacheSlice === 'object' ? meta.cacheSlice : null
        var sliceOffset = cacheSlice && Number.isInteger(cacheSlice.offset) ? cacheSlice.offset : 0
        var endOffset = sliceOffset + shownChars
        var isRaw = meta.format === 'raw'
        var links = Array.isArray(meta.links)
          ? meta.links.filter(function (l) { return l && typeof l.url === 'string' && l.url !== '' })
          : []
        var linksCount = Number.isInteger(meta.linksCount) ? meta.linksCount : links.length
        var warnings = Array.isArray(meta.warnings) ? meta.warnings : []
        var uncertainty = Array.isArray(meta.uncertainty) ? meta.uncertainty : []

        // Canonical `"kind" in block` settled check (see the shared helpers
        // above): a throwing fetch never lands a meta, only `isError: true`.
        var settled = isSettledToolCall(block) || rawMeta !== null
        var errored = isErroredToolCall(block)
        var errorMessage = errored ? errorMessageOf(block) : ''

        // A fetch IS the page: unlike a hit list it is what the user asked to
        // see, so a settled call is open until the user says otherwise — an
        // errored one included, so the failure needs no extra click. The
        // `null` state means "still following that default": a plain
        // `useState(true)` initializer cannot express it, because it only runs
        // on the FIRST render — while the call is still running — and the row
        // would stay collapsed after the page arrived.
        var openState = react.useState(null)
        var open = settled && (openState[0] === null ? true : openState[0])
        var setOpen = openState[1]
        var toggle = function () { setOpen(openState[0] === null ? false : !openState[0]) }

        var headerFragments = []
        if (requestedUrl !== '') headerFragments.push(requestedUrl)
        if (finalUrl !== '' && finalUrl !== requestedUrl) headerFragments.push('→ ' + finalUrl)
        if (errored) {
          headerFragments.push(t.searchToolFailed)
        } else if (settled) {
          if (statusCode !== null) headerFragments.push(String(statusCode))
          if (contentType !== '') headerFragments.push(contentType)
          if (linksCount > 0) headerFragments.push(linksCount + ' ' + t.fetchToolLinks)
        } else {
          headerFragments.push(t.fetchToolRunning)
        }

        var badges = react.createElement('span', { className: 'dshn-suffix', key: 'badges' },
          errored ? Badge(react, 'error', 'error') : null,
          settled && !errored && isRaw ? Badge(react, t.fetchToolRaw, 'meta') : null,
          settled && !errored && statusCode !== null ? Badge(react, String(statusCode), statusTone(statusCode)) : null,
          settled && !errored && cacheId !== '' ? Badge(react, 'cache:' + cacheId.slice(0, 8), 'warn') : null,
          warnings.length ? Badge(react, warnings.length + ' warning' + (warnings.length > 1 ? 's' : ''), 'warn') : null,
          uncertainty.length ? Badge(react, uncertainty.length + ' uncertain', 'uncertain') : null,
        )

        var headerText = [react.createElement('span', { className: 'dshn-title', key: 'title' }, t.fetchToolTitle)]
        headerFragments.forEach(function (fragment, i) {
          headerText.push(react.createElement('span', { className: 'dshn-sep', 'data-shimmer-decoration': true, 'aria-hidden': true, key: 'sep' + i }))
          headerText.push(react.createElement('span', {
            className: 'dshn-summary' + (i === headerFragments.length - 1 ? ' dshn-summary-fill' : ''),
            key: 'frag' + i,
          }, fragment))
        })
        headerText.push(badges)
        var textWrap = TextShimmer
          ? react.createElement(TextShimmer, { active: !settled }, headerText)
          : react.createElement('span', { className: 'dshn-textwrap' }, headerText)

        var leading = react.createElement('span', { className: 'dshn-leading', 'aria-hidden': true },
          open
            ? (IconChevronUp ? react.createElement(IconChevronUp, { size: 14 }) : flowIcon(react, CHEVRON_UP_PATH, true))
            : [
              react.createElement('span', { className: 'dshn-icon-idle', key: 'idle' }, flowIcon(react, DOCUMENT_ICON_PATH, false)),
              react.createElement('span', { className: 'dshn-chevron-hover', key: 'chev' },
                IconChevronDown ? react.createElement(IconChevronDown, { size: 14 }) : flowIcon(react, CHEVRON_DOWN_PATH, true)),
            ],
        )

        var rowProps = {
          type: 'button',
          className: 'dshn-toolview-row',
          onClick: settled ? toggle : undefined,
          'aria-expanded': settled ? open : undefined,
        }
        if (!settled) rowProps['data-static'] = 'true'

        var bodyChildren = []
        if (errored) {
          // A throwing call carries no meta — show the structured error text
          // the model already saw.
          bodyChildren.push(react.createElement('div', { className: 'dshn-error', role: 'alert', key: 'error' },
            react.createElement('div', { className: 'dshn-error-title' }, t.searchToolFailed),
            errorMessage !== '' ? react.createElement('pre', { className: 'dshn-error-detail' }, errorMessage) : null,
          ))
        }
        if (!errored && cacheId !== '' && contentLength !== null && contentLength > endOffset) {
          bodyChildren.push(react.createElement('div', { className: 'dshn-note', key: 'paged' },
            fill(t.fetchToolPaged, {
              shown: shownChars.toLocaleString(),
              total: contentLength.toLocaleString(),
              id: cacheId,
              offset: endOffset,
            })))
        } else if (!errored && clipped) {
          // Clipped with no cache descriptor to page through: say so, rather
          // than letting the ellipsis read as part of the page.
          bodyChildren.push(react.createElement('div', { className: 'dshn-note', key: 'clipped' }, t.fetchToolClipped))
        }
        if (!errored && body !== '') {
          bodyChildren.push(isRaw
            ? react.createElement('pre', { className: 'dshn-body-pre', key: 'body' }, body)
            : react.createElement('div', { className: 'dshn-page', key: 'body' },
              MarkdownText
                ? react.createElement(MarkdownText, { text: body, labels: markdownLabels(localeRef) })
                : react.createElement('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, font: 'inherit' } }, body)))
        } else if (!errored && settled) {
          bodyChildren.push(react.createElement('div', { className: 'dshn-empty', key: 'empty' }, t.fetchToolEmpty))
        }
        if (!errored && links.length > 0) {
          // The host caps the list at 40 while `linksCount` counts every
          // outgoing link the page had — say which of the two is on screen.
          var linksTitle = linksCount > links.length ? t.fetchToolLinksTitleCapped : t.fetchToolLinksTitle
          bodyChildren.push(react.createElement('div', { className: 'dshn-links', key: 'links' },
            react.createElement('div', { className: 'dshn-links-title' },
              fill(linksTitle, { count: links.length, total: linksCount })),
            links.map(function (l, i) {
              var href = safeHref(l.url)
              var label = linkLabel(l.url, l.text)
              var labelProps = { className: 'dshn-link-text' }
              if (href) {
                labelProps.href = href
                labelProps.target = '_blank'
                labelProps.rel = 'noopener noreferrer'
              }
              return react.createElement('div', { className: 'dshn-link-row', key: 'l' + i },
                react.createElement(href ? 'a' : 'span', labelProps, label),
                react.createElement('span', { className: 'dshn-link-url' }, l.url))
            }),
          ))
        }
        if (uncertainty.length) {
          bodyChildren.push(react.createElement('ul', { key: 'unc', style: { paddingLeft: '18px', margin: '8px 0 0', fontSize: '12px' } },
            uncertainty.map(function (u, i) { return react.createElement('li', { key: i }, u) })))
        }
        if (warnings.length) {
          bodyChildren.push(react.createElement('ul', { key: 'warns', style: { paddingLeft: '18px', margin: '6px 0 0', fontSize: '12px', color: '#a16207' } },
            warnings.map(function (w, i) { return react.createElement('li', { key: i }, w) })))
        }

        var bodyNode = !settled
          ? null
          : react.createElement('div', { className: 'dshn-body' },
            react.createElement('div', { className: 'dshn-card' }, bodyChildren),
          )

        return react.createElement('div', { className: 'dshn-toolview' },
          react.createElement('button', rowProps, leading, textWrap),
          open ? bodyNode : null,
        )
      }
    }

    /**
     * `tool.call.toolview` row for `web_sitemap` — the curated portal catalog
     * tool. Same first-party rhythm: borderless disclosure row over a
     * WebBlock-styled body card. The body carries the matching portal list
     * (one row per domain, with priority / category / language / region badges
     * plus a one-line description) and any pre-filled search URLs the CLI
     * resolved for the caller.
     *
     * The categories are a closed vocabulary the host exposes to the model,
     * so the badges use the raw category key rather than translating it —
     * `academic` stays `academic`, matching what the model sees in its
     * tool output and what the user sees in the dedicated settings page.
     */
    function WebSitemapToolview(react, ui, localeRef) {
      var MarkdownText = ui && isRenderable(ui.MarkdownText) ? ui.MarkdownText : null
      var TextShimmer = ui && isRenderable(ui.TextShimmer) ? ui.TextShimmer : null
      var IconChevronDown = ui && ui.IconChevronDownOutlineRegular ? ui.IconChevronDownOutlineRegular : null
      var IconChevronUp = ui && ui.IconChevronUpOutlineRegular ? ui.IconChevronUpOutlineRegular : null
      var LinkIcon = ui && ui.LinkIconMedium ? ui.LinkIconMedium : null

      ensureToolviewStyles()

      function sitemapIcon() {
        return react.createElement('svg', {
          viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
          react.createElement('rect', { x: 3, y: 3, width: 6, height: 4, rx: 1, fill: 'none' }),
          react.createElement('rect', { x: 15, y: 3, width: 6, height: 4, rx: 1, fill: 'none' }),
          react.createElement('rect', { x: 9, y: 17, width: 6, height: 4, rx: 1, fill: 'none' }),
          react.createElement('path', { d: 'M6 7v3h12V7' }),
          react.createElement('path', { d: 'M12 10v7' }),
        )
      }

      function inputLabel(args) {
        if (typeof args.domain === 'string' && args.domain !== '') return args.domain
        if (typeof args.category === 'string' && args.category !== '') return args.category
        if (typeof args.query === 'string' && args.query !== '') return args.query
        return 'web_sitemap'
      }

      return function DshNetworkSitemapRow(props) {
        var t = labelText(localeRef, '')
        var block = (props && props.block) || {}
        var args = argsOf(block)
        var rawMeta = block.meta && typeof block.meta === 'object' && !Array.isArray(block.meta) ? block.meta : null
        var meta = rawMeta || {}
        var entries = Array.isArray(meta.entries) ? meta.entries : []
        var resolved = Array.isArray(meta.resolved) ? meta.resolved : []
        var summary = typeof meta.summary === 'string' ? meta.summary : ''
        var digest = typeof meta.digest === 'string' ? meta.digest : ''
        var warnings = Array.isArray(meta.warnings) ? meta.warnings : []
        var uncertainty = Array.isArray(meta.uncertainty) ? meta.uncertainty : []
        // Canonical `"kind" in block` settled check (see the shared helpers
        // above) — meta presence alone misses throwing calls, which carry
        // `isError: true` and no `meta` on the settled ToolResultNode.
        var settled = isSettledToolCall(block) || rawMeta !== null
        var errored = isErroredToolCall(block)
        var errorMessage = errored ? errorMessageOf(block) : ''
        var count = typeof meta.count === 'number' ? meta.count : entries.length
        var resolvedCount = typeof meta.resolvedCount === 'number' ? meta.resolvedCount : resolved.length

        // Open by default once we have entries — unlike a search result the
        // user usually wants to scan the matched portals, not the running
        // indicator. A failed call also opens so the error is visible.
        var openState = react.useState(entries.length > 0 || resolved.length > 0 || errored)
        var open = settled && openState[0]
        var setOpen = openState[1]
        var toggle = function () { setOpen(function (v) { return !v }) }

        var headerFragments = []
        var title = inputLabel(args)
        headerFragments.push(title)
        if (errored) {
          headerFragments.push(t.searchToolFailed)
        } else if (settled) {
          if (count > 0) headerFragments.push(count + ' 个门户')
          if (resolvedCount > 0) headerFragments.push(resolvedCount + ' 个解析 URL')
          if (typeof meta.status === 'string' && meta.status === 'unavailable') headerFragments.push('无可用')
        } else {
          headerFragments.push(t.searchToolRunning)
        }

        var badges = react.createElement('span', { className: 'dshn-suffix', key: 'badges' },
          errored ? Badge(react, 'error', 'error') : null,
          settled && !errored && typeof meta.status === 'string' && meta.status !== 'ok'
            ? Badge(react, meta.status, 'warn')
            : null,
          warnings.length ? Badge(react, warnings.length + ' warning' + (warnings.length > 1 ? 's' : ''), 'warn') : null,
          uncertainty.length ? Badge(react, uncertainty.length + ' uncertain', 'uncertain') : null,
        )

        var headerText = [react.createElement('span', { className: 'dshn-title', key: 'title' }, '门户查询')]
        headerFragments.forEach(function (fragment, i) {
          headerText.push(react.createElement('span', { className: 'dshn-sep', 'data-shimmer-decoration': true, 'aria-hidden': true, key: 'sep' + i }))
          headerText.push(react.createElement('span', {
            className: 'dshn-summary' + (i === headerFragments.length - 1 ? ' dshn-summary-fill' : ''),
            key: 'frag' + i,
          }, fragment))
        })
        headerText.push(badges)
        var textWrap = TextShimmer
          ? react.createElement(TextShimmer, { active: !settled }, headerText)
          : react.createElement('span', { className: 'dshn-textwrap' }, headerText)

        var leading = react.createElement('span', { className: 'dshn-leading', 'aria-hidden': true },
          open
            ? (IconChevronUp ? react.createElement(IconChevronUp, { size: 14 }) : flowIcon(react, CHEVRON_UP_PATH, true))
            : [
              react.createElement('span', { className: 'dshn-icon-idle', key: 'idle' }, sitemapIcon()),
              react.createElement('span', { className: 'dshn-chevron-hover', key: 'chev' },
                IconChevronDown ? react.createElement(IconChevronDown, { size: 14 }) : flowIcon(react, CHEVRON_DOWN_PATH, true)),
            ],
        )

        var rowProps = {
          type: 'button',
          className: 'dshn-toolview-row',
          onClick: settled ? toggle : undefined,
          'aria-expanded': settled ? open : undefined,
        }
        if (!settled) rowProps['data-static'] = 'true'

        var bodyChildren = []
        if (errored) {
          // A throwing call carries no meta; surface the structured error text
          // the model already saw so the user can audit the same failure.
          bodyChildren.push(react.createElement('div', { className: 'dshn-error', role: 'alert', key: 'error' },
            react.createElement('div', { className: 'dshn-error-title' }, t.searchToolFailed),
            errorMessage !== '' ? react.createElement('pre', { className: 'dshn-error-detail' }, errorMessage) : null,
          ))
        }
        if (!errored && summary !== '') {
          bodyChildren.push(react.createElement('div', { className: 'dshn-answer', key: 'summary' },
            MarkdownText
              ? react.createElement(MarkdownText, { text: summary, labels: markdownLabels(localeRef) })
              : react.createElement('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, font: 'inherit' } }, summary)))
        }
        if (entries.length > 0) {
          bodyChildren.push(react.createElement('ul', { className: 'dshn-portals', key: 'entries' },
            entries.map(function (entry, i) {
              if (!entry || typeof entry.domain !== 'string') return null
              var domain = entry.domain
              var label = domain
              var metaBits = []
              if (typeof entry.category === 'string' && entry.category !== '') metaBits.push(entry.category)
              if (Number.isInteger(entry.priority)) metaBits.push('p' + entry.priority)
              if (typeof entry.language === 'string' && entry.language !== '') metaBits.push(entry.language)
              if (typeof entry.region === 'string' && entry.region !== '') metaBits.push(entry.region)
              var description = typeof entry.description === 'string' ? entry.description : ''
              // A "domain-only" entry (no description) is still useful as a
              // label — only the title row renders, no description block.
              var linkProps = { className: 'dshn-portal-link' }
              var iconNode = null
              var domainHref = 'https://' + domain
              if (entry.hasSearchUrl === true) {
                linkProps.href = domainHref
                linkProps.target = '_blank'
                linkProps.rel = 'noopener noreferrer'
                iconNode = LinkIcon
                  ? react.createElement(LinkIcon, { kind: 'url', href: domainHref, className: 'dshn-link-icon' })
                  : react.createElement('svg', {
                    className: 'dshn-link-icon', viewBox: '0 0 24 24',
                    fill: 'none', stroke: 'currentColor', strokeWidth: 2,
                    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
                  }, LINK_ICON_PATHS.map(function (d, pi) {
                    return react.createElement('path', { key: pi, d: d, fill: 'none' })
                  }))
              }
              return react.createElement('li', { key: 'p' + i, className: 'dshn-portal' },
                react.createElement('div', { className: 'dshn-portal-row' },
                  react.createElement(linkProps.href ? 'a' : 'span', linkProps, iconNode, label),
                  metaBits.map(function (bit, bi) {
                    return react.createElement('span', { className: 'dshn-portal-badge', key: 'b' + bi }, bit)
                  }),
                ),
                description ? react.createElement('div', { className: 'dshn-portal-desc' }, description) : null,
              )
            })
          ))
        }
        if (resolved.length > 0) {
          bodyChildren.push(react.createElement('div', { className: 'dshn-resolved', key: 'resolved' },
            react.createElement('div', { className: 'dshn-resolved-title' }, '解析的搜索 URL'),
            resolved.map(function (r, i) {
              if (!r || typeof r.url !== 'string') return null
              var href = safeHref(r.url)
              var domainLabel = typeof r.domain === 'string' && r.domain !== '' ? r.domain : ''
              var queryLabel = typeof r.query === 'string' && r.query !== '' ? r.query : ''
              var sublabel = queryLabel !== ''
                ? domainLabel + ' · ' + queryLabel
                : domainLabel
              var linkProps = { className: 'dshn-resolved-link' }
              if (href) {
                linkProps.href = href
                linkProps.target = '_blank'
                linkProps.rel = 'noopener noreferrer'
              }
              return react.createElement('div', { className: 'dshn-resolved-row', key: 'r' + i },
                react.createElement('span', { className: 'dshn-resolved-domain' }, sublabel),
                react.createElement(href ? 'a' : 'span', linkProps, linkLabel(r.url, href)),
              )
            })
          ))
        }
        if (digest !== '') {
          bodyChildren.push(react.createElement('details', { className: 'dshn-attempts', key: 'digest' },
            react.createElement('summary', null, '完整摘要'),
            react.createElement('pre', null, digest)))
        }
        if (uncertainty.length) {
          bodyChildren.push(react.createElement('ul', { key: 'unc', style: { paddingLeft: '18px', margin: '8px 0 0', fontSize: '12px' } },
            uncertainty.map(function (u, i) { return react.createElement('li', { key: i }, u) })))
        }
        if (warnings.length) {
          bodyChildren.push(react.createElement('ul', { key: 'warns', style: { paddingLeft: '18px', margin: '6px 0 0', fontSize: '12px', color: '#a16207' } },
            warnings.map(function (w, i) { return react.createElement('li', { key: i }, w) })))
        }
        if (!errored && entries.length === 0 && resolved.length === 0 && summary === '' && settled) {
          bodyChildren.push(react.createElement('div', { className: 'dshn-empty', key: 'empty' }, t.searchToolNoResults))
        }

        var bodyNode = !settled
          ? null
          : react.createElement('div', { className: 'dshn-body' },
            react.createElement('div', { className: 'dshn-card' }, bodyChildren),
          )

        return react.createElement('div', { className: 'dshn-toolview' },
          react.createElement('button', rowProps, leading, textWrap),
          open ? bodyNode : null,
        )
      }
    }

    /**
     * `tool.call.toolview` row for `web_config` — the settings tool, the one
     * call whose SUBJECT is the configuration itself.
     *
     * Why it needs its own row: the host used to persist
     * `{status, action, error, persisted}` — a verb and a boolean — so the
     * generic card read "web_config set" and nothing else. A user watching the
     * model retune their network settings (or refuse to, because the
     * 允许修改设置 safety toggle is off) could not see WHICH field changed, nor
     * what the live config now holds, without reading the raw trajectory.
     *
     * The host now persists the secret-free summary it handed the model
     * (`meta.config`) plus the field names a LANDED `set` forwarded
     * (`meta.changes`), so this row renders:
     *   - the usual borderless disclosure row: action · engine count /
     *     change count, with 已写入磁盘 / 仅内存 / 已被拒绝 badges;
     *   - a 变更 group naming every patched field with its RESULTING value
     *     from `meta.config`, so a clamped write (the model asks for
     *     searchMaxResults 50, the host stores 20) is visible AS a clamp
     *     instead of being echoed back as the request;
     *   - the config itself as labelled groups, reusing the settings page's own
     *     field labels (`sec…` / `fetchTimeout` / … from DICTS) so the card and
     *     设置 → 网络 word the same field the same way;
     *   - the whole summary as pretty-printed JSON behind a details, which is
     *     what makes the card auditable when a field is missing from the
     *     labelled groups.
     *
     * `meta.config` is OPTIONAL by design: a session recorded before the host
     * started persisting it (or a meta that fell outside the meta budget)
     * renders the action, status and badges alone over a 无配置数据 note rather
     * than throwing inside React. `meta.changes` is absent on a refused write
     * by construction — the gate answers with the config untouched, and listing
     * requested-but-unapplied fields would draw edits that never happened.
     *
     * No native cell exists for `web_config` (it is this plugin's own tool), so
     * like `http_request` / `web_sitemap` this row is the only entry in its
     * cell and renders unconditionally; the sub-zero priority is the same
     * habit, not a shadow.
     */
    function WebConfigToolview(react, ui, localeRef) {
      var TextShimmer = ui && isRenderable(ui.TextShimmer) ? ui.TextShimmer : null
      var IconChevronDown = ui && ui.IconChevronDownOutlineRegular ? ui.IconChevronDownOutlineRegular : null
      var IconChevronUp = ui && ui.IconChevronUpOutlineRegular ? ui.IconChevronUpOutlineRegular : null

      ensureToolviewStyles()

      /** The Material `tune` glyph — sliders, i.e. "settings". */
      function tuneIcon() {
        return react.createElement('svg', { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
          react.createElement('path', { d: TUNE_ICON_PATH, fill: 'currentColor' }))
      }

      /** One chip; `state` ('on' / 'off' / 'key') drives the colour. */
      function chip(label, state, key) {
        var props = { className: 'dshn-chip', key: key }
        if (state) props['data-state'] = state
        return react.createElement('span', props, label)
      }

      /** A wrapped chip row — the engine chain, the allowlist, the switches. */
      function chipRow(nodes, key) {
        return react.createElement('span', { className: 'dshn-chips', key: key }, nodes)
      }

      /** A label/value row. `value` may be text or a node; empty values are
       *  dropped so an absent config field costs no blank row. */
      function field(label, value, key) {
        if (value === null || value === undefined || value === '') return null
        return react.createElement('div', { className: 'dshn-cfgrow', key: key },
          react.createElement('span', { className: 'dshn-cfgname' }, label),
          react.createElement('span', { className: 'dshn-cfgvalue' }, value))
      }

      /** A titled group of rows, skipped entirely when it has none. */
      function group(title, rows, key) {
        var kept = rows.filter(Boolean)
        if (kept.length === 0) return null
        return react.createElement('div', { className: 'dshn-cfggroup', key: key },
          react.createElement('div', { className: 'dshn-cfggroup-title' }, title),
          kept)
      }

      /** Absent config booleans mean the default, which is ON for every switch
       *  the host exposes (`config.x !== false`) — so only `false` reads off,
       *  and a chip can never claim "off" for a field the summary never
       *  carried. */
      function switchState(value) {
        return value === false ? 'off' : 'on'
      }

      function isStr(value) {
        return typeof value === 'string' && value !== ''
      }

      function jsonText(value) {
        try {
          var text = JSON.stringify(value, null, 2)
          if (typeof text !== 'string') return ''
          // A hand-written config can carry a huge allowlist / options map; the
          // raw view is an audit aid, not the primary surface.
          return text.length > 8000 ? text.slice(0, 8000) + '…' : text
        } catch (error) { return '' }
      }

      /** Any config value as one line; never empty (a change row must show its
       *  field even when the summary has no entry for it). */
      function valueText(value) {
        if (value === null || value === undefined) return '—'
        if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(function (v) { return String(v) }).join(', ')
        if (typeof value === 'object') {
          var json = jsonText(value)
          return json === '' ? '—' : json.replace(/\s+/g, ' ')
        }
        return String(value)
      }

      return function DshNetworkConfigRow(props) {
        var t = labelText(localeRef, '')
        var block = (props && props.block) || {}
        var args = argsOf(block)
        var rawMeta = block.meta && typeof block.meta === 'object' && !Array.isArray(block.meta) ? block.meta : null
        var meta = rawMeta || {}
        // The action is readable while the call is still RUNNING (argsRaw
        // streams first), so the header says 读取配置 / 修改配置 immediately and
        // the meta is only the fallback for a settled block that arrived
        // without arguments.
        var action = isStr(args.action) ? args.action.toLowerCase()
          : (isStr(meta.action) ? String(meta.action).toLowerCase() : '')
        var isSet = action === 'set'
        var config = meta.config && typeof meta.config === 'object' && !Array.isArray(meta.config) ? meta.config : null
        var changes = Array.isArray(meta.changes)
          ? meta.changes.filter(function (name) { return isStr(name) })
          : []
        var engines = config && Array.isArray(config.searchEngines)
          ? config.searchEngines.filter(function (id) { return isStr(id) })
          : []
        var engineConfigs = config && config.searchEngineConfigs && typeof config.searchEngineConfigs === 'object'
          ? config.searchEngineConfigs
          : {}

        // Canonical `"kind" in block` settled check (see the shared helpers
        // above) — meta presence alone misses a THROWN call, which carries
        // `isError: true` and no `meta` at all.
        var settled = isSettledToolCall(block) || rawMeta !== null
        var errored = isErroredToolCall(block)
        var errorMessage = errored ? errorMessageOf(block) : ''
        // A soft error: the tool ANSWERED (it did not throw) and the answer is
        // a refusal — almost always the safety gate in web_config.execute.
        var refused = settled && !errored && meta.status === 'error'
        var refusal = refused && isStr(meta.error) ? meta.error : ''

        // A mutation opens by default — the user should see what changed
        // without a click — while a plain read keeps the native collapsed
        // rhythm. A failure and a refusal open too, for the same reason the
        // other rows do it: the actionable part must not hide behind a click.
        // The `null` sentinel means "still following that default": a
        // useState(true) initializer only runs on the FIRST render, which
        // happens while the call is still running.
        var openState = react.useState(null)
        var defaultOpen = settled && (errored || refused || isSet)
        var open = settled && (openState[0] === null ? defaultOpen : openState[0])
        var setOpen = openState[1]
        var toggle = function () { setOpen(!open) }

        var actionLabel = isSet ? t.configToolSet : t.configToolGet
        var headerFragments = []
        if (action !== '') headerFragments.push(actionLabel)
        if (errored) {
          headerFragments.push(t.searchToolFailed)
        } else if (settled) {
          if (refused) headerFragments.push(t.configToolRefused)
          else if (isSet) headerFragments.push(changes.length + ' ' + t.configToolChanges)
          else headerFragments.push(engines.length + ' ' + t.configToolEngines)
        } else {
          headerFragments.push(t.configToolRunning)
        }

        var badges = react.createElement('span', { className: 'dshn-suffix', key: 'badges' },
          errored ? Badge(react, 'error', 'error') : null,
          refused ? Badge(react, t.configToolRefused, 'warn') : null,
          settled && !errored && meta.persisted === true ? Badge(react, t.configToolPersisted, 'ok') : null,
          settled && !errored && meta.persisted === false ? Badge(react, t.configToolMemoryOnly, 'warn') : null,
        )

        var headerText = [react.createElement('span', { className: 'dshn-title', key: 'title' }, t.configToolTitle)]
        headerFragments.forEach(function (fragment, i) {
          headerText.push(react.createElement('span', { className: 'dshn-sep', 'data-shimmer-decoration': true, 'aria-hidden': true, key: 'sep' + i }))
          headerText.push(react.createElement('span', {
            className: 'dshn-summary' + (i === headerFragments.length - 1 ? ' dshn-summary-fill' : ''),
            key: 'frag' + i,
          }, fragment))
        })
        headerText.push(badges)
        var textWrap = TextShimmer
          ? react.createElement(TextShimmer, { active: !settled }, headerText)
          : react.createElement('span', { className: 'dshn-textwrap' }, headerText)

        var leading = react.createElement('span', { className: 'dshn-leading', 'aria-hidden': true },
          open
            ? (IconChevronUp ? react.createElement(IconChevronUp, { size: 14 }) : flowIcon(react, CHEVRON_UP_PATH, true))
            : [
              react.createElement('span', { className: 'dshn-icon-idle', key: 'idle' }, tuneIcon()),
              react.createElement('span', { className: 'dshn-chevron-hover', key: 'chev' },
                IconChevronDown ? react.createElement(IconChevronDown, { size: 14 }) : flowIcon(react, CHEVRON_DOWN_PATH, true)),
            ],
        )

        var rowProps = {
          type: 'button',
          className: 'dshn-toolview-row',
          onClick: settled ? toggle : undefined,
          'aria-expanded': settled ? open : undefined,
        }
        if (!settled) rowProps['data-static'] = 'true'

        var bodyChildren = []
        if (errored) {
          // A throwing call carries no meta and no config — show the structured
          // error text the model already saw.
          bodyChildren.push(react.createElement('div', { className: 'dshn-error', role: 'alert', key: 'error' },
            react.createElement('div', { className: 'dshn-error-title' }, t.searchToolFailed),
            errorMessage !== '' ? react.createElement('pre', { className: 'dshn-error-detail' }, errorMessage) : null,
          ))
        }
        if (refused) {
          // The gate, not a crash: name it as a refusal and print the host's own
          // message, which is how the user learns the toggle they must flip.
          bodyChildren.push(react.createElement('div', { className: 'dshn-refused', role: 'status', key: 'refused' },
            react.createElement('div', { className: 'dshn-refused-title' }, actionLabel + ' · ' + t.configToolRefused),
            refusal !== '' ? react.createElement('pre', { className: 'dshn-refused-detail' }, refusal) : null,
          ))
        }
        if (!errored && changes.length > 0) {
          bodyChildren.push(group(t.configToolChangeTitle + ' (' + changes.length + ')',
            changes.map(function (name, i) {
              // The value comes from the POST-write summary, so the card shows
              // what the host actually stored — the request is never echoed
              // back as if it had landed verbatim.
              return field(name, valueText(config ? config[name] : undefined), 'ch' + i)
            }), 'changes'))
        }
        if (!errored && config) {
          // Per-engine detail: an endpoint override or a custom options map is
          // the difference between "brave is in the chain" and "brave is being
          // called with country=DE", so each engine that declares one gets its
          // own titled group under the chain row.
          var engineDetail = []
          engines.forEach(function (id, i) {
            var entry = engineConfigs[id] && typeof engineConfigs[id] === 'object' ? engineConfigs[id] : null
            if (!entry) return
            var nodes = []
            if (isStr(entry.endpoint)) {
              nodes.push(field('endpoint', react.createElement('span', { 'data-mono': 'true' }, entry.endpoint), 'ep' + i))
            }
            var options = entry.options && typeof entry.options === 'object' ? Object.keys(entry.options) : []
            if (options.length > 0) {
              nodes.push(field('options', react.createElement('span', { 'data-mono': 'true' },
                options.map(function (key) { return key + '=' + String(entry.options[key]) }).join('  ')), 'op' + i))
            }
            if (nodes.length > 0) engineDetail.push(group(id, nodes, 'eng' + i))
          })

          var groups = [
            // ── the search engine chain, in fallback order ──
            group(t.sectionEngines, [
              field(t.configToolChain, engines.length === 0
                ? react.createElement('span', { className: 'dshn-empty' }, t.configToolNoEngines)
                : chipRow(engines.map(function (id, i) {
                  var entry = engineConfigs[id] && typeof engineConfigs[id] === 'object' ? engineConfigs[id] : null
                  var nodes = [chip(id, null, 'e' + i)]
                  // `hasApiKey` is the host's derived view of the key map, so a
                  // key chip means the CLI really will send the auth header.
                  if (entry && entry.hasApiKey === true) nodes.push(chip(t.configToolKey, 'key', 'k' + i))
                  return nodes
                }).reduce(function (all, nodes) { return all.concat(nodes) }, []), 'chain'), 'chain'),
            ].concat(engineDetail), 'engines'),
            // ── request identity and the per-tool timeouts ──
            group(t.sectionRequest, [
              field(t.userAgent, react.createElement('span', { 'data-mono': 'true' }, valueText(config.userAgent)), 'ua'),
              field(t.fetchTimeout, valueText(config.fetchTimeoutMs), 'ft'),
              field(t.searchTimeout, valueText(config.searchTimeoutMs), 'st'),
              field(t.httpTimeout, valueText(config.httpTimeoutMs), 'ht'),
            ], 'request'),
            // ── the three protections + the host allowlist ──
            group(t.sectionSafety, [
              field(t.configToolProtections, chipRow([
                chip(t.ssrfProtection, switchState(config.ssrfProtection), 'p1'),
                chip(t.redirectProtection, switchState(config.redirectProtection), 'p2'),
                chip(t.protocolLock, switchState(config.protocolLock), 'p3'),
              ], 'prot'), 'prot'),
              field(t.allowlist, Array.isArray(config.allowlist) && config.allowlist.length > 0
                ? chipRow(config.allowlist.map(function (host, i) { return chip(String(host), null, 'a' + i) }), 'allow')
                : react.createElement('span', { className: 'dshn-empty' }, t.configToolUnrestricted), 'allow'),
            ], 'safety'),
            // ── caps and the http_request verb set ──
            group(t.sectionLimits, [
              field(t.maxResults, valueText(config.searchMaxResults), 'mr'),
              field(t.maxRedirects, valueText(config.maxRedirects), 'mrd'),
              field(t.maxBodyChars, valueText(config.maxBodyChars), 'mbc'),
              field(t.methods, valueText(config.httpMethods), 'hm'),
            ], 'limits'),
            // ── the per-tool kill switches. `enabled` (the row-config kill
            //    switch) is deliberately absent: apply() registers no tool at
            //    all while it is off, so no call can ever report it. ──
            group(t.sectionTools, [
              field(t.configToolSwitches, chipRow([
                chip(t.toolWebSearch, switchState(config.webSearchTool), 't1'),
                chip(t.toolWebFetch, switchState(config.webFetchTool), 't2'),
                chip(t.toolHttpRequest, switchState(config.httpRequestTool), 't3'),
                chip(t.toolWebSitemap, switchState(config.webSitemapTool), 't4'),
                chip(t.toolWebDownload, switchState(config.downloadTool), 't5'),
              ], 'tools'), 'tools'),
            ], 'tools-group'),
            // ── GitHub engine. `hasGithubToken` is all the host ever exposes;
            //    the token itself never leaves the host process. ──
            group(t.githubGroupTitle, [
              field(t.githubIndexes, Array.isArray(config.githubIndexes) && config.githubIndexes.length > 0
                ? valueText(config.githubIndexes) : t.configToolAuto, 'gi'),
              field(t.githubSort, valueText(config.githubSort), 'gs'),
              field(t.githubToken, config.hasGithubToken === true ? t.githubTokenConfigured : t.githubTokenEmpty, 'gt'),
            ], 'github'),
            react.createElement('details', { className: 'dshn-details', key: 'raw' },
              react.createElement('summary', null, t.configToolRaw),
              react.createElement('pre', null, jsonText(config))),
          ]
          bodyChildren.push(react.createElement('div', { className: 'dshn-cfg', key: 'cfg' }, groups))
        } else if (!errored && settled && !refused) {
          bodyChildren.push(react.createElement('div', { className: 'dshn-empty', key: 'empty' }, t.configToolEmpty))
        }

        var bodyNode = !settled
          ? null
          : react.createElement('div', { className: 'dshn-body' },
            react.createElement('div', { className: 'dshn-card' }, bodyChildren),
          )

        return react.createElement('div', { className: 'dshn-toolview' },
          react.createElement('button', rowProps, leading, textWrap),
          open ? bodyNode : null,
        )
      }
    }

    /**
     * `tool.call.toolview` row for `web_download` — the file-write tool.
     *
     * Same disclosure-row rhythm as HttpRequestToolview, but the body shows
     * the one thing the model acted on: WHERE the bytes landed. The path is
     * the payload here (there is no body to show), so it is rendered as
     * selectable monospace text rather than a link — the user copies it, and
     * a link would either 404 (tmp) or navigate the IDE away from the
     * conversation.
     *
     * The `dest` badge is deliberately loud when it says `workspace`: that
     * is the only download whose file the user is expected to still own
     * tomorrow, and the difference is invisible from the path alone on some
     * platforms.
     */
    function WebDownloadToolview(react, ui, localeRef) {
      var IconChevronDown = ui && ui.IconChevronDownOutlineRegular ? ui.IconChevronDownOutlineRegular : null
      var IconChevronUp = ui && ui.IconChevronUpOutlineRegular ? ui.IconChevronUpOutlineRegular : null

      ensureToolviewStyles()

      // Download-to-disk glyph: a downward arrow into a tray (Material
      // `download`), which is also what the model-facing tool is named
      // after — so the row and the trajectory entry read as the same act.
      function downloadIcon() {
        return react.createElement('svg', {
          viewBox: '0 0 24 24',
          fill: 'none', stroke: 'currentColor', strokeWidth: 2,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true,
        },
          react.createElement('path', { key: 'd', d: 'M12 3v11', fill: 'none' }),
          react.createElement('path', { key: 'a', d: 'M7.5 10.5 12 15l4.5-4.5', fill: 'none' }),
          react.createElement('path', { key: 't', d: 'M4 17.5v1.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5', fill: 'none' }),
        )
      }

      return function DshNetworkWebDownloadRow(props) {
        var t = labelText(localeRef, '')
        var block = (props && props.block) || {}
        var args = argsOf(block)
        var rawMeta = block.meta && typeof block.meta === 'object' && !Array.isArray(block.meta) ? block.meta : null
        var meta = rawMeta || {}
        var requestedUrl = typeof args.url === 'string' ? args.url : ''
        var finalUrl = typeof meta.url === 'string' && meta.url !== '' ? meta.url : requestedUrl
        var statusCode = Number.isInteger(meta.statusCode) ? meta.statusCode : null
        var contentType = safeContentType(meta.contentType)
        var filePath = typeof meta.path === 'string' ? meta.path : ''
        var filename = typeof meta.filename === 'string' && meta.filename !== '' ? meta.filename : ''
        var dest = meta.dest === 'workspace' ? 'workspace' : (meta.dest === 'tmp' ? 'tmp' : '')
        var bytes = Number.isInteger(meta.bytes) ? meta.bytes : null
        var warnings = Array.isArray(meta.warnings) ? meta.warnings : []

        // Same canonical settled check as the other rows — a THROWN call
        // (refused extension, over the size cap, blocked address) lands no
        // meta at all, and meta-presence alone would leave it spinning.
        var settled = isSettledToolCall(block) || rawMeta !== null
        var errored = isErroredToolCall(block)
        var errorMessage = errored ? errorMessageOf(block) : ''

        // Open by DEFAULT on a settled call, success included (same as
        // WebFetchToolview): the body is two short fields, and the path is
        // the entire reason to open a download row — hiding it behind a
        // click is how "where did that file go?" gets asked. A refusal is
        // also open for the same reason: the message IS the answer.
        var openState = react.useState(true)
        var open = settled && openState[0]
        var setOpen = openState[1]
        var toggle = function () { setOpen(function (v) { return !v }) }

        var headerFragments = []
        headerFragments.push(filename !== '' ? filename : (requestedUrl || ''))
        if (errored) {
          headerFragments.push(t.searchToolFailed)
        } else if (settled) {
          if (dest !== '') headerFragments.push(dest)
          if (bytes !== null) headerFragments.push(bytes.toLocaleString() + ' B')
          if (contentType !== '') headerFragments.push(contentType)
          if (statusCode !== null) headerFragments.push(String(statusCode))
        } else {
          headerFragments.push(t.searchToolRunning)
        }

        var badges = react.createElement('span', { className: 'dshn-suffix', key: 'badges' },
          errored ? Badge(react, 'error', 'error') : null,
          settled && !errored && statusCode !== null ? Badge(react, String(statusCode), statusTone(statusCode)) : null,
          settled && !errored && dest !== '' ? Badge(react, dest, dest === 'workspace' ? 'warn' : 'meta') : null,
          warnings.length ? Badge(react, warnings.length + ' warning' + (warnings.length > 1 ? 's' : ''), 'warn') : null,
        )

        var headerText = [react.createElement('span', { className: 'dshn-title', key: 'title' }, '文件下载')]
        headerFragments.forEach(function (fragment, i) {
          headerText.push(react.createElement('span', { className: 'dshn-sep', 'data-shimmer-decoration': true, 'aria-hidden': true, key: 'sep' + i }))
          headerText.push(react.createElement('span', {
            className: 'dshn-summary' + (i === headerFragments.length - 1 ? ' dshn-summary-fill' : ''),
            key: 'frag' + i,
          }, fragment))
        })
        headerText.push(badges)
        var TextShimmer = ui && isRenderable(ui.TextShimmer) ? ui.TextShimmer : null
        var textWrap = TextShimmer
          ? react.createElement(TextShimmer, { active: !settled }, headerText)
          : react.createElement('span', { className: 'dshn-textwrap' }, headerText)

        var leading = react.createElement('span', { className: 'dshn-leading', 'aria-hidden': true },
          open
            ? (IconChevronUp ? react.createElement(IconChevronUp, { size: 14 }) : flowIcon(react, CHEVRON_UP_PATH, true))
            : [
              react.createElement('span', { className: 'dshn-icon-idle', key: 'idle' }, downloadIcon()),
              react.createElement('span', { className: 'dshn-chevron-hover', key: 'chev' },
                IconChevronDown ? react.createElement(IconChevronDown, { size: 14 }) : flowIcon(react, CHEVRON_DOWN_PATH, true)),
            ],
        )

        var rowProps = {
          type: 'button',
          className: 'dshn-toolview-row',
          onClick: settled ? toggle : undefined,
          'aria-expanded': settled ? open : undefined,
        }
        if (!settled) rowProps['data-static'] = 'true'

        var bodyChildren = []
        if (errored) {
          bodyChildren.push(react.createElement('div', { className: 'dshn-error', role: 'alert', key: 'error' },
            react.createElement('div', { className: 'dshn-error-title' }, t.searchToolFailed),
            errorMessage !== '' ? react.createElement('pre', { className: 'dshn-error-detail' }, errorMessage) : null,
          ))
        }
        if (!errored && filePath !== '') {
          bodyChildren.push(react.createElement('div', { className: 'dshn-headers', key: 'path' },
            react.createElement('div', { className: 'dshn-headers-title' }, dest === 'workspace' ? '工作区文件' : '临时文件'),
            react.createElement('div', { className: 'dshn-headers-row' },
              react.createElement('span', { className: 'dshn-headers-name' }, '路径'),
              react.createElement('span', { className: 'dshn-headers-value' }, filePath)),
          ))
        }
        if (!errored && finalUrl !== '') {
          bodyChildren.push(react.createElement('div', { className: 'dshn-headers', key: 'src' },
            react.createElement('div', { className: 'dshn-headers-title' }, '来源'),
            react.createElement('div', { className: 'dshn-headers-row' },
              react.createElement('span', { className: 'dshn-headers-name' }, 'URL'),
              react.createElement('span', { className: 'dshn-headers-value' }, finalUrl)),
          ))
        }
        if (warnings.length) {
          bodyChildren.push(react.createElement('ul', { key: 'warns', style: { paddingLeft: '18px', margin: '8px 0 0', fontSize: '12px' } },
            warnings.map(function (w, i) { return react.createElement('li', { key: i }, w) })))
        }

        var bodyNode = !settled
          ? null
          : react.createElement('div', { className: 'dshn-body' },
            react.createElement('div', { className: 'dshn-card' }, bodyChildren),
          )

        return react.createElement('div', { className: 'dshn-toolview' },
          react.createElement('button', rowProps, leading, textWrap),
          open ? bodyNode : null,
        )
      }
    }

    return {
      Renderer,
      FetchBlockRenderer,
      SearchToolview,
      HttpRequestToolview,
      WebFetchToolview,
      WebSitemapToolview,
      WebConfigToolview,
      WebDownloadToolview,
    }

  },
})
