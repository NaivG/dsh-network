/* dsh-web browser half for dsh-network — sidebar search panel
 * (package-local chunk, materialized via require.async from dsh/client.js).
 *
 * A search-engine-style page behind a sidebar rail entry, built on the same
 * two-registration protocol the built-in plugins (order 0) and schedules
 * (order 10) panels use: an icon in the root-scoped `sidebar.panellist`
 * list slot and the page component registered into the layout's root-scoped
 * keyed `main` slot under the same id. The page POSTs to the host's
 * /dsh-network/search route — the same engine chain the web_search tool
 * uses — and panel state survives unmounts in a module-level cache so
 * peeking at the conversation never loses results.
 *
 * Chunk protocol: this file sits next to dsh/client.js and matches the
 * loader's `client.<name>.js` chunk naming, so the dsh host serves it on
 * demand at /plugins/dsh-network/client.searchpanel.js?rev=… The factory
 * requires the entry ('dsh-network') for the shared surface (i18n labels,
 * config API helper, STYLES, engine lists) and must stay SELF-CONTAINED
 * otherwise — chunks cannot synchronously require each other.
 */

window.__ModuleLoader__.load({
  id: 'dsh-network',
  chunk: 'client.searchpanel.js',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    // Shared surface from the entry module (dsh/client.js).
    var shared = require('dsh-network')
    var labelText = shared.labelText
    var noteFrom = shared.noteFrom
    var fetchConfig = shared.fetchConfig
    var STYLES = shared.STYLES
    var ENGINES = shared.ENGINES
    var ENGINE_LABELS = shared.ENGINE_LABELS

    // ────────────────────── sidebar search panel ──────────────────────
    // A full `main` panel behind a `sidebar.panellist` entry — the same
    // two-registration protocol the built-in plugins (order 0) and schedules
    // (order 10) panels use. The page is a search-engine-style front end over
    // the host's `/dsh-network/search` route: one POST runs the same engine
    // chain the web_search tool uses on the persistent loopback server, and
    // the hits render as result cards (title link, host, snippet, date) under
    // the engines' summary answer.
    var SEARCH_PANEL_ID = 'dsh-network-search'

    /** Panel state that outlives the component: switching to another sidebar
     *  entry unmounts this page, and without this cache the results (and the
     *  typed query) would vanish the moment the user peeked at the
     *  conversation. History keeps the last 8 queries for one-click reruns. */
    var searchPanelCache = { query: '', engine: '', count: 10, data: null, history: [] }

    function hostOfUrl(url) {
      try { return new URL(String(url)).host } catch (error) { return String(url || '') }
    }

    function formatElapsedSeconds(ms) {
      var seconds = Number(ms) / 1000
      if (!isFinite(seconds) || seconds < 0) return ''
      return String(seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10)
    }

    /** The sidebar rail glyph. Falls back to an inline magnifier when the
     *  host primitives build does not export IconSearchOutlineRegular. */
    function SearchPanelIcon(react, ui) {
      var IconSearch = ui && ui.IconSearchOutlineRegular ? ui.IconSearchOutlineRegular : null
      return function SearchPanelIconComponent(props) {
        var size = props && typeof props.size === 'number' ? props.size : 18
        if (IconSearch) return react.createElement(IconSearch, { size: size })
        return react.createElement('svg', {
          viewBox: '0 0 24 24', width: size, height: size,
          'aria-hidden': true, style: { display: 'block', flex: 'none' },
        },
          react.createElement('circle', { cx: 11, cy: 11, r: 7, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
          react.createElement('line', {
            x1: 16.2, y1: 16.2, x2: 21, y2: 21,
            stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
          }),
        )
      }
    }

    function SearchPanelPage(react, ui, localeRef) {
      var MarkdownText = ui && typeof ui.MarkdownText === 'function' ? ui.MarkdownText : null
      var TextShimmer = ui && typeof ui.TextShimmer === 'function' ? ui.TextShimmer : null
      var IconGlobe = ui && ui.IconGlobeOutlineRegular ? ui.IconGlobeOutlineRegular : null
      var IconWarning = ui && ui.IconWarningOutlineRegular ? ui.IconWarningOutlineRegular : null
      var IconSearch = ui && ui.IconSearchOutlineRegular ? ui.IconSearchOutlineRegular : null

      var magnifier = function (size) {
        return IconSearch
          ? react.createElement(IconSearch, { size: size })
          : react.createElement('svg', {
            viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
          },
            react.createElement('circle', { cx: 11, cy: 11, r: 7, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
            react.createElement('line', { x1: 16.2, y1: 16.2, x2: 21, y2: 21, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }))
      }

      return function SearchPanel() {
        var t = labelText(localeRef, '')

        // Hook order is flat and unconditional: the fake React in the smoke
        // test (and real React's dev-mode hook check) both reject branches
        // that appear between renders.
        var queryState = react.useState(searchPanelCache.query)
        var query = queryState[0]
        var setQuery = queryState[1]
        var engineState = react.useState(searchPanelCache.engine || '')
        var engine = engineState[0]
        var setEngine = engineState[1]
        var countState = react.useState(searchPanelCache.count || 10)
        var count = countState[0]
        var setCount = countState[1]
        var busyState = react.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var errorState = react.useState(null)
        var error = errorState[0]
        var setError = errorState[1]
        var resultState = react.useState(searchPanelCache.data)
        var result = resultState[0]
        var setResult = resultState[1]
        var historyState = react.useState(searchPanelCache.history.slice())
        var history = historyState[0]
        var setHistory = historyState[1]
        var enginesState = react.useState(null)
        var engines = enginesState[0]
        var setEngines = enginesState[1]
        var mountedRef = react.useRef(true)

        react.useEffect(function () {
          mountedRef.current = true
          var cancelled = false
          // The engine picker mirrors the LIVE engine chain; if the config
          // route is unavailable the static ENGINES list still populates it.
          fetchConfig().then(function (body) {
            if (cancelled) return
            var list = body && body.value && Array.isArray(body.value.searchEngines)
              ? body.value.searchEngines.filter(function (id) { return typeof id === 'string' && id !== '' })
              : []
            if (list.length > 0) setEngines(list)
          }).catch(function () { /* static list fallback */ })
          return function () {
            cancelled = true
            mountedRef.current = false
          }
        }, [])

        var runSearch = function (overrideQuery) {
          var q = String(typeof overrideQuery === 'string' ? overrideQuery : query || '').trim()
          if (q === '' || busy) return
          setBusy(true)
          setError(null)
          var payload = { query: q, count: count }
          if (engine !== '') payload.engine = engine
          var opts = {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }
          fetch('/dsh-network/search', opts).then(function (response) {
            return response.json().then(function (body) {
              return { ok: response.ok, status: response.status, body: body }
            })
          }).then(function (reply) {
            if (!reply.ok) {
              var detail = reply.body && reply.body.error ? reply.body.error : 'HTTP ' + reply.status
              var failure = new Error(detail)
              failure.attempts = reply.body && Array.isArray(reply.body.attempts) ? reply.body.attempts : []
              throw failure
            }
            searchPanelCache.query = q
            searchPanelCache.engine = engine
            searchPanelCache.count = count
            searchPanelCache.data = reply.body
            searchPanelCache.history = [q]
              .concat(searchPanelCache.history.filter(function (item) { return item !== q }))
              .slice(0, 8)
            if (mountedRef.current) {
              setResult(reply.body)
              setHistory(searchPanelCache.history.slice())
              setBusy(false)
            }
          }).catch(function (err) {
            if (!mountedRef.current) return
            setError({
              message: noteFrom(err, t.searchPanelFailed),
              attempts: err && Array.isArray(err.attempts) ? err.attempts : [],
            })
            setBusy(false)
          })
        }

        var engineOptions = (engines && engines.length > 0 ? engines : ENGINES)
        var items = result && Array.isArray(result.items) ? result.items : []
        var summary = result && typeof result.summary === 'string' ? result.summary.trim() : ''
        var uncertainty = result && Array.isArray(result.uncertainty) ? result.uncertainty : []
        var warnings = result && Array.isArray(result.warnings) ? result.warnings : []
        var attempts = (result && Array.isArray(result.attempts) ? result.attempts : [])
          .concat(error && Array.isArray(error.attempts) ? error.attempts : [])

        // Result cards: search-engine rhythm — title link, host + date line,
        // snippet. A missing title degrades to the bare URL.
        var resultCards = items.map(function (item, index) {
          var url = item && typeof item.url === 'string' ? item.url : ''
          if (url === '') return null
          var title = item && typeof item.title === 'string' && item.title !== '' ? item.title : url
          var date = item && typeof item.published_at === 'string' ? item.published_at : ''
          var snippet = item && typeof item.snippet === 'string' ? item.snippet : ''
          return react.createElement('div', {
            key: 'hit' + index,
            style: index === items.length - 1 ? STYLES.searchResultLast : STYLES.searchResult,
          },
            react.createElement('a', {
              href: url, target: '_blank', rel: 'noreferrer',
              style: STYLES.searchResultTitle, title: t.searchPanelOpenNew,
            }, title),
            react.createElement('div', { style: STYLES.searchResultMeta },
              react.createElement('span', { style: STYLES.searchResultHost }, hostOfUrl(url)),
              date !== '' ? react.createElement('span', null, date) : null,
            ),
            snippet !== '' ? react.createElement('div', { style: STYLES.searchResultSnippet }, snippet) : null,
          )
        })

        var statusBits = []
        if (items.length > 0) statusBits.push(String(items.length) + ' ' + t.searchPanelResultsUnit)
        if (result && result.engine) statusBits.push(ENGINE_LABELS[result.engine] || String(result.engine))
        if (result && typeof result.elapsedMs === 'number') {
          statusBits.push(t.searchPanelElapsed + ' ' + formatElapsedSeconds(result.elapsedMs) + ' ' + t.searchPanelSecond)
        }
        var statusLine = statusBits.join(' · ')
        var degraded = !!(result && result.status === 'degraded')

        var noteRows = []
        warnings.forEach(function (w, i) {
          if (typeof w !== 'string' || w === '') return
          noteRows.push(react.createElement('div', { key: 'warn' + i, style: STYLES.searchNote },
            IconWarning ? react.createElement(IconWarning, { size: 12 }) : null,
            react.createElement('span', null, t.searchPanelWarning + ': ' + w)))
        })
        uncertainty.forEach(function (u, i) {
          if (typeof u !== 'string' || u === '') return
          noteRows.push(react.createElement('div', { key: 'unc' + i, style: STYLES.searchNote },
            null,
            react.createElement('span', null, t.searchPanelUncertain + ': ' + u)))
        })

        var head = react.createElement('header', { style: STYLES.searchHead },
          react.createElement('h1', { style: STYLES.searchTitle }, t.searchPanel),
          react.createElement('p', { style: STYLES.searchIntro }, t.searchPanelSubtitle),
        )

        var form = react.createElement('form', {
          style: STYLES.searchBar,
          onSubmit: function (event) { event.preventDefault(); runSearch() },
        },
          react.createElement('input', {
            style: STYLES.searchInput,
            value: query,
            placeholder: t.searchPanelPlaceholder,
            autoFocus: true,
            onChange: function (event) { setQuery(event.target.value) },
          }),
          react.createElement('select', {
            style: STYLES.searchSelect,
            value: engine,
            title: t.searchPanelEngineAll,
            onChange: function (event) { setEngine(event.target.value) },
          },
            react.createElement('option', { value: '' }, t.searchPanelEngineAll),
            engineOptions.map(function (id) {
              return react.createElement('option', { key: id, value: id }, ENGINE_LABELS[id] || id)
            }),
          ),
          react.createElement('select', {
            style: STYLES.searchSelect,
            value: String(count),
            title: t.searchPanelCountLabel,
            onChange: function (event) { setCount(Number(event.target.value) || 10) },
          },
            [5, 10, 15, 20].map(function (n) {
              return react.createElement('option', { key: n, value: String(n) }, String(n))
            }),
          ),
          react.createElement('button', {
            type: 'submit',
            style: busy
              ? Object.assign({}, STYLES.searchRunBtn, STYLES.searchRunBtnDisabled)
              : STYLES.searchRunBtn,
            disabled: busy,
          },
            magnifier(14),
            t.searchPanelGo,
          ),
        )

        var recentRow = history.length > 0
          ? react.createElement('div', { style: STYLES.searchRecent },
            react.createElement('span', { style: STYLES.searchRecentLabel }, t.searchPanelRecent),
            history.map(function (q, i) {
              return react.createElement('button', {
                key: 'recent' + i, type: 'button', title: q,
                style: STYLES.searchRecentChip,
                onClick: function () { runSearch(q) },
              }, q)
            }))
          : null

        var runningRow = busy
          ? react.createElement('div', { style: STYLES.searchRunning, 'aria-live': 'polite' },
            TextShimmer
              ? react.createElement(TextShimmer, { active: true }, t.searchToolRunning)
              : t.searchToolRunning)
          : null

        var errorCard = error
          ? react.createElement('div', { style: STYLES.searchError, role: 'alert' },
            react.createElement('div', { style: STYLES.searchErrorTitle }, t.searchPanelFailed),
            react.createElement('pre', { style: STYLES.searchErrorDetail }, error.message))
          : null

        var emptyHint = !busy && !error && !result
          ? react.createElement('div', { style: STYLES.searchEmpty }, t.searchPanelEmptyHint)
          : null

        var summaryCard = summary === ''
          ? null
          : react.createElement('div', { style: STYLES.searchSummary },
            react.createElement('span', { style: STYLES.searchSummaryLabel },
              IconGlobe ? react.createElement(IconGlobe, { size: 12 }) : null,
              t.searchPanelSummary),
            MarkdownText
              ? react.createElement(MarkdownText, { text: summary })
              : react.createElement('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' } }, summary))

        var attemptsBlock = attempts.length > 0
          ? react.createElement('details', { style: STYLES.searchAttempts },
            react.createElement('summary', null, t.searchPanelAttempts + ' (' + attempts.length + ')'),
            react.createElement('pre', { style: STYLES.searchAttemptsPre },
              attempts.map(function (a) {
                return ((a && a.engine) || 'engine') + ': ' + ((a && a.error) || 'ok')
              }).join('\n')))
          : null

        var resultArea = result
          ? [
            react.createElement('div', { key: 'status', style: STYLES.searchStatus },
              statusLine !== '' ? react.createElement('span', null, statusLine) : null,
              degraded || warnings.length > 0
                ? react.createElement('span', {
                  style: Object.assign({}, STYLES.fieldBadgeMuted),
                  'data-tone': 'warn',
                }, t.searchPanelStatusDegraded)
                : null,
            ),
            summaryCard ? react.createElement('div', { key: 'summary' }, summaryCard) : null,
            resultCards.length > 0
              ? react.createElement('div', { key: 'hits', style: STYLES.searchResultsList }, resultCards)
              : react.createElement('div', { key: 'nohits', style: STYLES.searchEmpty }, t.searchToolNoResults),
            noteRows.length > 0 ? react.createElement('div', { key: 'notes' }, noteRows) : null,
            attemptsBlock ? react.createElement('div', { key: 'attempts' }, attemptsBlock) : null,
          ]
          : null

        var pageChild = function (style) { return Object.assign({}, STYLES.searchChild, style) }

        return react.createElement('section', { style: STYLES.searchPage, 'aria-busy': busy },
          head,
          react.createElement('div', { style: pageChild(null) }, form, recentRow),
          runningRow ? react.createElement('div', { style: pageChild(null) }, runningRow) : null,
          errorCard ? react.createElement('div', { style: pageChild(null) }, errorCard) : null,
          emptyHint ? react.createElement('div', { style: pageChild(null) }, emptyHint) : null,
          resultArea ? react.createElement('div', { style: pageChild({ display: 'flex', flexDirection: 'column', gap: '16px' }) }, resultArea) : null,
        )
      }
    }

    return {
      SEARCH_PANEL_ID,
      SearchPanelIcon,
      SearchPanelPage,
    }

  },
})
