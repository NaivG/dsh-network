/* dsh-web browser half for dsh-network — ENTRY.
 *
 * This file is the lazy-CJS factory dsh's module loader registers (id =
 * package name, zero build step, zero-dependency on the wire). It owns the
 * SHARED surface the four plugin surfaces are built from:
 *
 *   - the engine constants (chain + labels) and the i18n dictionaries,
 *     registered with the locale service so every surface re-labels on
 *     language switch;
 *   - the config API helpers (fetchConfig / putConfig / fetchHealth) that
 *     talk to the host plugin's /dsh-network/* loopback routes;
 *   - the STYLES fragment table mirroring dsh's built-in settings look;
 *   - the settings-sidebar nav icon decoration (DOM patch, feature-guarded);
 *   - apply(ctx), which loads the surfaces from package-local CHUNKS via
 *     the loader's official require.async protocol and registers them.
 *
 * The chunks sit next to this file and match the loader's `client.<name>.js`
 * naming, so the dsh host serves each one on demand at
 * /plugins/dsh-network/client.<name>.js?rev=… with no configuration:
 *
 *   client.settings.js     "网络" settings section + legacy Plugins-tab card
 *   client.toolviews.js    tool.call.toolview rows + legacy block renderers
 *   client.searchpanel.js  sidebar search panel (sidebar.panellist + main)
 *
 * Chunk rules (see @deepseek-ai/dsh-client-modules): a chunk must be
 * SELF-CONTAINED — it may require seed words (react) and this entry
 * (require('dsh-network'), always materialized before a chunk runs) but
 * never another chunk. This file exports exactly that shared surface.
 * Revisions derive from the ENTRY file's mtime/ctime/size, so after
 * editing a chunk, touch dsh/client.js (or reinstall) to bump the rev —
 * otherwise the browser keeps serving the immutable-cached old chunk.
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

    // ────────────────────── apply ──────────────────────
    // Wire the plugin into the dsh web shell. The surfaces live in the
    // package-local chunks, loaded here through require.async and
    // registered exactly as the single-file version did. A failed chunk
    // load must only cost its own surface, so each load is caught
    // separately; a failed REGISTRATION is caught where it always was.
    //
    // exports.__card (tests-only) and exports.__ready fill asynchronously
    // as the chunks materialize — the Node smoke test awaits __ready
    // before asserting against __card.
    var __card = {
      WEB_SEARCH_ROW_PRIORITY: WEB_SEARCH_ROW_PRIORITY,
      HTTP_REQUEST_ROW_PRIORITY: HTTP_REQUEST_ROW_PRIORITY,
      WEB_SITEMAP_ROW_PRIORITY: WEB_SITEMAP_ROW_PRIORITY,
    }
    function apply(ctx) {
      if (typeof ctx.inject !== 'function') return

      var navObserver = watchSettingsNavIcon()
      if (navObserver && typeof ctx.effect === 'function') {
        ctx.effect(function () { return function () { navObserver.disconnect() } }, 'dsh-network: settings nav icon')
      }

      var readyResolve
      var ready = new Promise(function (resolve) { readyResolve = resolve })
      function settleReady() { readyResolve() }
      exports.__ready = ready

      ctx.inject(['slots'], function (scope) {
        try {
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
            settleReady()
            return
          }
          var ui = tryRequire('@deepseek-ai/dsh-client-ui-primitives') || { Input: 'input' }

          // Package-local chunk loader. require.async('./client.<name>.js')
          // is the loader's official chunk request (what a bundler's dynamic
          // import compiles to): the file must live next to this entry,
          // match the client.<name>.js naming, and register itself with a
          // `chunk` field via __ModuleLoader__.load.
          function loadChunk(spec, what) {
            if (typeof require.async !== 'function') {
              return Promise.reject(new Error('require.async is unavailable in this dsh build; cannot load ' + what))
            }
            return require.async(spec)
          }

          // ── dedicated "网络" settings section — the primary configuration
          // surface. Registered unconditionally: the page renders its own
          // load/save error states when the host route is absent.
          var settingsChunk = loadChunk('./client.settings.js', 'the settings surfaces')
          var settingsWork = settingsChunk.then(function (settings) {
            __card.NetworkSection = settings.NetworkSection
            __card.RenderNetworkPage = settings.RenderNetworkPage
            __card.EngineDialog = settings.EngineDialog
            __card.AddEngineDialog = settings.AddEngineDialog
            __card.ConfigCard = settings.ConfigCard
            var Section = settings.NetworkSection(react, ui, localeRef)
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
          }).catch(function (error) {
            console.error('[dsh-network] settings section skipped:', error)
          })

          // ── probe-gated surfaces: Plugins-tab card, block renderers,
          // toolview rows, sidebar search panel. Probe first: if the host
          // route does not exist (a headless profile, or someone disabled
          // the settings route), stay silent. An unreadable summary must
          // NOT hide the card — only the panel needs the live value.
          var restWork = fetch('/dsh-network/config').then(function (response) {
            if (response.status === 404) return { found: false, value: null }
            return response.json().then(function (body) {
              return { found: true, value: body && body.value ? body.value : null }
            }).catch(function () { return { found: true, value: null } })
          }).then(function (probe) {
            if (!probe || !probe.found) return
            // The panel's backend route follows the web_search tool's
            // kill-switch, so its chunk loads only when the tool is on.
            var panelEnabled = !probe.value || probe.value.webSearchTool !== false
            var panelChunk = panelEnabled
              ? loadChunk('./client.searchpanel.js', 'the sidebar search panel')
              : null
            var viewsChunk = loadChunk('./client.toolviews.js', 'the card renderers')
            var loads = panelChunk ? [settingsChunk, viewsChunk, panelChunk] : [settingsChunk, viewsChunk]
            return Promise.all(loads).then(function (loaded) {
              var settings = loaded[0]
              var views = loaded[1]
              var panel = panelChunk ? loaded[2] : null
              __card.Renderer = views.Renderer
              __card.FetchBlockRenderer = views.FetchBlockRenderer
              __card.SearchToolview = views.SearchToolview
              __card.HttpRequestToolview = views.HttpRequestToolview
              __card.WebSitemapToolview = views.WebSitemapToolview
              try {
                // ── sidebar "网络搜索" panel ──
                // sidebar.panellist (rail icon row) + layout `main` (the page
                // the id opens) — the exact protocol the built-in plugins
                // (order 0) and schedules (order 10) panels use. The panel
                // drives the host's /dsh-network/search route, so it mounts
                // only when the host plugin is present and the web_search
                // tool is not switched off in 网络 → 工具. A failed
                // registration must never take the rest of the plugin half
                // down, hence the per-slot try/catch.
                if (panel) {
                  __card.SearchPanelPage = panel.SearchPanelPage
                  __card.SearchPanelIcon = panel.SearchPanelIcon
                  __card.SEARCH_PANEL_ID = panel.SEARCH_PANEL_ID
                  var PanelIcon = panel.SearchPanelIcon(react, ui)
                  var SearchPanel = panel.SearchPanelPage(react, ui, localeRef)
                  scope.slots.inject('sidebar.panellist', function* () {
                    try {
                      yield scope.slots.register({
                        name: 'sidebar.panellist',
                        id: panel.SEARCH_PANEL_ID,
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
                        id: panel.SEARCH_PANEL_ID,
                        key: panel.SEARCH_PANEL_ID,
                        locale: 'dsh-network',
                      }, SearchPanel)
                    } catch (error) {
                      console.error('[dsh-network] search panel not registered:', error)
                    }
                  })
                }

                var Card = settings.ConfigCard(react, ui, localeRef)
                scope.slots.inject('settings.plugin.item', function* () {
                  yield scope.slots.register(
                    { name: 'settings.plugin.item', id: 'dsh-network', key: 'dsh-network', order: 32, locale: 'dsh-network' },
                    Card,
                  )
                })

                // Dedicated block renderers — register under tool.web slots
                // when exposed. Older dsh versions lack them; the listeners
                // still bind safely because they're guarded.
                var SearchBlock = views.Renderer(react, ui)
                var FetchBlock = views.FetchBlockRenderer(react, ui)
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
                // `tool.call.toolview` slot keyed by tool name. It is a KEYED
                // slot: one cell per key, only the lowest-priority live entry
                // of a cell renders (the rest are shadowed), and
                // re-registering a key at a priority that is already taken
                // THROWS. dsh claims `web_search` at the default priority 0,
                // so we claim a lower number to shadow it — and a failure
                // here must never take the rest of the plugin half down with
                // it. `web_fetch` deliberately stays untouched: it already
                // has a perfectly serviceable native row, and the older-dsh
                // block renderer (FetchBlockRenderer above) carries any
                // chrome we used to add.
                var SearchRow = views.SearchToolview(react, ui, localeRef)
                var HttpRow = views.HttpRequestToolview(react, ui, localeRef)
                var SitemapRow = views.WebSitemapToolview(react, ui, localeRef)
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
            }).catch(function (error) {
              console.error('[dsh-network] card surfaces skipped:', error && error.message ? error.message : error)
            })
          }).catch(function () { /* host route absent: nothing to wire */ })

          Promise.all([settingsWork, restWork]).then(settleReady, function (error) {
            console.error('[dsh-network] bootstrap failed:', error)
            settleReady()
          })
        } catch (error) {
          console.error('[dsh-network] bootstrap failed:', error)
          settleReady()
        }
      })
    }

    // ────────────────────── module contract ──────────────────────
    exports.apply = apply
    // Chunk-shared surface: the chunks run require('dsh-network') and read
    // exactly these members (plus DICTS indirectly through labelText).
    exports.labelText = labelText
    exports.noteFrom = noteFrom
    exports.fetchConfig = fetchConfig
    exports.putConfig = putConfig
    exports.fetchHealth = fetchHealth
    exports.STYLES = STYLES
    exports.ENGINES = ENGINES
    exports.ENGINE_LABELS = ENGINE_LABELS
    // Exposed for tests only; not part of the plugin contract. The priority
    // constants live in the entry because the toolview registration uses
    // them; the component builders fill in as their chunks materialize.
    exports.__card = __card
    // Set per-apply() to the bootstrap promise (resolves once every chunk
    // load settled, successfully or not); resolved by default so callers
    // that never apply() still have a thenable.
    exports.__ready = Promise.resolve()
    // Slots are optional; never declare them as a hard inject.
    exports.inject = []
    return module.exports

  },
})
