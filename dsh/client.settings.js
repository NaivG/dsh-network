/* dsh-web browser half for dsh-network — "网络" settings surfaces
 * (package-local chunk, materialized via require.async from dsh/client.js).
 *
 * The dedicated settings section (settings.section, nav "网络") and the
 * legacy Plugins-tab card share every renderer here so the two surfaces
 * stay in sync: general-settings tool rows, the compact engine list with
 * its edit / add dialogs, and the collapsible Request / Safety / Limits /
 * Test cards. Auto-save PUTs the draft through the host loopback route.
 *
 * Chunk protocol: this file sits next to dsh/client.js and matches the
 * loader's `client.<name>.js` chunk naming, so the dsh host serves it on
 * demand at /plugins/dsh-network/client.settings.js?rev=… The factory
 * requires the entry ('dsh-network') for the shared surface (i18n labels,
 * config API helpers, STYLES) and must stay SELF-CONTAINED otherwise —
 * chunks cannot synchronously require each other.
 */

window.__ModuleLoader__.load({
  id: 'dsh-network',
  chunk: 'client.settings.js',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    // Shared surface from the entry module (dsh/client.js). The entry is
    // always materialized before a chunk runs — its apply() is what
    // requests this chunk — so this lookup can never miss.
    var shared = require('dsh-network')
    var labelText = shared.labelText
    var noteFrom = shared.noteFrom
    var fetchConfig = shared.fetchConfig
    var putConfig = shared.putConfig
    var fetchHealth = shared.fetchHealth
    var STYLES = shared.STYLES
    // The engine vocabulary lives in the entry; a chunk has NO access to the
    // entry's file scope, so every one of them must be re-bound here by name.
    // `ENGINE_LABELS` was read raw (the pre-split file-scope binding) and blew
    // up the whole section with `ReferenceError: ENGINE_LABELS is not defined`
    // — a free variable in a chunk is not a compile error, only a render-time
    // crash. tests/client-chunks.spec.ts pins this class of defect.
    var ENGINE_LABELS = shared.ENGINE_LABELS

    var ENGINE_DEFAULT_ENDPOINTS = {
      bing: 'https://www.bing.com/search',
      duckduckgo: 'https://html.duckduckgo.com/html',
      baidu: 'https://www.baidu.com/s',
      github: 'https://api.github.com/search',
      brave: 'https://api.search.brave.com/res/v1/web/search',
      // SearXNG is deliberately NOT here: it is self-hosted, so its
      // endpoint must stay editable in the engine dialog (built-in engines
      // with a fixed endpoint get a locked input). The loopback default
      // lives in the host's defaultConfig seed.
    }
    var ENGINE_HAS_API_KEY = { bing: false, duckduckgo: false, baidu: false, github: false, searxng: false, brave: true }
    // GitHub engine: token / indexes / sort live inside the engine edit
    // dialog (config.githubToken / githubIndexes / githubSort), committed
    // through githubSettingsPatch() on save. Brave's key rides the generic
    // `searchEngineConfigs[id].apiKey` path (see the needsKey block below).
    var GITHUB_INDEX_LABELS = { repositories: 'Repositories', code: 'Code', issues: 'Issues', users: 'Users' }
    var GITHUB_SORTS = ['best', 'stars', 'updated']
    /** Per-engine one-line description shown inside the edit dialog. */
    var ENGINE_HINTS = { bing: 'engineHintBing', duckduckgo: 'engineHintDuckduckgo', baidu: 'engineHintBaidu', github: 'githubHint', searxng: 'searxngHint', brave: 'braveHint' }

    /** Build the github settings patch from a draft. The token is
     *  write-only: a non-empty typed value stores the key, the magic
     *  '__CLEAR__' value clears it, and anything else is left untouched
     *  on the host. */
    function githubSettingsPatch(next) {
      var patch = {}
      if (typeof next._githubTokenDraft === 'string') {
        if (next._githubTokenDraft.trim() !== '') patch.githubToken = next._githubTokenDraft
        else if (next._githubTokenDraft === '__CLEAR__') patch.githubToken = ''
      }
      if (Array.isArray(next.githubIndexes)) patch.githubIndexes = next.githubIndexes
      if (GITHUB_SORTS.indexOf(next.githubSort) >= 0) patch.githubSort = next.githubSort
      return patch
    }

    /** draft → draft with every engine `apiKey` field dropped.
     *
     *  Engine keys are write-only: they ride the save payload once and the
     *  host owns them from then on (`summarize()` only ever answers
     *  `hasApiKey`). Keeping the plaintext in the draft would re-ship the
     *  secret on EVERY later debounced save and leave it sitting in the
     *  page's state for the rest of the session. Returns the input
     *  untouched when there is nothing to strip, so React bails out of the
     *  re-render. */
    function stripApiKeys(prev) {
      var configs = prev && prev.searchEngineConfigs
      if (!configs || typeof configs !== 'object') return prev
      var changed = false
      var next = {}
      Object.keys(configs).forEach(function (id) {
        var entry = configs[id]
        if (!entry || typeof entry !== 'object' || typeof entry.apiKey !== 'string') {
          next[id] = entry
          return
        }
        var copy = Object.assign({}, entry)
        delete copy.apiKey
        next[id] = copy
        changed = true
      })
      return changed ? Object.assign({}, prev, { searchEngineConfigs: next }) : prev
    }

    // ───────────────── shared primitives ─────────────────
    /** Pill toggle, mirror of dsh's settings-general row switch. */
    function ToggleSwitch(react, checked, onChange, ariaLabel) {
      var h = react.createElement
      return h('label', {
        style: { position: 'relative', display: 'inline-block', width: '40px', height: '22px', flex: 'none', cursor: 'pointer' },
      },
        h('input', {
          type: 'checkbox', checked: !!checked, 'aria-label': ariaLabel,
          onChange: function (e) { onChange(!!e.target.checked) },
          style: { position: 'absolute', opacity: 0, width: 0, height: 0, margin: 0 },
        }),
        h('span', {
          style: {
            position: 'absolute', inset: 0,
            background: checked ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
            borderRadius: '999px', transition: 'background .16s',
          },
        },
          h('span', {
            style: {
              position: 'absolute', height: '16px', width: '16px',
              left: '3px', bottom: '3px',
              background: 'white', borderRadius: '50%', transition: 'transform .16s',
              transform: checked ? 'translateX(18px)' : 'none',
            },
          })
        )
      )
    }

    function IconEdit(react) {
      return react.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        react.createElement('path', { d: 'M11.5 1.5l3 3-9 9H2.5v-3l9-9z' }))
    }
    function IconTrash(react) {
      return react.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' },
        react.createElement('path', { d: 'M4 4l8 8M12 4l-8 8' }))
    }
    function IconChevron(react, open) {
      return react.createElement('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16',
        style: Object.assign({}, STYLES.cardChevron, open ? STYLES.cardChevronOpen : null),
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        react.createElement('path', { d: 'M4 6l4 4 4-4' }))
    }
    function IconPlus(react) {
      return react.createElement('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
        react.createElement('path', { d: 'M8 3v10M3 8h10' }))
    }

    /** Field row inside a plugin-card body. Label / optional badge /
     *  control / hint. */
    function FieldRow(react, opts) {
      var h = react.createElement
      var headChildren = [
        h('label', { htmlFor: opts.id, style: STYLES.fieldLabel }, opts.label),
      ]
      if (opts.badge) {
        var badgeStyle = opts.badgeMuted ? STYLES.fieldBadgeMuted : STYLES.fieldBadge
        headChildren.push(h('span', { style: badgeStyle }, opts.badge))
      }
      var fieldChildren = [
        h('div', { style: STYLES.fieldHead }, headChildren),
        opts.control,
      ]
      if (opts.hint) fieldChildren.push(h('p', { style: STYLES.fieldHint }, opts.hint))
      // Spread fieldChildren — passing the array as a single child would
      // bury it inside the parent's `children` slot and the test's
      // recursive `findNode` (which skips arrays) would never reach it.
      return h('div', { style: STYLES.field }, ...fieldChildren)
    }

    /** Standard 34px input matching the plugin-config card's field style. */
    function TextInput(react, opts) {
      return react.createElement('input', {
        id: opts.id,
        type: opts.type || 'text',
        value: opts.value == null ? '' : String(opts.value),
        placeholder: opts.placeholder || '',
        onChange: function (e) { opts.onChange(e.target.value) },
        style: STYLES.fieldInput,
      })
    }
    function NumberInput(react, opts) {
      return react.createElement('input', {
        id: opts.id,
        type: 'number',
        min: opts.min == null ? undefined : opts.min,
        value: opts.value == null ? '' : String(opts.value),
        onChange: function (e) { opts.onChange(e.target.value === '' ? '' : Number(e.target.value)) },
        style: STYLES.fieldInput,
      })
    }

    // ───────────────── section: tools (general-settings rows) ─────────────────
    function ToolsSection(react, t, draft, setKey) {
      var h = react.createElement
      var rows = [
        { key: 'webSearchTool', title: t.toolWebSearch, desc: t.toolWebSearchDesc },
        { key: 'webFetchTool', title: t.toolWebFetch, desc: t.toolWebFetchDesc },
        { key: 'httpRequestTool', title: t.toolHttpRequest, desc: t.toolHttpRequestDesc },
        { key: 'webSitemapTool', title: t.toolWebSitemap, desc: t.toolWebSitemapDesc },
        // Last on purpose: it is the only row that is OFF by default, and
        // the one whose description says so. Putting it after the four
        // read-only tools keeps the default-on cluster visually together.
        { key: 'downloadTool', title: t.toolWebDownload, desc: t.toolWebDownloadDesc },
      ]
      // draft may be null on the first paint (the route fetch is still
      // pending); guard every row access so the section renders an
      // unfilled, non-interactive shell instead of crashing.
      var safeDraft = draft || {}
      return h(react.Fragment, null,
        h('div', { key: 'tools-h', style: STYLES.sectionHeader }, t.sectionTools),
        h('div', { key: 'tools-body' },
          rows.map(function (row, i) {
            return h('div', {
              key: row.key,
              style: Object.assign({}, STYLES.genRow, i === rows.length - 1 ? STYLES.genRowLast : null),
            },
              h('div', { style: STYLES.genRowText },
                h('div', { style: STYLES.genRowTitle }, row.title),
                h('div', { style: STYLES.genRowDesc }, row.desc),
              ),
              ToggleSwitch(react, !!safeDraft[row.key], function (v) { setKey(row.key, v) }, row.title),
            )
          })
        ),
      )
    }

    // ───────────────── section: engines (compact category rows) ─────────────────
    function EnginesSection(react, t, draft, summary, setKey, setKeys, dialogState, addDialogState) {
      var h = react.createElement
      // draft may be null on the first paint; guard so the section renders
      // an empty list instead of crashing.
      var safeDraft = draft || {}
      var engines = Array.isArray(safeDraft.searchEngines) ? safeDraft.searchEngines.filter(function (n) { return typeof n === 'string' && n !== '' }) : []
      var configs = safeDraft.searchEngineConfigs && typeof safeDraft.searchEngineConfigs === 'object' ? safeDraft.searchEngineConfigs : {}
      var availableCategories = Object.keys(ENGINE_LABELS).filter(function (id) { return engines.indexOf(id) === -1 })
      // `/dsh-network/config` answers `{ value, revision }` and the
      // `summarize()` view inside `value` is where `hasGithubToken` lives —
      // reading the wrapper's own field always yielded `undefined`, so the
      // GitHub row claimed "Token 未配置" no matter what the host held. Accept
      // the flattened view too (the exported RenderNetworkPage is called with
      // either shape).
      var safeSummary = summary || {}
      var hasGithubToken = safeSummary.hasGithubToken === true
        || !!(safeSummary.value && safeSummary.value.hasGithubToken === true)

      // dialog state + handlers — same shape as before; pulled into the
      // component because the engine list owns the dialog.
      var dlg = dialogState[0], setDlg = dialogState[1]
      var addDlg = addDialogState[0], setAddDlg = addDialogState[1]

      function openEngineDialog(id) {
        var cfg = configs[id] || {}
        var next = {
          id: id,
          endpoint: (cfg.endpoint || ENGINE_DEFAULT_ENDPOINTS[id] || ''),
          hasApiKey: !!cfg.hasApiKey,
          options: cfg.options && typeof cfg.options === 'object' ? cfg.options : {},
        }
        if (id === 'github') {
          next.githubTokenDraft = ''
          next.githubIndexes = Array.isArray(safeDraft.githubIndexes) ? safeDraft.githubIndexes.slice() : []
          next.githubSort = GITHUB_SORTS.indexOf(safeDraft.githubSort) >= 0 ? safeDraft.githubSort : 'best'
        }
        setDlg(next)
      }
      function closeEngineDialog() { setDlg(null) }
      function commitEngineDialog() {
        if (!dlg) return
        var id = dlg.id
        var nextConfigs = Object.assign({}, configs)
        var entry = {
          endpoint: dlg.endpoint,
          hasApiKey: dlg.hasApiKey,
          options: dlg.options,
        }
        // THE credential hop. The host stores `searchEngineConfigs[id].apiKey`
        // into `config.searchEngineApiKeys[id]` (dsh/config-summary.js) and
        // configToEnv() ships THAT map to the CLI as
        // DSH_NETWORK_SEARCH_ENGINE_API_KEYS — nothing else ever reaches it.
        // Committing only `hasApiKey` therefore configured the status dot and
        // left every keyed engine (Brave) permanently unauthenticated: the
        // flag said "key present", the CLI read an empty map. Ship the typed
        // value here; an empty/untouched field is omitted on purpose so the
        // host keeps whatever it already stored (the input is write-only, so
        // reopening the dialog never shows the stored key back).
        if (typeof dlg.apiKey === 'string' && dlg.apiKey.trim() !== '') {
          entry.apiKey = dlg.apiKey
        }
        nextConfigs[id] = entry
        var patch = { searchEngineConfigs: nextConfigs }
        if (id === 'github') {
          if (Array.isArray(dlg.githubIndexes)) patch.githubIndexes = dlg.githubIndexes
          if (GITHUB_SORTS.indexOf(dlg.githubSort) >= 0) patch.githubSort = dlg.githubSort
          if (typeof dlg.githubTokenDraft === 'string') {
            if (dlg.githubTokenDraft.trim() !== '') patch._githubTokenDraft = dlg.githubTokenDraft
            else if (dlg.githubTokenDraft === '__CLEAR__') patch._githubTokenDraft = '__CLEAR__'
          }
        }
        // Multi-key commit: one draft update so the debounced save sees the
        // whole patch (a burst of setKey calls would only flush the last).
        setKeys(patch)
        closeEngineDialog()
      }

      function openAddDialog() {
        if (!availableCategories.length) return
        setAddDlg({ id: '' })
      }
      function closeAddDialog() { setAddDlg(null) }
      function commitAddDialog() {
        if (!addDlg) return
        var id = addDlg.id
        if (!Object.prototype.hasOwnProperty.call(ENGINE_LABELS, id)) return
        if (engines.indexOf(id) >= 0) return
        setKey('searchEngines', engines.concat([id]))
        closeAddDialog()
      }

      var rows = engines.map(function (id, index) {
        var cfg = configs[id] || {}
        var needsKey = !!ENGINE_HAS_API_KEY[id]
        var hasKey = !!cfg.hasApiKey
        var canDelete = engines.length > 1

        return h('div', {
          key: id,
          style: Object.assign({}, STYLES.engineRow, index === engines.length - 1 ? STYLES.engineRowLast : null),
        },
          h('span', { style: STYLES.engineCategoryText }, id),
          id === 'github'
            ? h('span', { style: STYLES.engineTokenBadge(hasGithubToken ? 'ok' : 'error') },
              hasGithubToken ? t.githubTokenRowOn : t.githubTokenRowOff)
            : null,
          needsKey
            ? h('span', { style: STYLES.engineTokenBadge(hasKey ? 'ok' : 'error') },
              hasKey ? t.enginesApiKeyConfigured : t.enginesApiKeyMissing)
            : null,
          h('div', { style: Object.assign({}, STYLES.engineActions, { marginLeft: 'auto' }) },
            h('button', {
              type: 'button', title: t.enginesEdit, 'aria-label': t.enginesEdit + ': ' + id,
              onClick: function () { openEngineDialog(id) },
              style: STYLES.iconBtn,
              onMouseEnter: function (e) { Object.assign(e.currentTarget.style, STYLES.iconBtnHover) },
              onMouseLeave: function (e) { Object.assign(e.currentTarget.style, STYLES.iconBtn) },
            }, IconEdit(react)),
            h('button', {
              type: 'button', title: t.enginesDelete, 'aria-label': t.enginesDelete + ': ' + id,
              disabled: !canDelete,
              onClick: function () {
                if (!canDelete) return
                var next = engines.slice(); next.splice(index, 1)
                setKey('searchEngines', next)
              },
              style: Object.assign({}, STYLES.iconBtn, STYLES.iconBtnDanger, !canDelete ? STYLES.iconBtnDisabled : null),
              onMouseEnter: function (e) {
                if (!canDelete) return
                Object.assign(e.currentTarget.style, STYLES.iconBtnHover, STYLES.iconBtnDanger)
              },
              onMouseLeave: function (e) {
                Object.assign(e.currentTarget.style, STYLES.iconBtn,
                  !canDelete ? STYLES.iconBtnDisabled : STYLES.iconBtnDanger)
              },
            }, IconTrash(react)),
          ),
        )
      })

      var dlgBody = dlg ? h(EngineDialog, {
        key: 'dlg', react: react, t: t, value: dlg,
        hasGithubToken: hasGithubToken,
        onChange: setDlg,
        onCancel: closeEngineDialog,
        onSave: commitEngineDialog,
      }) : null

      var addDlgBody = addDlg ? h(AddEngineDialog, {
        key: 'add-dlg', react: react, t: t,
        value: addDlg, categories: availableCategories,
        onChange: setAddDlg,
        onCancel: closeAddDialog,
        onAdd: commitAddDialog,
      }) : null

      return h(react.Fragment, null,
        h('div', { key: 'engines-h', style: STYLES.sectionHeader }, t.sectionEngines),
        h('div', { key: 'engines-list', style: STYLES.engineList },
          ...rows,
          h('div', { style: STYLES.addRow },
            availableCategories.length
              ? h('button', {
                type: 'button',
                onClick: openAddDialog,
                style: STYLES.primaryBtn,
              },
                IconPlus(react),
                h('span', null, t.enginesAdd),
              )
              : h('span', { style: STYLES.fieldHint }, t.enginesEmpty),
          ),
        ),
        dlgBody,
        addDlgBody,
      )
    }

    // ───────────────── fields: request (inside plugin card) ─────────────────
    function RequestFields(react, t, draft, setKey) {
      var h = react.createElement
      return h(react.Fragment, null,
        FieldRow(react, {
          id: 'f-userAgent', label: t.userAgent,
          control: TextInput(react, {
            id: 'f-userAgent', value: draft.userAgent, placeholder: '',
            onChange: function (v) { setKey('userAgent', v) },
          }),
        }),
        FieldRow(react, {
          id: 'f-fetchTimeoutMs', label: t.fetchTimeout,
          control: NumberInput(react, {
            id: 'f-fetchTimeoutMs', value: draft.fetchTimeoutMs, min: 1,
            onChange: function (v) { setKey('fetchTimeoutMs', v) },
          }),
        }),
        FieldRow(react, {
          id: 'f-searchTimeoutMs', label: t.searchTimeout,
          control: NumberInput(react, {
            id: 'f-searchTimeoutMs', value: draft.searchTimeoutMs, min: 1,
            onChange: function (v) { setKey('searchTimeoutMs', v) },
          }),
        }),
        FieldRow(react, {
          id: 'f-httpTimeoutMs', label: t.httpTimeout,
          control: NumberInput(react, {
            id: 'f-httpTimeoutMs', value: draft.httpTimeoutMs, min: 1,
            onChange: function (v) { setKey('httpTimeoutMs', v) },
          }),
        }),
      )
    }

    // ───────────────── fields: safety (inside plugin card) ─────────────────
    function SafetyFields(react, t, draft, setKey) {
      var h = react.createElement
      var allowlist = Array.isArray(draft.allowlist) ? draft.allowlist : []

      var allowlistField = h('div', { style: STYLES.field, key: 'allowlist-field' },
        h('div', { style: STYLES.fieldHead },
          h('label', { htmlFor: 'f-allowlist', style: STYLES.fieldLabel }, t.allowlist),
        ),
        h('div', {
          style: {
            display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center',
            padding: '8px 10px', minHeight: '38px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: '8px',
          },
        },
          allowlist.map(function (host, i) {
            return h('span', {
              key: i,
              style: {
                display: 'inline-flex', alignItems: 'center', gap: '4px',
                padding: '3px 8px', borderRadius: '999px',
                background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
                border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))',
                fontSize: '12px',
              },
            },
              h('span', null, host),
              h('button', {
                type: 'button',
                'aria-label': 'remove ' + host,
                onClick: function () {
                  var next = allowlist.slice(); next.splice(i, 1)
                  setKey('allowlist', next)
                },
                style: { appearance: 'none', border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', display: 'flex', alignItems: 'center', padding: '0' },
              },
                h('svg', { width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
                  h('path', { d: 'M4 4l8 8M12 4l-8 8' })
                ),
              ),
            )
          }),
          h('input', {
            key: 'allowlist-input',
            placeholder: t.allowlistPlaceholder,
            onKeyDown: function (e) {
              if (e.key !== 'Enter') return
              e.preventDefault()
              var v = e.currentTarget.value.trim()
              if (!v || allowlist.indexOf(v) >= 0) return
              setKey('allowlist', allowlist.concat([v]))
              e.currentTarget.value = ''
            },
            style: { flex: '1 1 120px', minWidth: '120px', border: 'none', background: 'transparent', outline: 'none', font: 'inherit', fontSize: '13px', color: 'inherit' },
          }),
        ),
        h('p', { style: STYLES.fieldHint }, t.allowlistHint),
      )

      function protectionRow(key, label, hint) {
        return FieldRow(react, {
          id: 'f-' + key, label: label, hint: hint,
          badge: draft[key] ? t.protectionOn : t.protectionOff,
          badgeMuted: !draft[key],
          control: ToggleSwitch(react, !!draft[key], function (v) { setKey(key, v) }, label),
        })
      }

      // The "allow model to modify settings" toggle is not a network
      // protection — it doesn't filter traffic — but it lives in the
      // safety section because flipping it gives the model a write
      // path into the same configuration surface, which is exactly
      // what the rest of this card governs. Render it last with the
      // same pill-on / pill-off affordance as the protections.
      var allowConfigEditRow = FieldRow(react, {
        id: 'f-allowConfigEdit',
        label: t.allowConfigEdit,
        hint: t.allowConfigEditHint,
        badge: draft.allowConfigEdit ? t.protectionOn : t.protectionOff,
        badgeMuted: !draft.allowConfigEdit,
        control: ToggleSwitch(react, !!draft.allowConfigEdit, function (v) { setKey('allowConfigEdit', v) }, t.allowConfigEdit),
      })

      return h(react.Fragment, null,
        allowlistField,
        protectionRow('ssrfProtection', t.ssrfProtection, t.ssrfProtectionHint),
        protectionRow('redirectProtection', t.redirectProtection, t.redirectProtectionHint),
        protectionRow('protocolLock', t.protocolLock, t.protocolLockHint),
        allowConfigEditRow,
      )
    }

    // ───────────────── fields: limits (inside plugin card) ─────────────────
    function LimitsFields(react, t, draft, setKey) {
      var h = react.createElement
      return h(react.Fragment, null,
        FieldRow(react, {
          id: 'f-searchMaxResults', label: t.maxResults,
          control: NumberInput(react, {
            id: 'f-searchMaxResults', value: draft.searchMaxResults, min: 1,
            onChange: function (v) { setKey('searchMaxResults', v) },
          }),
        }),
        FieldRow(react, {
          id: 'f-maxRedirects', label: t.maxRedirects,
          control: NumberInput(react, {
            id: 'f-maxRedirects', value: draft.maxRedirects, min: 0,
            onChange: function (v) { setKey('maxRedirects', v) },
          }),
        }),
        FieldRow(react, {
          id: 'f-maxBodyChars', label: t.maxBodyChars,
          control: NumberInput(react, {
            id: 'f-maxBodyChars', value: draft.maxBodyChars, min: 1,
            onChange: function (v) { setKey('maxBodyChars', v) },
          }),
        }),
      )
    }

    // ───────────────── fields: test (inside plugin card) ─────────────────
    function TestFields(react, t, test, runLoopbackTest) {
      var h = react.createElement
      var badge = test.status === 'ok' ? t.testLoopbackOk
        : test.status === 'error' ? t.testLoopbackFail
        : test.status === 'running' ? t.testLoopbackRunning
        : t.testLoopbackIdle
      var badgeMuted = test.status === 'idle'

      var runButton = h('button', {
        type: 'button',
        disabled: test.status === 'running',
        onClick: runLoopbackTest,
        style: Object.assign({}, STYLES.primaryBtn, test.status === 'running' ? STYLES.iconBtnDisabled : null),
      }, t.testLoopback)

      return h(react.Fragment, null,
        FieldRow(react, {
          id: 'f-testLoopback', label: t.testLoopback, hint: t.testLoopbackDesc,
          badge: test.message || badge,
          badgeMuted: badgeMuted && !test.message,
          control: runButton,
        }),
      )
    }

    // ───────────────── plugin-config card (collapsible) ─────────────────
    // Plain function (no hooks): the parent owns the open/close state so
    // flipping a card cannot change the hook count, which would crash a
    // React fiber mid-render. `opts.open` / `opts.onToggle` come from the
    // parent; if the parent doesn't supply them, the card stays open
    // (the dedicated settings page always opens every card by default).
    function CollapsibleCard(react, opts) {
      var h = react.createElement
      var open = opts.open !== false
      var onToggle = opts.onToggle
      var style = Object.assign({}, STYLES.card, open ? STYLES.cardOpen : null)
      return h('div', { style: style },
        h('button', {
          type: 'button',
          'aria-expanded': open,
          'aria-label': (open ? 'collapse: ' : 'expand: ') + opts.name,
          onClick: onToggle ? function () { onToggle() } : undefined,
          style: STYLES.cardHeader,
        },
          h('div', { style: STYLES.cardHeadText },
            h('div', { style: STYLES.cardName }, opts.name),
            opts.description ? h('div', { style: STYLES.cardDesc }, opts.description) : null,
          ),
          IconChevron(react, open),
        ),
        open ? h('div', { style: STYLES.cardBody }, opts.children) : null,
      )
    }

    // ───────────────── engine edit dialog (inline overlay) ─────────────────
    // Fixed-position overlay rather than `ui.Modal`: the primitive is only
    // injected into a subset of slots, and an inline dialog keeps this
    // surface self-contained.
    function EngineDialog(props) {
      var react = props.react, t = props.t, value = props.value
      var onChange = props.onChange, onCancel = props.onCancel, onSave = props.onSave
      var hasGithubToken = props.hasGithubToken === true
      var h = react.createElement
      var id = value.id
      var isBuiltin = Object.prototype.hasOwnProperty.call(ENGINE_DEFAULT_ENDPOINTS, id)
      var isGithub = id === 'github'
      var hintKey = ENGINE_HINTS[id]
      var needsKey = !!ENGINE_HAS_API_KEY[id]
      var setField = function (key, v) { onChange(Object.assign({}, value, { [key]: v })) }
      var optsText = Object.keys(value.options || {}).map(function (k) { return k + '=' + (value.options[k] || '') }).join('\n')
      var setOptionsText = function (text) {
        var next = {}
        String(text).split(/\r?\n/).forEach(function (line) {
          var idx = line.indexOf('=')
          if (idx <= 0) return
          var k = line.slice(0, idx).trim()
          var v = line.slice(idx + 1).trim()
          if (k) next[k] = v
        })
        onChange(Object.assign({}, value, { options: next }))
      }
      var inputStyle = {
        width: '95%', padding: '5px 10px 5px 10px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        borderRadius: '8px', background: 'transparent', color: 'inherit',
        font: 'inherit', fontSize: '13px', outline: 'none',
      }
      var labelSmall = {
        fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, inherit)',
      }
      var hintSmall = {
        fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
      }
      var btnBase = {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))', color: 'inherit',
        padding: '5px 10px', borderRadius: '8px', font: 'inherit', fontSize: '12px',
        fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px',
      }
      var chipBtn = function (on) {
        return {
          ...btnBase,
          background: on ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
          borderColor: on ? 'transparent' : 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          color: on ? 'white' : 'inherit',
        }
      }
      var ghTokenDraft = value.githubTokenDraft === '__CLEAR__' ? '' : (value.githubTokenDraft || '')
      var ghTokenActive = ghTokenDraft.trim() !== '' || (hasGithubToken && value.githubTokenDraft !== '__CLEAR__')
      var ghIndexes = Array.isArray(value.githubIndexes) ? value.githubIndexes : []
      var ghSort = GITHUB_SORTS.indexOf(value.githubSort) >= 0 ? value.githubSort : 'best'
      var githubBlock = isGithub ? h('div', {
        key: 'github-block',
        style: {
          display: 'flex', flexDirection: 'column', gap: '12px',
          padding: '12px', borderRadius: '8px',
          border: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.04))',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { width: '3px', height: '12px', borderRadius: '2px', background: '#24292f', flex: 'none' } }),
          h('span', { style: { fontSize: '12px', fontWeight: 700 } }, t.githubGroupTitle),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { style: labelSmall }, t.githubToken),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('input', {
              key: 'github-token', type: 'password',
              value: ghTokenDraft,
              placeholder: (hasGithubToken ? t.githubTokenConfigured : t.githubTokenEmpty) + ' — ' + t.githubTokenPlaceholder,
              autoComplete: 'off', spellCheck: false,
              onChange: function (e) { setField('githubTokenDraft', e.target.value) },
              style: { ...inputStyle, fontFamily: 'var(--dsw-alias-mono, monospace)' },
            }),
            h('button', {
              type: 'button',
              title: t.githubTokenClear,
              onClick: function () { setField('githubTokenDraft', '__CLEAR__') },
              style: {
                ...btnBase, flex: 'none',
                color: hasGithubToken ? 'var(--dsw-alias-state-error-primary, #dc2626)' : 'inherit',
              },
            }, t.githubTokenClear),
          ),
          h('span', { style: hintSmall }, ghTokenActive ? t.githubTokenConfigured : t.githubTokenEmpty),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { style: labelSmall }, t.githubIndexes),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
            ...Object.keys(GITHUB_INDEX_LABELS).map(function (idx) {
              var on = ghIndexes.indexOf(idx) >= 0
              return h('button', {
                key: idx, type: 'button',
                onClick: function () {
                  setField('githubIndexes', on ? ghIndexes.filter(function (x) { return x !== idx }) : ghIndexes.concat([idx]))
                },
                style: chipBtn(on),
              }, GITHUB_INDEX_LABELS[idx])
            }),
          ),
          h('span', { style: hintSmall }, t.githubIndexesHint),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { style: labelSmall }, t.githubSort),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            ...GITHUB_SORTS.map(function (s) {
              var active = ghSort === s
              return h('button', {
                key: s, type: 'button',
                onClick: function () { setField('githubSort', s) },
                style: chipBtn(active),
              }, s === 'best' ? t.githubSortBest : s === 'stars' ? t.githubSortStars : t.githubSortUpdated)
            }),
          ),
        ),
      ) : null

      return h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': t.enginesEdit,
        onClick: function (e) { if (e.target === e.currentTarget) onCancel() },
        style: {
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '16px',
        },
      },
        h('div', {
          style: {
            background: 'var(--dsw-alias-bg-page, white)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: '10px',
            boxShadow: '0 16px 48px rgba(0,0,0,0.22)',
            width: 'min(520px, 100%)',
            maxHeight: 'calc(100vh - 32px)',
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          },
        },
          h('div', {
            style: {
              padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            },
          },
            h('h3', { style: { margin: 0, fontSize: '15px', fontWeight: 700 } }, t.enginesEdit),
            h('button', {
              type: 'button', onClick: onCancel,
              style: { appearance: 'none', border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '13px' },
            }, t.enginesEditClose),
          ),
          h('div', {
            style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' },
          },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('span', { style: labelSmall }, t.enginesCategory),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('input', {
                  value: ENGINE_LABELS[id] || id,
                  readOnly: true,
                  style: { ...inputStyle, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' },
                }),
                h('span', {
                  style: {
                    fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.4px', padding: '2px 6px', borderRadius: '4px', flex: 'none',
                    background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
                    border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))',
                    color: 'var(--dsw-alias-label-secondary, inherit)',
                  },
                }, id),
              ),
              hintKey ? h('span', { style: hintSmall }, t[hintKey]) : null,
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('span', { style: labelSmall }, t.enginesEditEndpoint),
              isBuiltin
                ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                    h('input', {
                      value: value.endpoint || ENGINE_DEFAULT_ENDPOINTS[id] || '',
                      readOnly: true, tabIndex: -1, spellCheck: false,
                      style: { ...inputStyle, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', fontFamily: 'var(--dsw-alias-mono, monospace)' },
                    }),
                    h('span', { title: t.enginesEndpointLocked, style: { flex: 'none', display: 'inline-flex' } },
                      h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 },
                        h('rect', { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }),
                        h('path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' }),
                      ),
                    ),
                  )
                : h('input', { value: value.endpoint, onChange: function (e) { setField('endpoint', e.target.value) }, style: inputStyle }),
              isBuiltin ? h('span', { style: hintSmall }, t.enginesEndpointLocked) : null,
            ),
            needsKey ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('span', { style: labelSmall }, t.enginesEditApiKey),
              h('input', {
                type: 'password', placeholder: t.enginesApiKeyWriteOnly,
                value: value.apiKey || '',
                onChange: function (e) {
                  var v = e.target.value
                  onChange(Object.assign({}, value, {
                    apiKey: v,
                    hasApiKey: value.hasApiKey || v.trim() !== '',
                  }))
                },
                style: inputStyle,
              }),
              h('span', { style: hintSmall },
                value.hasApiKey ? t.enginesApiKeyConfigured : t.enginesApiKeyMissing,
              ),
            ) : null,
            githubBlock,
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('span', { style: labelSmall }, t.enginesEditOptions),
              h('textarea', {
                rows: 3, value: optsText, onChange: function (e) { setOptionsText(e.target.value) },
                style: { ...inputStyle, resize: 'vertical', minHeight: '60px', fontFamily: 'var(--dsw-alias-mono, monospace)' },
              }),
              h('span', { style: hintSmall }, t.enginesOptionsHint),
            ),
          ),
          h('div', {
            style: {
              padding: '10px 16px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              display: 'flex', justifyContent: 'flex-end', gap: '8px',
            },
          },
            h('button', {
              type: 'button', onClick: onCancel,
              style: { appearance: 'none', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))', background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))', color: 'inherit', padding: '6px 12px', borderRadius: '8px', font: 'inherit', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
            }, t.enginesEditCancel),
            h('button', {
              type: 'button', onClick: onSave,
              style: { appearance: 'none', border: '1px solid transparent', background: 'var(--dsw-alias-brand-primary, #2563eb)', color: 'white', padding: '6px 14px', borderRadius: '8px', font: 'inherit', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
            }, t.enginesEditSave),
          ),
        ),
      )
    }

    // ───────────────── add-engine dialog (inline overlay) ─────────────────
    // Same fixed-position overlay shell as EngineDialog. Picking a category
    // only updates the local draft (`value.id`); the chain itself is
    // committed by the parent's onAdd — the dialog never calls setKey, so
    // no interaction inside it counts as a config update or triggers
    // auto-save.
    function AddEngineDialog(props) {
      var react = props.react, t = props.t, value = props.value
      var categories = props.categories || []
      var onChange = props.onChange, onCancel = props.onCancel, onAdd = props.onAdd
      var h = react.createElement
      var picked = !!value.id
      var btnBase = {
        appearance: 'none', width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
        padding: '9px 12px', borderRadius: '8px', font: 'inherit', fontSize: '13px',
        textAlign: 'left', cursor: 'pointer',
      }
      var hintSmall = {
        fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
      }
      return h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': t.enginesAddTitle,
        onClick: function (e) { if (e.target === e.currentTarget) onCancel() },
        style: {
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '16px',
        },
      },
        h('div', {
          style: {
            background: 'var(--dsw-alias-bg-page, white)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: '10px',
            boxShadow: '0 16px 48px rgba(0,0,0,0.22)',
            width: 'min(480px, 100%)',
            maxHeight: 'calc(100vh - 32px)',
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          },
        },
          h('div', {
            style: {
              padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            },
          },
            h('h3', { style: { margin: 0, fontSize: '15px', fontWeight: 700 } }, t.enginesAddTitle),
            h('button', {
              type: 'button', onClick: onCancel,
              style: { appearance: 'none', border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '13px' },
            }, t.enginesEditClose),
          ),
          h('div', {
            style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto' },
          },
            h('span', { style: hintSmall }, t.enginesAddHint),
            ...categories.map(function (id) {
              var active = value.id === id
              return h('button', {
                key: id, type: 'button',
                onClick: function () { onChange(Object.assign({}, value, { id: id })) },
                style: {
                  ...btnBase,
                  background: active ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
                  border: active ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                  color: active ? 'white' : 'inherit',
                },
              },
                h('span', { style: { fontWeight: 600 } }, ENGINE_LABELS[id] || id),
                h('span', {
                  style: {
                    fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.4px', padding: '2px 6px', borderRadius: '4px',
                    background: active ? 'rgba(255,255,255,0.18)' : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
                    border: '1px solid ' + (active ? 'rgba(255,255,255,0.25)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.22))'),
                  },
                }, id),
                h('span', {
                  style: {
                    marginLeft: 'auto', fontSize: '11px', opacity: active ? 0.85 : 0.6,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%',
                  },
                }, ENGINE_DEFAULT_ENDPOINTS[id] || ''),
              )
            }),
            picked ? null : h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary, #dc2626)' } }, t.engineNoCategory),
          ),
          h('div', {
            style: {
              padding: '10px 16px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              display: 'flex', justifyContent: 'flex-end', gap: '8px',
            },
          },
            h('button', {
              type: 'button', onClick: onCancel,
              style: { appearance: 'none', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))', background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))', color: 'inherit', padding: '6px 12px', borderRadius: '8px', font: 'inherit', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
            }, t.enginesEditCancel),
            h('button', {
              type: 'button', onClick: onAdd, disabled: !picked,
              style: {
                appearance: 'none', border: '1px solid transparent', background: 'var(--dsw-alias-brand-primary, #2563eb)',
                color: 'white', padding: '6px 14px', borderRadius: '8px', font: 'inherit',
                fontSize: '12px', fontWeight: 600, cursor: picked ? 'pointer' : 'not-allowed', opacity: picked ? 1 : 0.5,
              },
            }, t.enginesAddConfirm),
          ),
        ),
      )
    }

    // ───────────────── shared page composition ─────────────────
    // Compose the Tools + Engines + Request/Safety/Limits/Test cards into
    // one tree. Both the dedicated settings section and the legacy
    // Plugins-tab card route through this — same inner layout, different
    // outer chrome.
    function RenderNetworkPage(props) {
      var react = props.react
      var t = props.t
      var draft = props.draft, summary = props.summary, note = props.note
      var setKey = props.setKey, setKeys = props.setKeys
      var dialogState = props.dialogState, addDialogState = props.addDialogState
      var testState = props.testState, runLoopbackTest = props.runLoopbackTest
      var loaded = props.loaded !== false && !!draft && !!summary
      var cardOpen = props.cardOpen || { request: true, safety: true, limits: true, test: true }
      var onCardToggle = props.onCardToggle || function () {}

      var h = react.createElement

      // ─ Footer status pill ─
      var statusTone = note === t.saved ? 'var(--dsw-alias-state-success-primary, #16a34a)'
        : note === t.saving ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
        : note === t.saveFailed ? 'var(--dsw-alias-state-error-primary, #dc2626)'
        : 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))'
      var footer = h('div', { key: 'footer', style: STYLES.footer },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: statusTone } }),
          note || t.synced,
        ),
      )

      // During loading we render the cards' headers so the hook count stays
      // stable across the loading → loaded transition, and so the page
      // doesn't flicker to a blank section mid-fetch. The bodies show a
      // loading hint instead of the live fields until the first fetch
      // settles.
      var loadingBody = h('div', { style: { padding: '12px 0', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', fontSize: '13px' } }, note || t.loading)

      function card(key, name, description, fieldsFactory) {
        return CollapsibleCard(react, {
          key: key, name: name, description: description,
          open: cardOpen[key] !== false,
          onToggle: function () { onCardToggle(key) },
          // The fields factory is only invoked once we have live draft
          // data — every field renderer dereferences `draft.*` and would
          // crash on the loading paint where draft is null.
          children: loaded ? fieldsFactory() : loadingBody,
        })
      }

      return h(react.Fragment, null,
        ToolsSection(react, t, draft, setKey),
        EnginesSection(react, t, draft, summary, setKey, setKeys, dialogState, addDialogState),
        h('div', { key: 'cards', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          card('request', t.sectionRequest, t.sectionRequestDesc,
            function () { return RequestFields(react, t, draft, setKey) }),
          card('safety', t.sectionSafety, t.sectionSafetyDesc,
            function () { return SafetyFields(react, t, draft, setKey) }),
          card('limits', t.sectionLimits, t.sectionLimitsDesc,
            function () { return LimitsFields(react, t, draft, setKey) }),
          card('test', t.sectionTest, t.sectionTestDesc,
            function () { return TestFields(react, t, testState, runLoopbackTest) }),
        ),
        footer,
      )
    }

    // ───────────────── settings section (网络) ─────────────────
    // The dedicated settings page, registered into `settings.section`. Always-
    // open full-page form; the Plugins-tab card below stays a collapsed
    // accordion for the same fields.
    //
    // Auto-save: every change PUTs the full draft through the loopback
    // route. A short debounce coalesces bursts (drag, typing) into one
    // round-trip. The footer pill surfaces the in-flight / saved / error
    // state; manual Save / Discard buttons are gone.
    function NetworkSection(react, ui, localeRef) {
      var h = react.createElement
      var SAVE_DEBOUNCE_MS = 500

      function heading(t) {
        return h('header', {
          key: 'heading',
          style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingBottom: '12px' },
        },
          h('h2', {
            style: { margin: 0, fontSize: '16px', fontWeight: 600, lineHeight: '24px', color: 'var(--dsw-alias-label-primary, inherit)' },
          }, t.title),
          h('p', {
            style: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' },
          }, t.subtitle)
        )
      }

      return function NetworkSettingsPage() {
        var t = labelText(localeRef, '')
        // ALL hooks must run unconditionally on every render — React
        // tracks them per-fiber and a hook count mismatch (e.g. because
        // a later render exits early) throws "Rendered fewer hooks than
        // expected" and unmounts the subtree. Keep this top block in
        // sync with the rest of the page; do not add early returns
        // above it.
        var summaryState = react.useState(null)
        var draftState = react.useState(null)
        var noteState = react.useState('')
        var dialogState = react.useState(null) // engine edit dialog draft
        var addDialogState = react.useState(null) // add-engine dialog draft
        var saveTimer = react.useRef(null)
        var inFlight = react.useRef(null)
        var lastRevision = react.useRef(0)
        var testState = react.useState({ status: 'idle', message: '' })

        react.useEffect(function () {
          var alive = true
          fetchConfig()
            .then(function (s) {
              if (!alive) return
              summaryState[1](s)
              draftState[1](Object.assign({}, s.value))
              lastRevision.current = s.revision
            })
            .catch(function (e) { if (alive) noteState[1](noteFrom(e, t.loadFailed)) })
          return function () { alive = false }
        }, [])

        react.useEffect(function () {
          return function () {
            if (saveTimer.current) clearTimeout(saveTimer.current)
            if (inFlight.current) inFlight.current.abort()
          }
        }, [])

        var summary = summaryState[0], draft = draftState[0], note = noteState[0]
        var test = testState[0], setTest = testState[1]

        function runLoopbackTest() {
          setTest({ status: 'running', message: t.testLoopbackRunning })
          fetchHealth()
            .then(function (body) {
              if (body && body.ok) {
                setTest({ status: 'ok', message: t.testLoopbackOk })
              } else {
                setTest({ status: 'error', message: t.testLoopbackFail + (body && body.error ? ': ' + body.error : '') })
              }
            })
            .catch(function (e) {
              setTest({ status: 'error', message: t.testLoopbackFail + ': ' + noteFrom(e, 'unknown') })
            })
        }

        // No early return: the page renders the heading + skeleton even
        // before the first config fetch settles. This keeps the hook count
        // stable across the loading → loaded transition — a hook-count
        // mismatch is the kind of bug that survives review and only fires
        // when the route is briefly slow, so the smoke test enforces it.

        function setKey(k, value) {
          var next = Object.assign({}, draft)
          next[k] = value
          draftState[1](next)
          noteState[1]('')
          scheduleSave(next)
        }

        // Commit several draft keys in ONE update so the debounced save sees
        // the whole patch (a burst of setKey calls would only flush the last
        // `next`). Used by the engine dialog commit.
        function setKeys(patch) {
          var next = Object.assign({}, draft, patch)
          draftState[1](next)
          noteState[1]('')
          scheduleSave(next)
        }

        function scheduleSave(next) {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(function () {
            saveTimer.current = null
            flushSave(next || draft)
          }, SAVE_DEBOUNCE_MS)
        }
        function flushSave(next) {
          if (inFlight.current) inFlight.current.abort()
          var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
          inFlight.current = controller
          noteState[1](t.saving)
          putConfig({
            fetchTimeoutMs: next.fetchTimeoutMs,
            searchTimeoutMs: next.searchTimeoutMs,
            httpTimeoutMs: next.httpTimeoutMs,
            maxBodyChars: next.maxBodyChars,
            maxRedirects: next.maxRedirects,
            searchMaxResults: next.searchMaxResults,
            userAgent: next.userAgent,
            allowlist: next.allowlist,
            ssrfProtection: !!next.ssrfProtection,
            redirectProtection: !!next.redirectProtection,
            protocolLock: !!next.protocolLock,
            allowConfigEdit: !!next.allowConfigEdit,
            webSearchTool: next.webSearchTool !== false,
            webFetchTool: next.webFetchTool !== false,
            httpRequestTool: next.httpRequestTool !== false,
            webSitemapTool: next.webSitemapTool !== false,
            webConfigTool: next.webConfigTool !== false,
            // The one default-OFF toggle: `=== true`, not `!!`, so a draft
            // that predates the field never grants the file-write opt-in.
            downloadTool: next.downloadTool === true,
            searchEngines: next.searchEngines,
            searchEngineConfigs: next.searchEngineConfigs,
            httpMethods: next.httpMethods,
            ...githubSettingsPatch(next),
          }, lastRevision.current, controller ? controller.signal : undefined)
            .then(function (saved) {
              if (inFlight.current !== controller) return
              inFlight.current = null
              lastRevision.current = saved.revision
              // Roll the "last confirmed" snapshot forward so isDirty and
              // the revision token reflect the server side, but DO NOT
              // overwrite `draft` — the user may have edited more fields
              // during the in-flight round-trip, and clobbering them with
              // `saved.value` would silently undo those edits. Let the
              // next change trigger another debounced save.
              summaryState[1](saved)
              // The engine key that rode this payload now belongs to the
              // host: drop the plaintext from the draft (functional update,
              // so edits made during the round-trip survive). An aborted
              // save never gets here — the inFlight guard above returns.
              draftState[1](stripApiKeys)
              noteState[1](t.saved)
            })
            .catch(function (e) {
              if (e && (e.name === 'AbortError' || /aborted/i.test(String(e && e.message)))) return
              if (inFlight.current !== controller) return
              inFlight.current = null
              noteState[1](noteFrom(e, t.saveFailed))
            })
        }

        return h('section', { style: STYLES.page },
          heading(t),
          RenderNetworkPage({
            react: react, t: t, draft: draft, summary: summary, note: note,
            setKey: setKey, setKeys: setKeys,
            dialogState: dialogState, addDialogState: addDialogState,
            testState: test, runLoopbackTest: runLoopbackTest,
            loaded: !!(draft && summary),
          })
        )
      }
    }

    // ───────── settings card (Plugins tab, namespace-served deployments) ─────────
    function ConfigCard(react, ui, localeRef) {
      var h = react.createElement
      var SAVE_DEBOUNCE_MS = 500

      return function ModsearchCard() {
        var t = labelText(localeRef, '')
        var openState = react.useState(false)
        var summaryState = react.useState(null)
        var draftState = react.useState(null)
        var noteState = react.useState('')
        var dialogState = react.useState(null) // engine edit dialog draft
        var addDialogState = react.useState(null) // add-engine dialog draft
        var testState = react.useState({ status: 'idle', message: '' })
        var open = openState[0], summary = summaryState[0], draft = draftState[0], note = noteState[0]
        var test = testState[0], setTest = testState[1]

        react.useEffect(function () {
          if (!open || summary !== null) return
          fetchConfig()
            .then(function (s) {
              summaryState[1](s)
              draftState[1](Object.assign({}, s.value))
            })
            .catch(function (e) { noteState[1](noteFrom(e, t.loadFailed)) })
        }, [open, summary])

        var saveTimer = react.useRef(null)
        var inFlight = react.useRef(null)
        var lastRevision = react.useRef(0)
        react.useEffect(function () {
          if (summary) lastRevision.current = summary.revision
        }, [summary])
        react.useEffect(function () {
          return function () {
            if (saveTimer.current) clearTimeout(saveTimer.current)
            if (inFlight.current) inFlight.current.abort()
          }
        }, [])

        function runLoopbackTest() {
          setTest({ status: 'running', message: t.testLoopbackRunning })
          fetchHealth()
            .then(function (body) {
              if (body && body.ok) {
                setTest({ status: 'ok', message: t.testLoopbackOk })
              } else {
                setTest({ status: 'error', message: t.testLoopbackFail + (body && body.error ? ': ' + body.error : '') })
              }
            })
            .catch(function (e) {
              setTest({ status: 'error', message: t.testLoopbackFail + ': ' + noteFrom(e, 'unknown') })
            })
        }

        function flushSave(next) {
          if (inFlight.current) inFlight.current.abort()
          var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
          inFlight.current = controller
          noteState[1](t.saving)
          putConfig({
            fetchTimeoutMs: next.fetchTimeoutMs,
            searchTimeoutMs: next.searchTimeoutMs,
            httpTimeoutMs: next.httpTimeoutMs,
            maxBodyChars: next.maxBodyChars,
            maxRedirects: next.maxRedirects,
            searchMaxResults: next.searchMaxResults,
            userAgent: next.userAgent,
            allowlist: next.allowlist,
            ssrfProtection: !!next.ssrfProtection,
            redirectProtection: !!next.redirectProtection,
            protocolLock: !!next.protocolLock,
            allowConfigEdit: !!next.allowConfigEdit,
            // The six tool toggles (网络 → 工具). They MUST ride this payload:
            // the save is an explicit whitelist, so a toggle missing here is
            // dropped before it reaches applyCardSettings() — the switch would
            // flip in the local draft, the pill would say 已保存, and neither
            // the live config nor the persist file would ever see it.
            // Coerced with the SAME polarity the host reads them
            // (defaultConfig / applyCardSettings), so an absent key on a draft
            // from an older summary resolves to the documented default instead
            // of silently disabling a tool that was on.
            webSearchTool: next.webSearchTool !== false,
            webFetchTool: next.webFetchTool !== false,
            httpRequestTool: next.httpRequestTool !== false,
            webSitemapTool: next.webSitemapTool !== false,
            webConfigTool: next.webConfigTool !== false,
            // The one default-OFF toggle: `=== true`, not `!!`, so a draft
            // that predates the field never grants the file-write opt-in.
            downloadTool: next.downloadTool === true,
            searchEngines: next.searchEngines,
            searchEngineConfigs: next.searchEngineConfigs,
            httpMethods: next.httpMethods,
            ...githubSettingsPatch(next),
          }, lastRevision.current, controller ? controller.signal : undefined)
            .then(function (saved) {
              if (inFlight.current !== controller) return
              inFlight.current = null
              lastRevision.current = saved.revision
              summaryState[1](saved)
              draftState[1](stripApiKeys)
              noteState[1](t.saved)
            })
            .catch(function (e) {
              if (e && (e.name === 'AbortError' || /aborted/i.test(String(e && e.message)))) return
              if (inFlight.current !== controller) return
              inFlight.current = null
              noteState[1](noteFrom(e, t.saveFailed))
            })
        }
        function scheduleSave(next) {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(function () {
            saveTimer.current = null
            flushSave(next || draft)
          }, SAVE_DEBOUNCE_MS)
        }

        var body = null
        if (open) {
          var setKey = function (k, value) {
            var next = Object.assign({}, draft)
            next[k] = value
            draftState[1](next)
            noteState[1]('')
            scheduleSave(next)
          }
          var setKeys = function (patch) {
            var next = Object.assign({}, draft, patch)
            draftState[1](next)
            noteState[1]('')
            scheduleSave(next)
          }
          body = RenderNetworkPage({
            react: react, t: t, draft: draft, summary: summary, note: note,
            setKey: setKey, setKeys: setKeys,
            dialogState: dialogState, addDialogState: addDialogState,
            testState: test, runLoopbackTest: runLoopbackTest,
            loaded: !!(draft && summary),
          })
        }

        var cardStyle = Object.assign({}, STYLES.card, open ? STYLES.cardOpen : null)
        return h('div', { style: cardStyle },
          h('button', {
            type: 'button', 'aria-expanded': open,
            'aria-label': (open ? 'collapse: ' : 'expand: ') + t.title,
            onClick: function () { openState[1](!open) },
            style: STYLES.cardHeader,
          },
            h('div', { style: STYLES.cardHeadText },
              h('div', { style: STYLES.cardName }, t.title),
              h('div', { style: STYLES.cardDesc }, t.subtitle),
            ),
            IconChevron(react, open),
          ),
          open ? h('div', { style: { margin: '0 16px', paddingBottom: '8px' } }, body) : null
        )
      }
    }

    return {
      NetworkSection,
      RenderNetworkPage,
      EngineDialog,
      AddEngineDialog,
      ConfigCard,
    }

  },
})
