/* dsh-web browser half for dsh-network.
 *
 * Four things live here, all contributed through dsh's lazy-CJS slot registry:
 *
 *   1. **Dedicated settings section (`settings.section`, nav "网络")** — the
 *      primary configuration surface, modelled on dsh's default settings
 *      family: tool toggles render as plain "general settings" rows; the
 *      engine list renders as compact rows — category text + optional
 *      token-status badge + icon buttons. Each category can be added only
 *      once, so the row identity is the category id itself and there is no
 *      per-engine display name to edit; Request / Safety / Limits / Test
 *      each become a collapsible plugin-config card. The page
 *      talks to the loopback route registered by the host plugin
 *      (`/dsh-network/config`) and edits the same live config object the CLI
 *      reads.
 *
 *   2. **Sidebar search panel (`sidebar.panellist` + layout `main`)** — a
 *      search-engine-style page behind a rail entry: one search box, an
 *      engine picker mirroring the live engine chain, and hits rendered as
 *      result cards (title link, host, snippet, date) under the engines'
 *      summary. It drives the host's `/dsh-network/search` route — the same
 *      engine chain the web_search tool uses — and only mounts after the
 *      route probe proves the host plugin is present (and the web_search
 *      tool is not switched off). Panel state survives unmounts so peeking
 *      at the conversation never loses results.
 *
 *   3. **Settings card (`settings.plugin.item` slot)** — the legacy
 *      Plugins-tab card, kept for deployments that serve the `dsh-network`
 *      namespace (the tab dispatches cards only for namespaces the Host
 *      serves; this plugin intentionally does not register one, so the card
 *      stays dormant in the stock web profile). It reuses the same
 *      per-section renderers so the two surfaces stay in sync.
 *
 *   4. **Search card renderer** (`tool.call.toolview`, key `web_search`) —
 *      the card system current dsh builds ship. dsh's tool-web merges every
 *      query of one call into a single capped, round-robin source list under
 *      per-query headings, which reads badly (empty headings, an interleaved
 *      list) and hides the sources past the cap. This row renders the
 *      provider's per-query answer instead, so each query keeps its own
 *      heading and its own hits. The legacy `tool.web.item` /
 *      `tool.web.fetch.item` renderers stay registered for older dsh builds
 *      and add engine / uncertainty / outgoing-link chrome around the native
 *      cards. All renderers are reactive, fall back to the raw body when a
 *      piece of structured data is missing, and never mutate session state.
 *
 * Hand-written in the same lazy-CJS protocol used by the dsh client
 * plugin loader (window.__ModuleLoader__.load), so no build step and no
 * imports from dsh client packages: zero-dependency on the wire.
 *
 * The factory MUST declare its `require` parameter: the loader invokes
 * `factory(this.makeRequire(edges))` and without the parameter `require`
 * resolves to nothing, so every registration below would silently skip.
 */
window.__ModuleLoader__.load({
  id: 'dsh-network',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var ENGINES = ['bing', 'duckduckgo', 'baidu', 'github', 'searxng']
    var ENGINE_LABELS = { bing: 'Bing', duckduckgo: 'DuckDuckGo', baidu: 'Baidu', github: 'GitHub', searxng: 'SearXNG' }
    var ENGINE_DEFAULT_ENDPOINTS = {
      bing: 'https://www.bing.com/search',
      duckduckgo: 'https://html.duckduckgo.com/html',
      baidu: 'https://www.baidu.com/s',
      github: 'https://api.github.com/search',
      // SearXNG is deliberately NOT here: it is self-hosted, so its
      // endpoint must stay editable in the engine dialog (built-in engines
      // with a fixed endpoint get a locked input). The loopback default
      // lives in the host's defaultConfig seed.
    }
    var ENGINE_HAS_API_KEY = { bing: false, duckduckgo: false, baidu: false, github: false, searxng: false }
    // GitHub engine: token / indexes / sort live inside the engine edit
    // dialog (config.githubToken / githubIndexes / githubSort), committed
    // through githubSettingsPatch() on save.
    var GITHUB_INDEX_LABELS = { repositories: 'Repositories', code: 'Code', issues: 'Issues', users: 'Users' }
    var GITHUB_SORTS = ['best', 'stars', 'updated']
    /** Per-engine one-line description shown inside the edit dialog. */
    var ENGINE_HINTS = { bing: 'engineHintBing', duckduckgo: 'engineHintDuckduckgo', baidu: 'engineHintBaidu', github: 'githubHint', searxng: 'searxngHint' }

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

    // ───────────────────────── helpers (shared) ─────────────────────────
    /** Locale dictionaries; registered with the locale service so the
     *  settings section re-renders and re-labels on language switch. */
    var DICTS = {
      zh: {
        nav: '网络',
        title: '网络 (dsh-network)',
        subtitle: '让 Deepseek Harness 无感访问互联网。',
        sectionTools: '工具',
        sectionEngines: '搜索引擎',
        sectionRequest: '请求',
        sectionRequestDesc: 'User-Agent 与各工具的超时时间。',
        sectionSafety: '安全',
        sectionSafetyDesc: '主机白名单与重定向 / 协议 / 私网访问保护。',
        sectionLimits: '限制',
        sectionLimitsDesc: '搜索结果数、重定向跳数与最大响应字符数。',
        sectionTest: '测试',
        sectionTestDesc: '运行诊断检查，验证插件状态。',
        testLoopback: '测试 loopback 服务器',
        testLoopbackDesc: '检查 dsh-network 回环服务器是否可响应',
        testLoopbackIdle: '未测试',
        testLoopbackRunning: '测试中…',
        testLoopbackOk: '服务器正常',
        testLoopbackFail: '测试失败',
        toolWebSearch: '网络搜索',
        toolWebSearchDesc: '在 Web 上发现最新信息。',
        toolWebFetch: '页面抓取',
        toolWebFetchDesc: '抓取并解析指定的 HTTP(S) URL。',
        toolHttpRequest: 'HTTP 请求',
        toolHttpRequestDesc: '直接发起低层 HTTP 请求（自定义方法 / 头部 / body）。',
        toolWebSitemap: '门户查询',
        toolWebSitemapDesc: '查询常用门户入口表。',
        enginesHint: '按链顺序回退；web_search 支持通过 engine 参数指定单一引擎。',
        enginesCategory: '类别',
        enginesAdd: '添加到链',
        enginesAddTitle: '添加搜索引擎',
        enginesAddHint: '选择要加入链的搜索引擎类别',
        enginesAddConfirm: '添加',
        enginesEnabled: '已启用',
        enginesEmpty: '至少保留一个搜索引擎',
        enginesEdit: '编辑搜索引擎',
        enginesEditEndpoint: 'Endpoint',
        enginesEditApiKey: 'API Key',
        enginesEditOptions: '自定义参数（每行一个 key=value）',
        enginesEditSave: '保存',
        enginesEditCancel: '取消',
        enginesEditClose: '关闭',
        enginesDelete: '删除',
        enginesApiKeyConfigured: '已配置 API Key',
        enginesApiKeyMissing: '未配置 API Key',
        enginesApiKeyWriteOnly: '只写；浏览器读不到密钥。',
        githubHint: '混合 REST 搜索（repositories/code/issues/users，RRF 融合）。无 token 时匿名配额 10 次/分钟/IP；配置 token 后 30 次/分钟并启用 code 搜索。',
        githubToken: 'Token（可选）',
        githubTokenPlaceholder: '粘贴 GitHub fine-grained PAT（无需任何权限）',
        githubTokenEmpty: '未配置',
        githubTokenConfigured: '已配置（只写，不显示）',
        githubTokenClear: '清除',
        githubIndexes: '索引',
        githubIndexesHint: '为空时按查询意图自动路由（默认）',
        githubSort: '仓库排序',
        githubSortBest: '最佳匹配',
        githubSortStars: 'Star 数',
        githubSortUpdated: '最近更新',
        githubGroupTitle: 'GitHub 专属设置',
        githubTokenRowOn: 'Token 已配置',
        githubTokenRowOff: 'Token 未配置',
        enginesEndpointLocked: '内置引擎的 Endpoint 固定，不可修改',
        enginesOptionsHint: '每行一个 key=value；作为查询参数附加到请求。',
        engineHintBing: 'Bing 网页搜索（免密钥）。',
        engineHintDuckduckgo: 'DuckDuckGo Lite HTML 搜索（免密钥，注重隐私）。',
        engineHintBaidu: '百度网页搜索（免密钥，中文结果更佳）。',
        searxngHint: '自托管元搜索引擎（JSON API）。Endpoint 默认 http://127.0.0.1:8888，可修改；实例的 settings.yml 必须在 search.formats 中启用 json，否则请求返回 403。仅本引擎自动放行回环地址，其余路径仍受 SSRF 防护约束。',
        userAgent: 'User-Agent',
        fetchTimeout: 'web_fetch 超时（毫秒）',
        searchTimeout: 'web_search 单引擎超时（毫秒）',
        httpTimeout: 'http_request 超时（毫秒）',
        ssrfProtection: 'SSRF 保护',
        ssrfProtectionHint: '拒绝私网、回环与保留地址；关闭后才允许访问私网。',
        redirectProtection: '重定向保护',
        redirectProtectionHint: '仅允许重定向到同一域名。',
        protocolLock: '协议锁定保护',
        protocolLockHint: '禁止重定向时在 http 与 https 之间降级或升级。',
        allowConfigEdit: '允许修改设置',
        allowConfigEditHint: '打开后模型可直接修改网络设置（默认关闭）。',
        allowlist: '主机白名单',
        allowlistHint: '为空时表示不限制。支持 * / *.example.com / 主机名；不在白名单内的请求会被拒绝。',
        allowlistPlaceholder: '输入主机名后回车，例如 *.example.com',
        maxResults: '搜索结果上限',
        maxRedirects: '重定向最大跳数',
        maxBodyChars: '最大响应字符',
        methods: 'http_request 方法集',
        protectionOn: '已启用',
        protectionOff: '已禁用',
        loading: '加载中…',
        loadFailed: '加载失败',
        saveFailed: '保存失败',
        saved: '已保存',
        saving: '保存中…',
        dirty: '有未保存的更改',
        synced: '已同步',
        engineUnknown: '该搜索引擎不存在',
        engineDuplicate: '该类别已存在',
        engineNoCategory: '请选择类别',
        searchToolTitle: '网络搜索',
        searchToolQueries: '个查询',
        searchToolSources: '条来源',
        searchToolRunning: '搜索中…',
        searchToolTruncated: '结果已按上限截断',
        searchToolNoResults: '未找到结果',
        searchToolFailed: '请求失败',
        // ── sidebar search panel ──
        searchPanel: '网络搜索',
        searchPanelSubtitle: '在侧边栏直接搜索公共网络，走与 web_search 相同的引擎链。',
        searchPanelPlaceholder: '输入搜索内容…',
        searchPanelGo: '搜索',
        searchPanelEngineAll: '全部引擎',
        searchPanelCountLabel: '结果数',
        searchPanelEmptyHint: '输入内容开始搜索，例如「typescript 5.9 release notes」。',
        searchPanelSummary: '摘要',
        searchPanelResultsUnit: '条结果',
        searchPanelElapsed: '耗时',
        searchPanelSecond: '秒',
        searchPanelUncertain: '不确定项',
        searchPanelWarning: '警告',
        searchPanelAttempts: '引擎尝试详情',
        searchPanelFailed: '搜索失败',
        searchPanelOpenNew: '在新标签页打开',
        searchPanelRecent: '最近',
        searchPanelStatusOk: '正常',
        searchPanelStatusDegraded: '降级',
      },
      en: {
        nav: 'Network',
        title: 'Network (dsh-network)',
        subtitle: 'Let Deepseek Harness access the internet seamlessly.',
        sectionTools: 'Tools',
        sectionEngines: 'Search engines',
        sectionRequest: 'Request',
        sectionRequestDesc: 'User-Agent and per-tool timeouts.',
        sectionSafety: 'Safety',
        sectionSafetyDesc: 'Host allowlist and redirect / protocol / private-network protection.',
        sectionLimits: 'Limits',
        sectionLimitsDesc: 'Search result cap, redirect hop cap and max response characters.',
        sectionTest: 'Test',
        sectionTestDesc: 'Run diagnostic checks to verify plugin state.',
        testLoopback: 'Test loopback server',
        testLoopbackDesc: 'Check whether the dsh-network loopback server responds',
        testLoopbackIdle: 'Not tested',
        testLoopbackRunning: 'Testing…',
        testLoopbackOk: 'Server OK',
        testLoopbackFail: 'Test failed',
        toolWebSearch: 'Search',
        toolWebSearchDesc: 'Discover current information on the web.',
        toolWebFetch: 'Fetch',
        toolWebFetchDesc: 'Fetch and parse a specific HTTP(S) URL.',
        toolHttpRequest: 'HTTP Request',
        toolHttpRequestDesc: 'Issue low-level HTTP requests with custom methods, headers, and body.',
        toolWebSitemap: 'Site Map',
        toolWebSitemapDesc: 'Look up the curated portal table.',
        enginesHint: 'Fallback in chain order; pass `engine` to web_search to target one.',
        enginesCategory: 'Category',
        enginesAdd: 'Add to chain',
        enginesAddTitle: 'Add search engine',
        enginesAddHint: 'Pick a search-engine category to add to the chain',
        enginesAddConfirm: 'Add',
        enginesEnabled: 'enabled',
        enginesEmpty: 'At least one engine must remain',
        enginesEdit: 'Edit search engine',
        enginesEditEndpoint: 'Endpoint',
        enginesEditApiKey: 'API Key',
        enginesEditOptions: 'Custom options (one key=value per line)',
        enginesEditSave: 'Save',
        enginesEditCancel: 'Cancel',
        enginesEditClose: 'Close',
        enginesDelete: 'Remove',
        enginesApiKeyConfigured: 'API key configured',
        enginesApiKeyMissing: 'API key missing',
        enginesApiKeyWriteOnly: 'Write-only; the browser never reads the key.',
        githubHint: 'Hybrid REST search (repositories / code / issues / users, RRF fusion). Anonymous: 10 req/min per IP; a token raises this to 30/min and enables code search.',
        githubToken: 'Token (optional)',
        githubTokenPlaceholder: 'Paste a fine-grained PAT (no permissions needed)',
        githubTokenEmpty: 'Not configured',
        githubTokenConfigured: 'Configured (write-only, not shown)',
        githubTokenClear: 'Clear',
        githubIndexes: 'Indexes',
        githubIndexesHint: 'Empty = automatic intent routing (default)',
        githubSort: 'Repository sort',
        githubSortBest: 'Best match',
        githubSortStars: 'Stars',
        githubSortUpdated: 'Recently updated',
        githubGroupTitle: 'GitHub-specific settings',
        githubTokenRowOn: 'Token set',
        githubTokenRowOff: 'No token',
        enginesEndpointLocked: 'Built-in engine endpoint is fixed and cannot be modified',
        enginesOptionsHint: 'One key=value per line; appended to the request as query parameters.',
        engineHintBing: 'Bing web search (no key required).',
        engineHintDuckduckgo: 'DuckDuckGo Lite HTML search (no key, privacy-first).',
        engineHintBaidu: 'Baidu web search (no key, best for Chinese).',
        searxngHint: 'Self-hosted metasearch via its JSON API. Endpoint defaults to http://127.0.0.1:8888 (editable); the instance must enable `json` in `search.formats` of its settings.yml or requests get a 403. Loopback access is granted for this engine only — SSRF guards stay on everywhere else.',
        userAgent: 'User-Agent',
        fetchTimeout: 'web_fetch timeout (ms)',
        searchTimeout: 'web_search per-engine timeout (ms)',
        httpTimeout: 'http_request timeout (ms)',
        ssrfProtection: 'SSRF protection',
        ssrfProtectionHint: 'Blocks private, loopback, and reserved targets; turning it off allows private networks.',
        redirectProtection: 'Redirect protection',
        redirectProtectionHint: 'Only redirects to the same domain are followed.',
        protocolLock: 'Protocol lock protection',
        protocolLockHint: 'Redirects may not switch between http and https.',
        allowConfigEdit: 'Allow the model to modify settings',
        allowConfigEditHint: 'When on, the model can modify network settings directly (off by default).',
        allowlist: 'Host allowlist',
        allowlistHint: 'Empty means unrestricted. Supports * / *.example.com / hostnames; requests outside the allowlist are denied.',
        allowlistPlaceholder: 'Type a host and press Enter, e.g. *.example.com',
        maxResults: 'Search result cap',
        maxRedirects: 'Maximum redirect hops',
        maxBodyChars: 'Max response characters',
        methods: 'http_request methods',
        protectionOn: 'On',
        protectionOff: 'Off',
        loading: 'Loading…',
        loadFailed: 'Load failed',
        saveFailed: 'Save failed',
        saved: 'Saved',
        saving: 'Saving…',
        dirty: 'Unsaved changes',
        synced: 'Synced',
        engineUnknown: 'No such search engine',
        engineDuplicate: 'Category already added',
        engineNoCategory: 'Pick a category first',
        searchToolTitle: 'Web search',
        searchToolQueries: 'queries',
        searchToolSources: 'sources',
        searchToolRunning: 'Searching…',
        searchToolTruncated: 'Results were capped',
        searchToolNoResults: 'No results found',
        searchToolFailed: 'Request failed',
        // ── sidebar search panel ──
        searchPanel: 'Web Search',
        searchPanelSubtitle: 'Search the public web right from the sidebar, on the same engine chain as web_search.',
        searchPanelPlaceholder: 'Type a query…',
        searchPanelGo: 'Search',
        searchPanelEngineAll: 'All engines',
        searchPanelCountLabel: 'Results',
        searchPanelEmptyHint: 'Type a query to start searching, e.g. "typescript 5.9 release notes".',
        searchPanelSummary: 'Summary',
        searchPanelResultsUnit: 'results',
        searchPanelElapsed: 'took',
        searchPanelSecond: 's',
        searchPanelUncertain: 'Uncertain',
        searchPanelWarning: 'Warning',
        searchPanelAttempts: 'Engine attempts',
        searchPanelFailed: 'Search failed',
        searchPanelOpenNew: 'Open in new tab',
        searchPanelRecent: 'Recent',
        searchPanelStatusOk: 'OK',
        searchPanelStatusDegraded: 'Degraded',
      },
    }

    function labels(lang) {
      return String(lang || '').toLowerCase().indexOf('zh') === 0 ? DICTS.zh : DICTS.en
    }

    /** The active locale tag ('zh-*' / 'en' / …) from the locale service. */
    function currentLang(localeRef) {
      var locale = localeRef && localeRef.current ? localeRef.current.getSnapshot().active : ''
      var lang = (locale || document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang
    }

    function labelText(localeRef, fallbackLang) {
      var lang = currentLang(localeRef) || fallbackLang
      return labels(lang)
    }

    function noteFrom(err, fallback) {
      var detail = err && typeof err.message === 'string' ? err.message : err ? String(err) : ''
      return detail || fallback
    }

    /** RFC-aware cache-buster: the host reads config from the cordis row +
     *  in-memory edits, and the browser half asks the host loopback to proxy
     *  so the user never sees a raw key in the page. */
    function fetchConfig() {
      return fetch('/dsh-network/config').then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status))
          return body
        })
      })
    }
    function putConfig(patch, expectedRevision, signal) {
      var headers = { 'content-type': 'application/json' }
      if (typeof expectedRevision === 'number') headers['if-match'] = String(expectedRevision)
      var opts = { method: 'PUT', headers: headers, body: JSON.stringify(patch) }
      if (signal) opts.signal = signal
      return fetch('/dsh-network/config', opts).then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status))
          return body
        })
      })
    }
    function fetchHealth() {
      return fetch('/dsh-network/health').then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status))
          return body
        })
      })
    }

    /** Dirty test shared by the card and the section: compares the draft
     *  against the last loaded summary on the fields the form edits. */
    function isDirty(draft, summary) {
      if (!draft || !summary || !summary.value) return false
      var keys = [
        'enabled', 'userAgent', 'allowlist', 'ssrfProtection', 'redirectProtection', 'protocolLock',
        'allowConfigEdit',
        'fetchTimeoutMs', 'searchTimeoutMs', 'httpTimeoutMs',
        'maxBodyChars', 'maxRedirects', 'searchMaxResults',
        'searchEngines', 'searchEngineConfigs', 'httpMethods',
        'webSearchTool', 'webFetchTool', 'httpRequestTool', 'webSitemapTool', 'webConfigTool',
      ]
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i]
        if (JSON.stringify(draft[key]) !== JSON.stringify(summary.value[key])) return true
      }
      return false
    }

    // ───────────────── shared style fragments (dsw-* aliases) ─────────────────
    // All values mirror dsh's built-in settings packages so the page reads as
    // part of the host rather than as a foreign skin. Every declaration has a
    // raw fallback so the Node smoke test (no document body) keeps working.
    var STYLES = {
      page: {
        maxWidth: '720px',
        display: 'flex', flexDirection: 'column', gap: '12px',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      // "general settings" row: title + desc on the left, control on the
      // right, border-bottom divider. Matches dsh's settings.general.item
      // (figma T1PP_q_row in ui-conversation).
      genRow: {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '16px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      },
      genRowLast: { borderBottom: 'none' },
      genRowText: {
        display: 'flex', flexDirection: 'column', gap: '4px',
        flex: '1 1 auto', minWidth: '0', paddingRight: '48px',
      },
      genRowTitle: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '14px', fontWeight: 400, lineHeight: '22px',
      },
      genRowDesc: {
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
        fontSize: '12px', fontWeight: 400, lineHeight: '18px',
      },
      // Engine list container (rounded card holding the rows).
      engineList: {
        display: 'flex', flexDirection: 'column',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
        overflow: 'hidden',
      },
      // Engine row (general-settings-style: category text + token status
      // badge + icon actions). Each category can only be added once, so the
      // row identity is the category id itself — no custom name to show.
      engineRow: {
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      },
      engineRowLast: { borderBottom: 'none' },
      engineCategoryText: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '14px', fontWeight: 600, lineHeight: '20px',
      },
      // Token status pill, mirror of the settings badge (fieldBadge):
      // rounded capsule, tone-coloured text on a faint tinted fill.
      engineTokenBadge: function (tone) {
        return {
          flex: 'none',
          borderRadius: '999px', padding: '1px 8px',
          fontSize: '11px', fontWeight: 500, lineHeight: '17px',
          color: tone === 'ok'
            ? 'var(--dsw-alias-state-success-primary, #16a34a)'
            : 'var(--dsw-alias-state-error-primary, #dc2626)',
          background: tone === 'ok'
            ? 'rgba(34, 197, 94, 0.14)'
            : 'rgba(239, 68, 68, 0.14)',
        }
      },
      engineActions: { display: 'flex', gap: '4px', flex: 'none' },
      iconBtn: {
        width: '28px', height: '28px', borderRadius: '8px',
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: '0', font: 'inherit',
      },
      iconBtnHover: { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))', color: 'var(--dsw-alias-label-primary, inherit)' },
      iconBtnDanger: { color: 'var(--dsw-alias-state-error-primary, #dc2626)' },
      iconBtnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
      // Add-engine footer (dashed separator + plus button).
      addRow: {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '10px 14px',
        borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      },
      primaryBtn: {
        appearance: 'none',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary, #2563eb)',
        color: 'white',
        padding: '5px 10px', borderRadius: '8px',
        font: 'inherit', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: '4px',
      },
      // Section header above general/engine groups.
      sectionHeader: {
        fontSize: '14px', fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        margin: '4px 0 4px 0', letterSpacing: '0.2px',
      },
      // Plugin-config card (.YyYd_a_card in ui-settings-plugins).
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
        borderRadius: '12px',
        listStyle: 'none',
        transition: 'border-color .16s, background .16s',
      },
      cardOpen: {
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
        borderColor: 'var(--dsw-alias-label-dimmed, rgba(127,127,127,0.5))',
      },
      cardHeader: {
        appearance: 'none', width: '100%',
        font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer',
        background: 'transparent', border: '0', borderRadius: '12px',
        alignItems: 'center', gap: '12px',
        padding: '14px 16px', display: 'flex',
      },
      cardHeadText: {
        display: 'flex', flexDirection: 'column', gap: '4px',
        flex: '1 1 auto', minWidth: '0',
      },
      cardName: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '15px', fontWeight: 600, lineHeight: '1.4',
        display: 'flex', alignItems: 'center', gap: '8px',
      },
      cardDesc: {
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
        fontSize: '13px', lineHeight: '1.5',
      },
      cardChevron: {
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
        flex: 'none', transition: 'transform .16s',
      },
      cardChevronOpen: { transform: 'rotate(180deg)' },
      cardBody: {
        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        margin: '0 16px', paddingBottom: '8px',
      },
      // Field inside the card body (.At1oFq_field in ui-settings-plugins).
      field: {
        display: 'flex', flexDirection: 'column', gap: '6px',
        padding: '12px 0',
      },
      fieldHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      fieldLabel: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '13px', fontWeight: 500, lineHeight: '1.5',
        flex: '1 1 auto', minWidth: '0',
      },
      fieldInput: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
        height: '34px', font: 'inherit',
        color: 'var(--dsw-alias-label-primary, inherit)',
        borderRadius: '8px', padding: '0 12px',
        fontSize: '13px', lineHeight: '1.5', outline: 'none',
      },
      fieldHint: {
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
        margin: '0', fontSize: '12px', lineHeight: '1.5',
      },
      fieldBadge: {
        background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.12))',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        borderRadius: '999px', padding: '1px 8px',
        fontSize: '11px', fontWeight: 500, lineHeight: '17px',
        flex: 'none',
      },
      fieldBadgeMuted: {
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
        borderRadius: '999px', padding: '1px 8px',
        fontSize: '11px', lineHeight: '17px',
        flex: 'none',
      },
      // Footer status pill.
      footer: {
        marginTop: '6px', padding: '8px 4px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
      },
      // ── sidebar search panel (layout `main` page) ──
      // Geometry mirrors ui-plugin-manager's page (`.page`): a full-height
      // centered column whose children cap at 960px.
      searchPage: {
        boxSizing: 'border-box', height: '100%', width: '100%',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: '20px', padding: '0 clamp(24px, 4vw, 48px) 48px',
        overflowY: 'auto', overflowX: 'hidden',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      searchChild: { width: '100%', maxWidth: '960px', flex: 'none' },
      searchHead: { paddingTop: '28px', display: 'flex', flexDirection: 'column', gap: '4px' },
      searchTitle: { margin: '0', fontSize: '20px', fontWeight: 500, lineHeight: '28px' },
      searchIntro: {
        margin: '0', fontSize: '13px', lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
      },
      searchBar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      searchInput: {
        flex: '1 1 240px', minWidth: '160px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
        height: '36px', font: 'inherit', fontSize: '13px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        borderRadius: '10px', padding: '0 12px', outline: 'none',
      },
      searchSelect: {
        flex: 'none',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
        height: '36px', font: 'inherit', fontSize: '13px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        borderRadius: '10px', padding: '0 8px', outline: 'none', cursor: 'pointer',
      },
      searchRunBtn: {
        appearance: 'none', flex: 'none', cursor: 'pointer',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary, #2563eb)',
        color: '#fff', font: 'inherit', fontSize: '13px', fontWeight: 600,
        height: '36px', padding: '0 16px', borderRadius: '10px',
        display: 'inline-flex', alignItems: 'center', gap: '6px',
      },
      searchRunBtnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
      searchRecent: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      searchRecentLabel: {
        flex: 'none', fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
      },
      searchRecentChip: {
        appearance: 'none', cursor: 'pointer', font: 'inherit', fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, inherit)', maxWidth: '260px',
        textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        borderRadius: '999px', padding: '2px 10px', lineHeight: '18px',
      },
      searchStatus: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
      },
      searchResultsList: { display: 'flex', flexDirection: 'column' },
      searchResult: {
        display: 'flex', flexDirection: 'column', gap: '2px',
        padding: '12px 2px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22))',
      },
      searchResultLast: { borderBottom: 'none' },
      searchResultTitle: {
        color: 'var(--dsw-alias-link, #2563eb)', fontSize: '15px',
        fontWeight: 500, lineHeight: '22px', textDecoration: 'none',
        wordBreak: 'break-word', cursor: 'pointer',
      },
      searchResultMeta: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        fontSize: '12px', lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
      },
      searchResultHost: { color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' },
      searchResultSnippet: {
        fontSize: '13px', lineHeight: '20px', margin: '2px 0 0',
        color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
        overflowWrap: 'anywhere',
      },
      searchSummary: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
        borderRadius: '12px', padding: '12px 16px',
        display: 'flex', flexDirection: 'column', gap: '6px',
      },
      searchSummaryLabel: {
        fontSize: '12px', fontWeight: 600, letterSpacing: '0.2px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        display: 'inline-flex', alignItems: 'center', gap: '6px',
      },
      searchNote: {
        display: 'flex', alignItems: 'flex-start', gap: '6px',
        fontSize: '12px', lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
        overflowWrap: 'anywhere',
      },
      searchAttempts: {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
      },
      searchAttemptsPre: {
        margin: '6px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        font: 'inherit', fontSize: '11px', lineHeight: '16px',
      },
      searchError: {
        border: '1px solid var(--dsw-alias-state-error-primary, #dc2626)',
        background: 'rgba(239, 68, 68, 0.08)',
        borderRadius: '12px', padding: '12px 16px',
        display: 'flex', flexDirection: 'column', gap: '4px',
      },
      searchErrorTitle: {
        fontSize: '13px', fontWeight: 600,
        color: 'var(--dsw-alias-state-error-primary, #dc2626)',
      },
      searchErrorDetail: {
        fontSize: '12px', lineHeight: '18px', margin: 0,
        color: 'var(--dsw-alias-label-secondary, inherit)', overflowWrap: 'anywhere',
      },
      searchEmpty: {
        padding: '24px 0', fontSize: '13px',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
      },
      searchRunning: {
        display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
      },
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
        nextConfigs[id] = {
          endpoint: dlg.endpoint,
          hasApiKey: dlg.hasApiKey,
          options: dlg.options,
        }
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
            ? h('span', { style: STYLES.engineTokenBadge(summary.hasGithubToken ? 'ok' : 'error') },
              summary.hasGithubToken ? t.githubTokenRowOn : t.githubTokenRowOff)
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
        hasGithubToken: summary.hasGithubToken === true,
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

    // ───────── dedicated search / fetch block renderers ─────────
    // Priority claimed for our `tool.call.toolview` `web_search` entry. dsh
    // registers the native row at the default 0 and a keyed slot renders only
    // the LOWEST-priority live entry of a cell, so a negative number is what
    // shadows it. See the registration site below.
    //
    // The `tool.call.toolview` slot is keyed by tool name, so each tool gets
    // its own cell. The priority value only needs to beat dsh's native 0;
    // cross-tool comparisons are not in play. We reuse `-900` for every
    // row to keep the value the comment refers to.
    var WEB_SEARCH_ROW_PRIORITY = -900
    var HTTP_REQUEST_ROW_PRIORITY = -900
    var WEB_SITEMAP_ROW_PRIORITY = -900
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
      var MarkdownText = ui && typeof ui.MarkdownText === 'function' ? ui.MarkdownText : null
      var TextShimmer = ui && typeof ui.TextShimmer === 'function' ? ui.TextShimmer : null
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
                      ? react.createElement(MarkdownText, { text: answer })
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
      var MarkdownText = ui && typeof ui.MarkdownText === 'function' ? ui.MarkdownText : null
      var TextShimmer = ui && typeof ui.TextShimmer === 'function' ? ui.TextShimmer : null
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
      var MarkdownText = ui && typeof ui.MarkdownText === 'function' ? ui.MarkdownText : null
      var TextShimmer = ui && typeof ui.TextShimmer === 'function' ? ui.TextShimmer : null
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
              ? react.createElement(MarkdownText, { text: summary })
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

    // ────────────────────── slot registration ──────────────────────
    function tryRequire(spec) {
      try { return require(spec) } catch (e) {
        console.error('[dsh-network] module unavailable: ' + spec, e)
        return undefined
      }
    }

    // ────────────────────── settings sidebar nav icon ──────────────────────
    // The dsh settings shell hardcodes each section's nav glyph (navIcon(id)
    // in dsh-client-ui-settings-general): only models / agent-presets /
    // plugins get bespoke icons; every other id — including ours
    // ("dsh-network") — falls back to the settings gear. The settings.section
    // slot carries no icon field, so — exactly like dsh-meme — we patch the
    // rendered DOM instead: a MutationObserver watches the settings dialog's
    // nav rail and swaps the gear glyph of the row labelled 网络 / Network
    // for a network (globe) icon. All DOM access is feature-guarded so the
    // Node smoke test (stubbed document) and headless loads stay safe.
    var NAV_LABELS = ['网络', 'Network']

    function networkIconSvg() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.style.cssText = 'width:16px;height:16px;flex:none'
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z')
      path.setAttribute('fill', 'currentColor')
      svg.appendChild(path)
      return svg
    }

    function decorateNavIcon() {
      var nav = document.querySelector('[role="dialog"] nav')
      if (!nav) return
      var buttons = nav.querySelectorAll('button')
      for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i]
        if (btn.dataset && btn.dataset.dshNetworkNav) continue
        var label = (btn.textContent || '').trim()
        if (NAV_LABELS.indexOf(label) === -1) continue
        var icon = btn.firstElementChild
        if (!icon || icon.tagName === 'IMG') { btn.dataset.dshNetworkNav = '1'; continue }
        icon.replaceWith(networkIconSvg())
        btn.dataset.dshNetworkNav = '1'
      }
    }

    /** Start the MutationObserver; returns the observer (or undefined). */
    function watchSettingsNavIcon() {
      if (typeof document === 'undefined' || !document) return
      if (typeof document.querySelector !== 'function' || !document.body) return
      if (typeof MutationObserver === 'undefined') {
        try { decorateNavIcon() } catch (e) {}
        return
      }
      var observer = new MutationObserver(function () {
        try { decorateNavIcon() } catch (e) {}
      })
      observer.observe(document.body, { childList: true, subtree: true })
      try { decorateNavIcon() } catch (e) {}
      return observer
    }

    function apply(ctx) {
      if (typeof ctx.inject !== 'function') return

      var navObserver = watchSettingsNavIcon()
      if (navObserver && typeof ctx.effect === 'function') {
        ctx.effect(function () { return function () { navObserver.disconnect() } }, 'dsh-network: settings nav icon')
      }

      ctx.inject(['slots'], function (scope) {
        var localeRef = { current: null }
        ctx.inject(['locale'], function (lscope) {
          localeRef.current = lscope.locale
          if (typeof lscope.locale.register === 'function') {
            lscope.locale.register('dsh-network', DICTS)
          }
          if (typeof lscope.effect === 'function') lscope.effect(function () { return function () { localeRef.current = null } }, 'dsh-network: locale handle')
        })

        var react = tryRequire('react')
        if (!react) {
          console.error('[dsh-network] skipped: react unavailable')
          return
        }
        var ui = tryRequire('@deepseek-ai/dsh-client-ui-primitives') || { Input: 'input' }

        // Dedicated "网络" settings section — the primary configuration
        // surface. Registered unconditionally: the page renders its own
        // load/save error states when the host route is absent.
        var Section = NetworkSection(react, ui, localeRef)
        scope.slots.inject('settings.section', function* () {
          yield scope.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-network',
              order: 25,
              label: function () { return labelText(localeRef, 'en').nav },
              locale: 'dsh-network',
            },
            Section,
          )
        })

        // Probe first: if the host route does not exist (a headless profile,
        // or someone disabled the settings route), stay silent on the
        // Plugins-tab card and the block renderers.
        fetch('/dsh-network/config').then(function (response) {
          if (response.status === 404) return { found: false, value: null }
          // Read the summary once: it gates the search panel (the panel's
          // backend route follows the web_search tool's kill-switch) while
          // the card below registers regardless. An unreadable summary must
          // NOT hide the card — only the panel needs the live value.
          return response.json().then(function (body) {
            return { found: true, value: body && body.value ? body.value : null }
          }).catch(function () { return { found: true, value: null } })
        }).then(function (probe) {
          if (!probe || !probe.found) return
          try {
            // ── sidebar "网络搜索" panel ──
            // sidebar.panellist (rail icon row) + layout `main` (the page the
            // id opens) — the exact protocol the built-in plugins (order 0)
            // and schedules (order 10) panels use. The panel drives the
            // host's /dsh-network/search route, so it mounts only when the
            // host plugin is present and the web_search tool is not switched
            // off in 网络 → 工具. A failed registration must never take the
            // rest of the plugin half down, hence the per-slot try/catch.
            if (!probe.value || probe.value.webSearchTool !== false) {
              var PanelIcon = SearchPanelIcon(react, ui)
              var SearchPanel = SearchPanelPage(react, ui, localeRef)
              scope.slots.inject('sidebar.panellist', function* () {
                try {
                  yield scope.slots.register({
                    name: 'sidebar.panellist',
                    id: SEARCH_PANEL_ID,
                    order: 20, // plugins(0) · schedules(10) · 搜索(20)
                    label: function () { return labelText(localeRef, 'en').searchPanel },
                    locale: 'dsh-network',
                  }, PanelIcon)
                } catch (error) {
                  console.error('[dsh-network] sidebar panel icon not registered:', error)
                }
              })
              scope.slots.inject('main', function* () {
                try {
                  yield scope.slots.register({
                    name: 'main',
                    id: SEARCH_PANEL_ID,
                    key: SEARCH_PANEL_ID,
                    locale: 'dsh-network',
                  }, SearchPanel)
                } catch (error) {
                  console.error('[dsh-network] search panel not registered:', error)
                }
              })
            }

            var Card = ConfigCard(react, ui, localeRef)
            scope.slots.inject('settings.plugin.item', function* () {
              yield scope.slots.register(
                { name: 'settings.plugin.item', id: 'dsh-network', key: 'dsh-network', order: 32, locale: 'dsh-network' },
                Card,
              )
            })

            // Dedicated block renderers — register under tool.web slots when
            // exposed. Older dsh versions lack them; the listeners still bind
            // safely because they're guarded.
            var SearchBlock = Renderer(react, ui)
            var FetchBlock = FetchBlockRenderer(react, ui)
            scope.slots.inject('tool.web.item', function* () {
              yield scope.slots.register(
                { name: 'tool.web.item', id: 'dsh-network', key: 'dsh-network' },
                SearchBlock,
              )
            })
            scope.slots.inject('tool.web.fetch.item', function* () {
              yield scope.slots.register(
                { name: 'tool.web.fetch.item', id: 'dsh-network', key: 'dsh-network' },
                FetchBlock,
              )
            })

            // dsh 0.2.x replaced the tool.web.* slots with a single
            // `tool.call.toolview` slot keyed by tool name. It is a KEYED slot:
            // one cell per key, only the lowest-priority live entry of a cell
            // renders (the rest are shadowed), and re-registering a key at a
            // priority that is already taken THROWS. dsh claims `web_search`
            // at the default priority 0, so we claim a lower number to shadow
            // it — and a failure here must never take the rest of the plugin
            // half down with it. `web_fetch` deliberately stays untouched: it
            // already has a perfectly serviceable native row, and the
            // older-dsh block renderer (`FetchBlockRenderer` above) carries
            // any chrome we used to add.
            var SearchRow = SearchToolview(react, ui, localeRef)
            var HttpRow = HttpRequestToolview(react, ui, localeRef)
            var SitemapRow = WebSitemapToolview(react, ui, localeRef)
            scope.slots.inject('tool.call.toolview', function* () {
              try {
                yield scope.slots.register(
                  { name: 'tool.call.toolview', id: 'dsh-network', key: 'web_search', priority: WEB_SEARCH_ROW_PRIORITY, locale: 'dsh-network' },
                  SearchRow,
                )
              } catch (error) {
                console.error('[dsh-network] search toolview not registered:', error)
              }
              try {
                yield scope.slots.register(
                  { name: 'tool.call.toolview', id: 'dsh-network', key: 'http_request', priority: HTTP_REQUEST_ROW_PRIORITY, locale: 'dsh-network' },
                  HttpRow,
                )
              } catch (error) {
                console.error('[dsh-network] http_request toolview not registered:', error)
              }
              try {
                yield scope.slots.register(
                  { name: 'tool.call.toolview', id: 'dsh-network', key: 'web_sitemap', priority: WEB_SITEMAP_ROW_PRIORITY, locale: 'dsh-network' },
                  SitemapRow,
                )
              } catch (error) {
                console.error('[dsh-network] web_sitemap toolview not registered:', error)
              }
            })
          } catch (error) {
            console.error('[dsh-network] plugin card skipped:', error)
          }
        }).catch(function () { /* host route absent: nothing to wire */ })
      })
    }

    exports.apply = apply
    // Exposed for tests only; not part of the plugin contract.
    exports.__card = {
      ConfigCard: ConfigCard,
      Renderer: Renderer,
      FetchBlockRenderer: FetchBlockRenderer,
      SearchToolview: SearchToolview,
      HttpRequestToolview: HttpRequestToolview,
      WebSitemapToolview: WebSitemapToolview,
      NetworkSection: NetworkSection,
      RenderNetworkPage: RenderNetworkPage,
      EngineDialog: EngineDialog,
      AddEngineDialog: AddEngineDialog,
      SearchPanelPage: SearchPanelPage,
      SearchPanelIcon: SearchPanelIcon,
      SEARCH_PANEL_ID: SEARCH_PANEL_ID,
      WEB_SEARCH_ROW_PRIORITY: WEB_SEARCH_ROW_PRIORITY,
      HTTP_REQUEST_ROW_PRIORITY: HTTP_REQUEST_ROW_PRIORITY,
      WEB_SITEMAP_ROW_PRIORITY: WEB_SITEMAP_ROW_PRIORITY,
    }
    // Slots are optional; never declare them as a hard inject.
    exports.inject = []
    return module.exports
  },
})