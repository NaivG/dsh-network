/* dsh-web browser half for dsh-network — tool-call card renderers
 * (package-local chunk, materialized via require.async from dsh/client.js).
 *
 * Three `tool.call.toolview` rows (web_search / http_request / web_sitemap)
 * styled to read like dsh's own first-party tool cards — a borderless
 * disclosure row over a WebBlock-styled body card — plus the legacy
 * `tool.web.item` / `tool.web.fetch.item` block renderers for older dsh
 * builds. All renderers are reactive, fall back to the raw body when a
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
          fontFamily: 'var(--dsw-alias-mono, monospace)',
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
              style: { display: 'inline-block', padding: '1px 6px', fontSize: '11px', lineHeight: 1.4, borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)', fontFamily: 'var(--dsw-alias-mono, monospace)' },
            }, 'engine: ' + meta.engine),
            typeof meta.statusCode === 'number' && react.createElement('span', {
              style: { display: 'inline-block', padding: '1px 6px', fontSize: '11px', lineHeight: 1.4, borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)', fontFamily: 'var(--dsw-alias-mono, monospace)' },
            }, 'HTTP ' + meta.statusCode),
            typeof meta.contentType === 'string' && react.createElement('span', {
              style: { display: 'inline-block', padding: '1px 6px', fontSize: '11px', lineHeight: 1.4, borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)', fontFamily: 'var(--dsw-alias-mono, monospace)' },
            }, meta.contentType.split(';')[0]),
            typeof meta.linksCount === 'number' && react.createElement('span', {
              style: { display: 'inline-block', padding: '1px 6px', fontSize: '11px', lineHeight: 1.4, borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)', fontFamily: 'var(--dsw-alias-mono, monospace)' },
            }, meta.linksCount + ' outgoing links'),
            meta.truncated && react.createElement('span', {
              style: { display: 'inline-block', padding: '1px 6px', fontSize: '11px', lineHeight: 1.4, borderRadius: '6px', color: '#a16207', background: 'rgba(250, 204, 21, 0.15)', border: '1px solid rgba(127,127,127,0.35)', fontFamily: 'var(--dsw-alias-mono, monospace)' },
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

    function SearchToolview(react, ui, localeRef) {
      var MarkdownText = ui && isRenderable(ui.MarkdownText) ? ui.MarkdownText : null
      var TextShimmer = ui && isRenderable(ui.TextShimmer) ? ui.TextShimmer : null
      var IconGlobe = ui && ui.IconGlobeOutlineRegular ? ui.IconGlobeOutlineRegular : null
      var IconChevronDown = ui && ui.IconChevronDownOutlineRegular ? ui.IconChevronDownOutlineRegular : null
      var IconChevronUp = ui && ui.IconChevronUpOutlineRegular ? ui.IconChevronUpOutlineRegular : null
      var LinkIcon = ui && ui.LinkIconMedium ? ui.LinkIconMedium : null

      ensureToolviewStyles()

      function flowIcon(pathD, stroke) {
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
      function linkLabel(url, title) {
        if (typeof title === 'string' && title !== '') return title
        try {
          var hostname = new URL(url).hostname
          return hostname === '' ? url : hostname
        } catch (error) { return url }
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
            ? (IconChevronUp ? react.createElement(IconChevronUp, { size: 14 }) : flowIcon(CHEVRON_UP_PATH, true))
            : [
                react.createElement('span', { className: 'dshn-icon-idle', key: 'idle' },
                  IconGlobe ? react.createElement(IconGlobe, { size: 14 }) : flowIcon(GLOBE_ICON_PATH, false)),
                react.createElement('span', { className: 'dshn-chevron-hover', key: 'chev' },
                  IconChevronDown ? react.createElement(IconChevronDown, { size: 14 }) : flowIcon(CHEVRON_DOWN_PATH, true)),
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

      function flowIcon(pathD, stroke) {
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

      function safeHref(url) {
        if (typeof url !== 'string' || url === '') return null
        try {
          var protocol = new URL(url).protocol
          return protocol === 'http:' || protocol === 'https:' ? url : null
        } catch (error) { return null }
      }

      function safeContentType(raw) {
        if (typeof raw !== 'string' || raw === '') return ''
        return raw.split(';')[0].trim().toLowerCase()
      }

      function statusTone(code) {
        if (!Number.isInteger(code)) return 'meta'
        if (code >= 200 && code < 300) return 'ok'
        if (code >= 300 && code < 400) return 'meta'
        if (code >= 400 && code < 500) return 'warn'
        return 'error'
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
            ? (IconChevronUp ? react.createElement(IconChevronUp, { size: 14 }) : flowIcon(CHEVRON_UP_PATH, true))
            : [
              react.createElement('span', { className: 'dshn-icon-idle', key: 'idle' }, codeIcon()),
              react.createElement('span', { className: 'dshn-chevron-hover', key: 'chev' },
                IconChevronDown ? react.createElement(IconChevronDown, { size: 14 }) : flowIcon(CHEVRON_DOWN_PATH, true)),
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

      function flowIcon(pathD, stroke) {
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

      function safeHref(url) {
        if (typeof url !== 'string' || url === '') return null
        try {
          var protocol = new URL(url).protocol
          return protocol === 'http:' || protocol === 'https:' ? url : null
        } catch (error) { return null }
      }

      function linkLabel(url, fallback) {
        if (typeof fallback === 'string' && fallback !== '') return fallback
        try {
          var host = new URL(url).hostname
          return host === '' ? url : host
        } catch (error) { return url }
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
            ? (IconChevronUp ? react.createElement(IconChevronUp, { size: 14 }) : flowIcon(CHEVRON_UP_PATH, true))
            : [
              react.createElement('span', { className: 'dshn-icon-idle', key: 'idle' }, sitemapIcon()),
              react.createElement('span', { className: 'dshn-chevron-hover', key: 'chev' },
                IconChevronDown ? react.createElement(IconChevronDown, { size: 14 }) : flowIcon(CHEVRON_DOWN_PATH, true)),
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

    return {
      Renderer,
      FetchBlockRenderer,
      SearchToolview,
      HttpRequestToolview,
      WebSitemapToolview,
    }

  },
})
