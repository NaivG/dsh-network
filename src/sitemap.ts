/**
 * dsh-network web_sitemap — a curated, structured catalog of common
 * portals the LLM should prefer over generic search engines.
 *
 * Why this exists
 * ---------------
 * `web_search` blasts the query into a generic crawler (Bing / DDG / Baidu)
 * and the model has to guess which of the 10 blue links is authoritative.
 * For most research-style questions the model already knows the right
 * domain (arxiv for preprints, crates.io for Rust packages, MDN for web
 * platform reference, …) but it cannot write a site: query with enough
 * precision to skip the noise.
 *
 * `web_sitemap` is the bridge: a frozen table the model (or the host) can
 * query through this CLI to learn
 *
 *   - which authoritative domain fits a topic
 *   - the canonical search-URL template (filled in by `buildSearchUrl`)
 *   - the canonical path patterns (`pathHints`, used to construct a
 *     direct URL like `github.com/{owner}/{repo}` when the model already
 *     knows the slug)
 *
 * Design rules
 * ------------
 *   - Pure module. No I/O, no clock, no network — bundling with the CLI
 *     stays cheap and the data is unit-testable.
 *   - Domain is the primary key, lowercase, no scheme/path. `www.` is
 *     stripped automatically (the canonical form omits it).
 *   - `description` is short and Chinese-leaning because that is the
 *     language the host ecosystem prefers; English synonyms live in
 *     `tags` so an English-keyed fuzzy match still finds the entry.
 *   - `priority` is 1..10. 10 = always-use, 9 = top of category, 8 =
 *     solid alternative, 7 = solid but narrower, 6 = niche/trustworthy,
 *     5 = regional/specialized.
 *   - Adding a new entry is a one-line change; do not invent new
 *     categories without a good reason (prefer reusing the existing
 *     vocabulary below).
 *
 * Categories (the closed set the model can rely on)
 * ------------------------------------------------
 *   - code-repos          Git hosts (github.com, gitlab.com, …)
 *   - code-search         Cross-repo code search
 *   - package-registries  npm, pypi, crates.io, …
 *   - qna                 Stack Overflow, Zhihu, SegmentFault, …
 *   - encyclopedia        Wikipedia, distro wikis
 *   - docs                Language/framework reference docs (MDN, devdocs)
 *   - manuals             Vendor product docs (AWS, GCP, Azure, K8s, …)
 *   - standards           W3C, IETF, ISO, WHATWG, TC39, Unicode, …
 *   - news                Wire & general news
 *   - tech-news           Tech press (Ars, Verge, 36Kr, …)
 *   - academic            Preprints & paper indexes (arxiv, scholar, …)
 *   - ai-platforms        AI companies / labs / model hubs
 *   - datasets            Dataset / competition hubs (Kaggle, HF datasets)
 *   - devops              Cloud / infra / monitoring docs & consoles
 *   - government          Official government portals
 *   - search              General search engines
 *   - social              Social networks & communities
 *   - video               Video platforms
 *   - music               Music streaming
 *   - maps                Map services
 *   - shopping            E-commerce
 *   - finance             Markets & quotes
 *   - forum               Niche forums / boards
 *
 * New categories should be added sparingly. When unsure, prefer reusing
 * `docs` / `manuals` rather than coining `vendor-docs`.
 */

/* ─────────────────────────────── types ─────────────────────────────── */

export const WEB_SITEMAP_CATEGORIES = [
  'code-repos',
  'code-search',
  'package-registries',
  'qna',
  'encyclopedia',
  'docs',
  'manuals',
  'standards',
  'news',
  'tech-news',
  'academic',
  'ai-platforms',
  'datasets',
  'devops',
  'government',
  'search',
  'social',
  'video',
  'music',
  'maps',
  'shopping',
  'finance',
  'forum',
] as const

export type WebSitemapCategory = (typeof WEB_SITEMAP_CATEGORIES)[number]

/** Language code (BCP-47-ish). `multi` means the portal is genuinely multilingual. */
export type WebSitemapLanguage =
  | 'multi'
  | 'en'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'ru'
  | 'de'
  | 'fr'
  | 'es'
  | 'pt'

/** Geographic scope. `global` = region-agnostic. */
export type WebSitemapRegion =
  | 'global'
  | 'CN'
  | 'US'
  | 'JP'
  | 'KR'
  | 'EU'
  | 'RU'
  | 'IN'

/**
 * One portal entry. The fields the model cares about most:
 *
 *   - `domain`            — primary key, lowercase, no `www.`
 *   - `description`       — one short Chinese sentence
 *   - `category`          — closed-set label (see top-of-file)
 *   - `priority`          — 1..10 (10 = always-use)
 *   - `searchUrl`         — optional URL template containing `{query}`
 *   - `pathHints`         — optional canonical path patterns
 *   - `tags`              — extra keywords (English + Chinese)
 *   - `language` / `region` — for region filters
 */
export interface WebSitemapEntry {
  /** Lowercase host without `www.` prefix. Example: `github.com`. */
  domain: string
  /** Short description, Chinese-leaning. Plain text. */
  description: string
  /** Closed-set category. */
  category: WebSitemapCategory
  /** 1..10. Higher = more universally useful. */
  priority: number
  /** Optional URL template with `{query}` placeholder. */
  searchUrl?: string
  /**
   * Optional canonical path templates the model can use to construct
   * direct URLs when it already knows the slug. Each pattern uses
   * `{name}` style placeholders (NOT real regex groups).
   */
  pathHints?: string[]
  /** Optional extra keywords (English + Chinese) used by `searchSitemap`. */
  tags?: string[]
  /** Primary language. Default `multi`. */
  language?: WebSitemapLanguage
  /** Geographic scope. Default `global`. */
  region?: WebSitemapRegion
  /**
   * Optional URL of a notes / changelog / status page. The host plugin
   * may use this when the model asks for "what changed recently" or
   * "is the service up" without a search round-trip.
   */
  notesUrl?: string
}

/* ─────────────────────────────── data ──────────────────────────────── */

/**
 * The curated table. Edit by adding/removing rows; preserve category
 * groupings and the `// ── category` separators so the file stays
 * scannable in code review.
 *
 * Ordering inside a category is descending by `priority` then alpha by
 * `domain` so the JSON dump and `list()` output are deterministic.
 */
export const WEB_SITEMAP: readonly WebSitemapEntry[] = Object.freeze([
  // ── search (default fallbacks the model can reach directly) ──
  { domain: 'google.com', description: '通用搜索引擎（全球最大索引）', category: 'search', priority: 10, searchUrl: `https://www.google.com/search?q={query}`, tags: ['search', 'google', '搜索引擎', '谷歌'] },
  { domain: 'bing.com', description: 'Microsoft Bing 通用搜索（中文质量较好）', category: 'search', priority: 9, searchUrl: `https://www.bing.com/search?q={query}`, tags: ['search', 'bing', '微软', '必应'] },
  { domain: 'duckduckgo.com', description: '隐私友好的通用搜索', category: 'search', priority: 8, searchUrl: `https://duckduckgo.com/?q={query}`, tags: ['search', 'duckduckgo', 'ddg', '隐私'] },
  { domain: 'brave.com', description: 'Brave Search（隐私友好）', category: 'search', priority: 5, searchUrl: `https://search.brave.com/search?q={query}`, tags: ['search', 'brave', '隐私'] },
  { domain: 'baidu.com', description: '百度中文搜索（中文网页首选）', category: 'search', priority: 9, searchUrl: `https://www.baidu.com/s?wd={query}`, tags: ['search', 'baidu', '百度', '中文'] },
  { domain: 'yandex.com', description: 'Yandex 俄文搜索（俄语资源首选）', category: 'search', priority: 7, searchUrl: `https://yandex.com/search/?text={query}`, language: 'ru', region: 'RU', tags: ['search', 'yandex', '俄语'] },
  { domain: 'sogou.com', description: '搜狗中文搜索（微信生态较全）', category: 'search', priority: 7, searchUrl: `https://www.sogou.com/web?query={query}`, region: 'CN', tags: ['search', 'sogou', '搜狗', '微信'] },
  { domain: 'so.com', description: '360 搜索（中文备选）', category: 'search', priority: 6, searchUrl: `https://www.so.com/s?q={query}`, region: 'CN', tags: ['search', '360', '中文'] },
  { domain: 'ecosia.org', description: '植树公益搜索', category: 'search', priority: 5, searchUrl: `https://www.ecosia.org/search?q={query}`, tags: ['search', 'eco', '公益'] },
  { domain: 'yahoo.com', description: '雅虎搜索（英文资源 preferred）', category: 'search', priority: 4, searchUrl: `https://search.yahoo.com/search?p={query}`, tags: ['search', 'yahoo', '英文'] },
  
  // ── encyclopedia ──
  { domain: 'wikipedia.org', description: '维基百科（多语言通用百科）', category: 'encyclopedia', priority: 10, searchUrl: `https://en.wikipedia.org/wiki/Special:Search?search={query}`, language: 'multi', tags: ['wiki', 'encyclopedia', '百科', 'wikipedia'] },
  { domain: 'zh.wikipedia.org', description: '中文维基百科', category: 'encyclopedia', priority: 9, searchUrl: `https://zh.wikipedia.org/wiki/Special:Search?search={query}`, language: 'zh', region: 'CN', tags: ['wiki', '百科', 'wikipedia zh'] },
  { domain: 'wiki.archlinux.org', description: 'Arch Linux Wiki（Linux 系统管理参考）', category: 'encyclopedia', priority: 8, searchUrl: `https://wiki.archlinux.org/index.php?search={query}`, tags: ['arch', 'linux', 'wiki', 'system administration'] },
  { domain: 'wiki.ubuntu.com', description: 'Ubuntu 官方 Wiki', category: 'encyclopedia', priority: 7, searchUrl: `https://wiki.ubuntu.com/?action=fullsearch&text={query}`, tags: ['ubuntu', 'linux', 'wiki'] },
  { domain: 'wiki.gentoo.org', description: 'Gentoo Wiki', category: 'encyclopedia', priority: 6, searchUrl: `https://wiki.gentoo.org/index.php?search={query}`, tags: ['gentoo', 'linux', 'wiki'] },
  { domain: 'wiki.debian.org', description: 'Debian Wiki', category: 'encyclopedia', priority: 5, searchUrl: `https://wiki.debian.org/FrontPage?action=fullsearch&value={query}`, tags: ['debian', 'linux', 'wiki'] },

  // ── code-repos ──
  { domain: 'github.com', description: 'Git 代码托管与协作平台（仓库 / Issue / PR / Actions）', category: 'code-repos', priority: 10, searchUrl: `https://github.com/search?q={query}&type=repositories`, language: 'multi', tags: ['git', 'github', '代码托管', '开源', 'open source', 'repo'], pathHints: [`/{owner}/{repo}`, `/{owner}/{repo}/blob/{branch}/{path}`, `/{owner}/{repo}/issues`, `/{owner}`] },
  { domain: 'gitlab.com', description: 'GitLab 自托管友好的代码托管平台', category: 'code-repos', priority: 8, searchUrl: `https://gitlab.com/search?search={query}`, tags: ['git', 'gitlab', '代码托管'], pathHints: [`/{owner}/{repo}`, `/{owner}/{repo}/-/blob/{branch}/{path}`] },
  { domain: 'bitbucket.org', description: 'Atlassian 旗下的 Git 托管', category: 'code-repos', priority: 6, searchUrl: `https://bitbucket.org/search?q={query}`, tags: ['git', 'bitbucket', 'atlassian'], pathHints: [`/{owner}/{repo}`] },
  { domain: 'gitee.com', description: '码云，国内 Git 代码托管', category: 'code-repos', priority: 7, searchUrl: `https://gitee.com/search?q={query}`, region: 'CN', tags: ['git', 'gitee', '码云', '国内'], pathHints: [`/{owner}/{repo}`] },

  // ── code-search ──
  { domain: 'sourcegraph.com', description: '跨仓库代码搜索（公开 + 私有代码洞察）', category: 'code-search', priority: 8, searchUrl: `https://sourcegraph.com/search?q={query}&patternType=keyword`, tags: ['code search', 'sourcegraph', '跨仓库'] },
  { domain: 'grep.app', description: '公开 GitHub 仓库的正则代码搜索', category: 'code-search', priority: 7, searchUrl: `https://grep.app/search?q={query}`, tags: ['code search', 'grep', 'regex'] },

  // ── package-registries ──
  { domain: 'npmjs.com', description: 'Node.js 包管理 registry', category: 'package-registries', priority: 9, searchUrl: `https://www.npmjs.com/search?q={query}`, tags: ['npm', 'node', 'javascript', '包管理'], pathHints: [`/package/{name}`] },
  { domain: 'pypi.org', description: 'Python Package Index', category: 'package-registries', priority: 9, searchUrl: `https://pypi.org/search/?q={query}`, tags: ['pypi', 'python', 'pip', '包管理'], pathHints: [`/project/{name}`] },
  { domain: 'crates.io', description: 'Rust 包管理 registry', category: 'package-registries', priority: 9, searchUrl: `https://crates.io/search?q={query}`, tags: ['crates', 'rust', 'cargo', '包管理'], pathHints: [`/crates/{name}`] },
  { domain: 'pkg.go.dev', description: 'Go 包管理与文档', category: 'package-registries', priority: 8, searchUrl: `https://pkg.go.dev/search?q={query}`, tags: ['go', 'golang', '包管理', 'godoc'], pathHints: [`/{module}`] },
  { domain: 'rubygems.org', description: 'Ruby 包管理', category: 'package-registries', priority: 7, searchUrl: `https://rubygems.org/search?query={query}`, tags: ['ruby', 'gem', '包管理'], pathHints: [`/gems/{name}`] },
  { domain: 'nuget.org', description: '.NET 包管理', category: 'package-registries', priority: 7, searchUrl: `https://www.nuget.org/packages?q={query}`, tags: ['nuget', 'dotnet', 'c#', 'csharp', '包管理'], pathHints: [`/packages/{name}`] },
  { domain: 'pub.dev', description: 'Dart / Flutter 包管理', category: 'package-registries', priority: 7, searchUrl: `https://pub.dev/packages?q={query}`, tags: ['pub', 'dart', 'flutter', '包管理'], pathHints: [`/packages/{name}`] },
  { domain: 'hex.pm', description: 'Elixir / Erlang 包管理', category: 'package-registries', priority: 6, searchUrl: `https://hex.pm/packages?search={query}`, tags: ['hex', 'elixir', 'erlang', '包管理'], pathHints: [`/packages/{name}`] },
  { domain: 'maven.org', description: 'Maven Central（Java 包管理）', category: 'package-registries', priority: 7, searchUrl: `https://central.sonatype.com/search?q={query}`, tags: ['maven', 'java', '包管理'], pathHints: [`/artifact/{group}/{artifact}`] },
  { domain: 'hub.docker.com', description: 'Docker 镜像仓库', category: 'package-registries', priority: 8, searchUrl: `https://hub.docker.com/search?q={query}`, tags: ['docker', 'container', '镜像', '镜像仓库'], pathHints: [`/r/{owner}/{name}`] },

  // ── qna ──
  { domain: 'stackoverflow.com', description: '英文编程问答社区', category: 'qna', priority: 10, searchUrl: `https://stackoverflow.com/search?q={query}`, tags: ['qa', 'stackoverflow', '问答', '编程问答'] },
  { domain: 'stackexchange.com', description: 'Stack Exchange 问答网络（含子站）', category: 'qna', priority: 8, searchUrl: `https://stackexchange.com/search?q={query}`, tags: ['qa', 'stackexchange', '问答'] },
  { domain: 'serverfault.com', description: '系统管理 / 服务器问答', category: 'qna', priority: 7, searchUrl: `https://serverfault.com/search?q={query}`, tags: ['qa', 'serverfault', 'sysadmin'] },
  { domain: 'superuser.com', description: '通用桌面 / 软件问答', category: 'qna', priority: 6, searchUrl: `https://superuser.com/search?q={query}`, tags: ['qa', 'superuser'] },
  { domain: 'zhihu.com', description: '知乎中文问答 / 讨论', category: 'qna', priority: 8, searchUrl: `https://www.zhihu.com/search?type=content&q={query}`, region: 'CN', tags: ['qa', 'zhihu', '知乎', '中文问答'] },
  { domain: 'segmentfault.com', description: '思否中文技术问答', category: 'qna', priority: 6, searchUrl: `https://segmentfault.com/search?q={query}`, region: 'CN', tags: ['qa', 'segmentfault', '思否', '中文问答'] },

  // ── docs (language/framework reference) ──
  { domain: 'developer.mozilla.org', description: 'MDN Web 文档（HTML/CSS/JS/Web API 参考）', category: 'docs', priority: 10, searchUrl: `https://developer.mozilla.org/en-US/search?q={query}`, tags: ['mdn', 'mozilla', 'web docs', '前端', 'html', 'css', 'javascript'], pathHints: [`/en-US/docs/{path}`] },
  { domain: 'devdocs.io', description: '聚合 API 文档（多语言）', category: 'docs', priority: 8, searchUrl: `https://devdocs.io/#q={query}`, tags: ['devdocs', 'api docs', '文档聚合'] },
  { domain: 'rust-lang.org', description: 'Rust 官方文档（The Book / std / Cargo）', category: 'docs', priority: 9, searchUrl: `https://doc.rust-lang.org/search.html?q={query}`, tags: ['rust', 'cargo', 'rustdoc'], pathHints: [`/std/{module}`, `/book/{chapter}`] },
  { domain: 'go.dev', description: 'Go 官方文档（教程 / 规范 / 包）', category: 'docs', priority: 8, searchUrl: `https://go.dev/search?q={query}`, tags: ['go', 'golang'] },
  { domain: 'kotlinlang.org', description: 'Kotlin 官方文档', category: 'docs', priority: 7, searchUrl: `https://kotlinlang.org/docs/?q={query}`, tags: ['kotlin', 'jetbrains'] },
  { domain: 'swift.org', description: 'Swift 官方文档', category: 'docs', priority: 7, searchUrl: `https://www.swift.org/documentation/?q={query}`, tags: ['swift', 'apple'] },
  { domain: 'typescriptlang.org', description: 'TypeScript 官方文档', category: 'docs', priority: 8, searchUrl: `https://www.typescriptlang.org/docs/?search={query}`, tags: ['typescript', 'ts', '微软'] },
  { domain: 'learn.microsoft.com', description: 'Microsoft Learn（.NET / Azure / M365 等官方文档）', category: 'docs', priority: 9, searchUrl: `https://learn.microsoft.com/en-us/search/?terms={query}`, tags: ['microsoft', 'dotnet', 'azure', 'mslearn'], pathHints: [`/en-us/{path}`] },
  { domain: 'docs.oracle.com', description: 'Oracle 官方文档（Java / DB）', category: 'docs', priority: 7, searchUrl: `https://docs.oracle.com/en/search/#q={query}`, tags: ['oracle', 'java', '数据库'] },
  { domain: 'docs.python.org', description: 'Python 官方文档', category: 'docs', priority: 9, searchUrl: `https://docs.python.org/3/search.html?q={query}`, tags: ['python', 'cpython'] },
  { domain: 'dart.dev', description: 'Dart 官方文档', category: 'docs', priority: 7, searchUrl: `https://dart.dev/search?q={query}`, tags: ['dart', 'flutter'] },
  { domain: 'docs.flutter.dev', description: 'Flutter 官方文档', category: 'docs', priority: 8, searchUrl: `https://docs.flutter.dev/search?q={query}`, tags: ['flutter', 'dart'] },
  { domain: 'api.flutter.dev', description: 'Flutter API 文档', category: 'docs', priority: 9, searchUrl: `https://api.flutter.dev/search?q={query}`, tags: ['flutter', 'dart'] },
  { domain: 'doc.openvela.com', description: 'OpenVela 官方文档', category: 'docs', priority: 8, searchUrl: `https://doc.openvela.com/search?keywords={query}`, tags: ['openvela', 'vela'] },
  { domain: 'iot.mi.com', description: '小米 IoT 开发者平台', category: 'docs', priority: 8, tags: ['vela', 'iot', '快应用', 'xiaomi'] },

  // ── manuals (product / vendor docs) ──
  { domain: 'docs.aws.amazon.com', description: 'AWS 官方文档', category: 'manuals', priority: 9, searchUrl: `https://docs.aws.amazon.com/search/doc-search.html?searchPath=documentation&searchQuery={query}`, tags: ['aws', 'amazon', 'cloud'], pathHints: [`/{service}/latest/{path}`] },
  { domain: 'cloud.google.com', description: 'Google Cloud 官方文档', category: 'manuals', priority: 8, searchUrl: `https://cloud.google.com/s/results?q={query}`, tags: ['gcp', 'google cloud'] },
  { domain: 'kubernetes.io', description: 'Kubernetes 官方文档', category: 'manuals', priority: 9, searchUrl: `https://kubernetes.io/docs/search/?q={query}`, tags: ['k8s', 'kubernetes'], pathHints: [`/docs/{path}`] },
  { domain: 'postgresql.org', description: 'PostgreSQL 官方文档', category: 'manuals', priority: 8, searchUrl: `https://www.postgresql.org/search/?q={query}`, tags: ['postgres', 'postgresql', '数据库'], pathHints: [`/docs/{version}/{path}`] },
  { domain: 'dev.mysql.com', description: 'MySQL 官方文档', category: 'manuals', priority: 7, searchUrl: `https://dev.mysql.com/doc/search/?q={query}`, tags: ['mysql', '数据库'] },
  { domain: 'redis.io', description: 'Redis 官方文档', category: 'manuals', priority: 7, searchUrl: `https://redis.io/search/?q={query}`, tags: ['redis', '缓存', '数据库'] },
  { domain: 'elastic.co', description: 'Elasticsearch / Observability 文档', category: 'manuals', priority: 7, searchUrl: `https://www.elastic.co/search?q={query}`, tags: ['elasticsearch', 'elastic', '日志'] },
  { domain: 'nginx.org', description: 'Nginx 官方文档', category: 'manuals', priority: 6, searchUrl: `https://nginx.org/en/docs/?q={query}`, tags: ['nginx', 'web server'] },
  { domain: 'httpd.apache.org', description: 'Apache HTTP Server 文档', category: 'manuals', priority: 5, searchUrl: `https://httpd.apache.org/docs/?q={query}`, tags: ['apache', 'httpd', 'web server'] },
  { domain: 'docker.com', description: 'Docker 官方文档', category: 'manuals', priority: 8, searchUrl: `https://docs.docker.com/search/?q={query}`, tags: ['docker', 'container'] },
  { domain: 'docs.github.com', description: 'GitHub 平台文档（API / Actions / Apps）', category: 'manuals', priority: 8, searchUrl: `https://docs.github.com/en/search?query={query}`, tags: ['github', 'actions', 'api'] },

  // ── standards ──
  { domain: 'w3.org', description: 'W3C Web 标准', category: 'standards', priority: 9, tags: ['w3c', 'standards', 'web standards', '标准'], pathHints: [`/TR/{spec}`] },
  { domain: 'datatracker.ietf.org', description: 'IETF 文档与 RFC 索引', category: 'standards', priority: 9, searchUrl: `https://datatracker.ietf.org/search/?q={query}`, tags: ['ietf', 'rfc', 'standards'], pathHints: [`/doc/{rfc}`, `/doc/html/{slug}`] },
  { domain: 'iso.org', description: 'ISO 国际标准', category: 'standards', priority: 7, searchUrl: `https://www.iso.org/search.html?q={query}`, tags: ['iso', 'standards'] },
  { domain: 'whatwg.org', description: 'WHATWG HTML / DOM / Fetch 标准', category: 'standards', priority: 8, tags: ['whatwg', 'html', 'dom', 'fetch'] },
  { domain: 'tc39.es', description: 'TC39 ECMAScript 提案', category: 'standards', priority: 7, tags: ['tc39', 'ecmascript', 'javascript'] },
  { domain: 'unicode.org', description: 'Unicode 标准', category: 'standards', priority: 7, searchUrl: `https://www.unicode.org/search/?q={query}`, tags: ['unicode', 'utf-8', '字符集'] },
  { domain: 'ecma-international.org', description: 'Ecma 国际标准（ECMAScript 等）', category: 'standards', priority: 6, tags: ['ecma', 'ecmascript'] },

  // ── news (wire / general) ──
  { domain: 'reuters.com', description: '路透社国际新闻', category: 'news', priority: 8, searchUrl: `https://www.reuters.com/search/?query={query}`, language: 'en', tags: ['news', 'reuters', '路透', '国际新闻'] },
  { domain: 'bbc.com', description: 'BBC 国际新闻', category: 'news', priority: 8, searchUrl: `https://www.bbc.co.uk/search?q={query}`, language: 'en', tags: ['news', 'bbc', '英国'] },
  { domain: 'nytimes.com', description: '纽约时报', category: 'news', priority: 7, searchUrl: `https://www.nytimes.com/search?query={query}`, language: 'en', tags: ['news', 'nytimes', '美国'] },
  { domain: 'theguardian.com', description: '卫报（英国）', category: 'news', priority: 7, searchUrl: `https://www.theguardian.com/search?q={query}`, language: 'en', tags: ['news', 'guardian', '英国'] },
  { domain: 'bloomberg.com', description: '彭博商业 / 财经新闻', category: 'news', priority: 8, searchUrl: `https://www.bloomberg.com/search?query={query}`, language: 'en', tags: ['news', 'bloomberg', '财经'] },

  // ── tech-news ──
  { domain: 'arstechnica.com', description: 'Ars Technica 科技媒体', category: 'tech-news', priority: 8, searchUrl: `https://arstechnica.com/search/?query={query}`, language: 'en', tags: ['tech news', 'ars', 'arstechnica'] },
  { domain: 'techcrunch.com', description: 'TechCrunch 创投 / 科技', category: 'tech-news', priority: 7, searchUrl: `https://techcrunch.com/?s={query}`, language: 'en', tags: ['tech news', 'techcrunch', 'startup'] },
  { domain: 'theverge.com', description: 'The Verge 科技 / 消费电子', category: 'tech-news', priority: 7, searchUrl: `https://www.theverge.com/search?q={query}`, language: 'en', tags: ['tech news', 'verge', 'consumer'] },
  { domain: 'wired.com', description: 'Wired 科技文化', category: 'tech-news', priority: 6, searchUrl: `https://www.wired.com/search/?q={query}`, language: 'en', tags: ['tech news', 'wired'] },
  { domain: '36kr.com', description: '36氪 中文创投 / 科技', category: 'tech-news', priority: 7, searchUrl: `https://36kr.com/search/articles/{query}`, region: 'CN', tags: ['tech news', '36kr', '36氪', '中文科技'] },
  { domain: 'huxiu.com', description: '虎嗅 中文商业 / 科技', category: 'tech-news', priority: 7, searchUrl: `https://www.huxiu.com/search/?keyword={query}`, region: 'CN', tags: ['tech news', 'huxiu', '虎嗅', '中文'] },
  { domain: 'sspai.com', description: '少数派 中文效率工具 / 数字生活', category: 'tech-news', priority: 7, searchUrl: `https://sspai.com/search?query={query}`, region: 'CN', tags: ['tech', '少数派', '效率', '中文'] },
  { domain: 'ithome.com', description: 'IT之家 中文 IT 新闻', category: 'tech-news', priority: 6, searchUrl: `https://www.ithome.com/search/?q={query}`, region: 'CN', tags: ['tech news', 'ithome', 'IT之家', '中文'] },

  // ── academic ──
  { domain: 'arxiv.org', description: 'arXiv 预印本（CS / 物理 / 数学）', category: 'academic', priority: 10, searchUrl: `https://arxiv.org/search/?query={query}&searchtype=all`, language: 'en', tags: ['arxiv', 'preprint', '论文', 'preprint'], pathHints: [`/abs/{id}`, `/pdf/{id}`] },
  { domain: 'scholar.google.com', description: '谷歌学术', category: 'academic', priority: 9, searchUrl: `https://scholar.google.com/scholar?q={query}`, language: 'en', tags: ['scholar', '学术', '谷歌学术'] },
  { domain: 'semanticscholar.org', description: 'Semantic Scholar 学术搜索', category: 'academic', priority: 8, searchUrl: `https://www.semanticscholar.org/search?q={query}`, language: 'en', tags: ['semantic scholar', '学术'] },
  { domain: 'pubmed.ncbi.nlm.nih.gov', description: 'PubMed 生物医学文献', category: 'academic', priority: 8, searchUrl: `https://pubmed.ncbi.nlm.nih.gov/?term={query}`, language: 'en', tags: ['pubmed', '生物医学', '医学'] },
  { domain: 'dl.acm.org', description: 'ACM 数字图书馆', category: 'academic', priority: 7, searchUrl: `https://dl.acm.org/search?q={query}`, language: 'en', tags: ['acm', '论文', 'cs'] },
  { domain: 'ieeexplore.ieee.org', description: 'IEEE Xplore', category: 'academic', priority: 7, searchUrl: `https://ieeexplore.ieee.org/search/searchresult.jsp?queryText={query}`, language: 'en', tags: ['ieee', '论文', '电气工程'] },
  { domain: 'nature.com', description: 'Nature 期刊', category: 'academic', priority: 7, searchUrl: `https://www.nature.com/search?q={query}`, language: 'en', tags: ['nature', '论文'] },
  { domain: 'sciencedirect.com', description: 'ScienceDirect（Elsevier 期刊）', category: 'academic', priority: 6, searchUrl: `https://www.sciencedirect.com/search?qs={query}`, language: 'en', tags: ['sciencedirect', 'elsevier', '论文'] },
  { domain: 'springer.com', description: 'Springer 期刊', category: 'academic', priority: 6, searchUrl: `https://link.springer.com/search?q={query}`, language: 'en', tags: ['springer', '论文'] },
  { domain: 'shitjournal.org', description: 'S.H.*.T 期刊', category: 'academic', priority: 6, searchUrl: `https://shitjournal.org/search?q={query}`, language: 'zh', tags: ['shitjournal', 'shit', 'S.H.*.T', '中文', 'bullshit'] },

  // ── ai-platforms ──
  { domain: 'openai.com', description: 'OpenAI 官方（GPT / DALL·E / Sora）', category: 'ai-platforms', priority: 9, language: 'en', tags: ['openai', 'gpt', 'llm', 'ai'], pathHints: ['/index/{model}'] },
  { domain: 'platform.openai.com', description: 'OpenAI 平台文档与 API 参考', category: 'ai-platforms', priority: 9, searchUrl: `https://platform.openai.com/search/?q={query}`, language: 'en', tags: ['openai', 'api docs', 'gpt', 'llm'] },
  { domain: 'anthropic.com', description: 'Anthropic 官方（Claude）', category: 'ai-platforms', priority: 9, language: 'en', tags: ['anthropic', 'claude', 'llm', 'ai'] },
  { domain: 'docs.anthropic.com', description: 'Anthropic Claude API 文档', category: 'ai-platforms', priority: 9, searchUrl: `https://docs.anthropic.com/en/search?q={query}`, language: 'en', tags: ['anthropic', 'claude', 'api docs'] },
  { domain: 'deepseek.com', description: 'DeepSeek 官方', category: 'ai-platforms', priority: 8, region: 'CN', tags: ['deepseek', 'llm', '深度求索', 'ai'] },
  { domain: 'api-docs.deepseek.com', description: 'DeepSeek API 文档', category: 'ai-platforms', priority: 8, searchUrl: `https://api-docs.deepseek.com/web/?q={query}`, region: 'CN', tags: ['deepseek', 'api docs'] },
  { domain: 'www.kimi.com', description: 'Kimi 官方', category: 'ai-platforms', priority: 8, language: 'en', tags: ['kimi', 'llm', 'ai'] },
  { domain: 'www.qianwen.com', description: '千问 官方', category: 'ai-platforms', priority: 8, language: 'zh', tags: ['qianwen', 'llm', 'ai'] },
  { domain: 'z.ai', description: 'Z.AI 智谱官方', category: 'ai-platforms', priority: 8, language: 'zh', tags: ['glm', 'llm', 'ai'] },
  { domain: 'minimax.cn', description: 'Minimax 官方', category: 'ai-platforms', priority: 8, language: 'zh', tags: ['minimax', 'llm', 'ai'] },
  { domain: 'www.minimax.io', description: 'Minimax 海外站', category: 'ai-platforms', priority: 7, language: 'en', tags: ['minimax', 'llm', 'ai'] },
  { domain: 'www.doubao.com', description: '豆包 官方', category: 'ai-platforms', priority: 7, region: 'CN', tags: ['doubao', 'llm', 'ai'] },
  { domain: 'huggingface.co', description: 'Hugging Face 模型 / 数据集 / Spaces', category: 'ai-platforms', priority: 10, searchUrl: `https://huggingface.co/models?search={query}`, language: 'multi', tags: ['huggingface', 'hf', '模型', 'datasets'], pathHints: [`/{owner}/{model}`, `/datasets/{owner}/{dataset}`, `/spaces/{owner}/{space}`] },
  { domain: 'hf-mirror.com', description: 'Hugging Face 镜像站', category: 'ai-platforms', priority: 8, searchUrl: `https://hf-mirror.com/models?search={query}`, region: 'CN', tags: ['huggingface', 'hf', '模型', 'datasets'], pathHints: [`/{owner}/{model}`, `/datasets/{owner}/{dataset}`, `/spaces/{owner}/{space}`] },
  { domain: 'modelscope.cn', description: 'ModelScope 模型', category: 'ai-platforms', priority: 8, searchUrl: `https://modelscope.cn/search?q={query}`, region: 'CN', tags: ['modelscope', '模型', '深度学习']},
  { domain: 'paperswithcode.com', description: '论文 + 代码实现', category: 'ai-platforms', priority: 8, searchUrl: `https://paperswithcode.com/search?q={query}`, language: 'en', tags: ['papers with code', '论文', 'ml'] },
  { domain: 'kaggle.com', description: 'Kaggle 数据集 / 比赛 / 笔记本', category: 'ai-platforms', priority: 8, searchUrl: `https://www.kaggle.com/search?q={query}`, language: 'en', tags: ['kaggle', '数据集', 'datasets', 'competition'], pathHints: [`/{owner}/{dataset}`, `/{owner}/{competition}`] },
  { domain: 'colab.research.google.com', description: 'Google Colab 笔记本环境', category: 'ai-platforms', priority: 7, language: 'en', tags: ['colab', 'jupyter', 'notebook'] },
  { domain: 'pytorch.org', description: 'PyTorch 官方文档', category: 'ai-platforms', priority: 8, searchUrl: `https://pytorch.org/docs/stable/search.html?q={query}`, language: 'en', tags: ['pytorch', '深度学习', 'deep learning'] },
  { domain: 'tensorflow.org', description: 'TensorFlow 官方文档', category: 'ai-platforms', priority: 7, language: 'en', tags: ['tensorflow', '深度学习'] },
  { domain: 'langchain.com', description: 'LangChain 官方', category: 'ai-platforms', priority: 7, searchUrl: `https://python.langchain.com/docs/?q={query}`, language: 'en', tags: ['langchain', 'llm', 'agent'] },
  { domain: 'replicate.com', description: 'Replicate 开源模型托管', category: 'ai-platforms', priority: 6, searchUrl: `https://replicate.com/explore?q={query}`, language: 'en', tags: ['replicate', '模型托管'] },
  { domain: 'cursor.com', description: 'Cursor AI 代码编辑器官网', category: 'ai-platforms', priority: 6, language: 'en', tags: ['cursor', 'ai editor', 'ide'] },
  { domain: 'opencode.ai', description: 'OpenCode 官方', category: 'ai-platforms', priority: 6, language: 'en', tags: ['opencode', 'ai editor', 'ide'] },

  // ── datasets ──
  { domain: 'datasets.fyi', description: '公开数据集导航', category: 'datasets', priority: 6, searchUrl: `https://datasets.fyi/?q={query}`, tags: ['datasets', '数据'] },
  { domain: 'commoncrawl.org', description: 'Common Crawl 开放网页语料', category: 'datasets', priority: 6, tags: ['common crawl', '语料', 'datasets'] },

  // ── devops ──
  { domain: 'grafana.com', description: 'Grafana 可视化 / 可观测性', category: 'devops', priority: 7, searchUrl: `https://grafana.com/docs/?q={query}`, tags: ['grafana', 'observability', '监控'] },
  { domain: 'prometheus.io', description: 'Prometheus 监控', category: 'devops', priority: 7, searchUrl: `https://prometheus.io/docs/?q={query}`, tags: ['prometheus', '监控'] },
  { domain: 'terraform.io', description: 'Terraform IaC 文档', category: 'devops', priority: 7, searchUrl: `https://developer.hashicorp.com/terraform/docs?q={query}`, tags: ['terraform', 'iac', '基础设施'] },
  { domain: 'ansible.com', description: 'Ansible 自动化文档', category: 'devops', priority: 6, searchUrl: `https://docs.ansible.com/?q={query}`, tags: ['ansible', '自动化'] },
  { domain: 'helm.sh', description: 'Helm K8s 包管理', category: 'devops', priority: 7, searchUrl: `https://helm.sh/docs/?q={query}`, tags: ['helm', 'kubernetes'] },

  // ── government ──
  { domain: 'gov.cn', description: '中国政府网', category: 'government', priority: 8, searchUrl: `https://www.gov.cn/search/{query}.htm`, region: 'CN', language: 'zh', tags: ['gov', '政府', '中国'] },
  { domain: 'gov.uk', description: '英国政府门户', category: 'government', priority: 7, searchUrl: `https://www.gov.uk/search?q={query}`, language: 'en', region: 'EU', tags: ['gov', '政府', '英国'] },
  { domain: 'whitehouse.gov', description: '美国白宫官网', category: 'government', priority: 6, language: 'en', region: 'US', tags: ['gov', '白宫'] },
  { domain: 'ec.europa.eu', description: '欧盟委员会门户', category: 'government', priority: 6, language: 'en', region: 'EU', tags: ['gov', '欧盟'] },
  { domain: 'un.org', description: '联合国官网', category: 'government', priority: 6, language: 'multi', tags: ['gov', 'un', '联合国'] },
  { domain: 'who.int', description: '世界卫生组织 WHO', category: 'government', priority: 7, language: 'multi', tags: ['who', '卫生', '健康'] },

  // ── social / community ──
  { domain: 'x.com', description: 'X（原 Twitter）社交平台', category: 'social', priority: 9, searchUrl: `https://x.com/search?q={query}`, language: 'multi', tags: ['twitter', 'x', '社交'] },
  { domain: 't.me', description: 'telegram 社交平台', category: 'social', priority: 8, language: 'multi', tags: ['telegram', 't.me', '社交'] },
  { domain: 'reddit.com', description: 'Reddit 社区论坛', category: 'social', priority: 9, searchUrl: `https://www.reddit.com/search/?q={query}`, language: 'en', tags: ['reddit', '社区', 'forum'], pathHints: [`/r/{subreddit}`, `/user/{username}`] },
  { domain: 'linkedin.com', description: '领英职业社交', category: 'social', priority: 7, searchUrl: `https://www.linkedin.com/search/results/all/?keywords={query}`, language: 'en', tags: ['linkedin', '领英', '职业'] },
  { domain: 'discord.com', description: 'Discord 实时聊天 / 社区', category: 'social', priority: 7, searchUrl: `https://discord.com/search?q={query}`, language: 'multi', tags: ['discord', '聊天', '社区'] },
  { domain: 'weibo.com', description: '新浪微博 中文社交', category: 'social', priority: 7, searchUrl: `https://s.weibo.com/user?q={query}`, region: 'CN', tags: ['weibo', '微博', '中文社交'] },
  { domain: 'tieba.baidu.com', description: '百度贴吧 中文社区', category: 'social', priority: 7, searchUrl: `https://tieba.baidu.com/f/search/res?qw={query}`, region: 'CN', tags: ['tieba', '百度贴吧', '中文'] },
  { domain: 'douban.com', description: '豆瓣 中文书影音评分', category: 'social', priority: 6, searchUrl: `https://www.douban.com/search?cat=1002&q={query}`, region: 'CN', tags: ['douban', '豆瓣', '中文'] },

  // ── forum ──
  { domain: 'v2ex.com', description: 'V2EX 中文技术社区', category: 'forum', priority: 7, searchUrl: `https://www.v2ex.com/?q={query}`, region: 'CN', tags: ['v2ex', '中文', '技术社区'] },
  { domain: 'hupu.com', description: '虎扑中文体育社区', category: 'forum', priority: 5, searchUrl: `https://bbs.hupu.com/search?q={query}`, region: 'CN', tags: ['hupu', '虎扑', '体育'] },
  { domain: 'lobste.rs', description: 'Lobsters 高质量技术社区', category: 'forum', priority: 6, language: 'en', tags: ['lobsters', '技术社区'] },

  // ── video ──
  { domain: 'youtube.com', description: 'YouTube 视频平台', category: 'video', priority: 10, searchUrl: `https://www.youtube.com/results?search_query={query}`, language: 'multi', tags: ['youtube', '视频', 'video'], pathHints: [`/watch?v={id}`, `/channel/{id}`, `/@{handle}`] },
  { domain: 'youtu.be', description: 'YouTube 短链', category: 'video', priority: 7, tags: ['youtube', 'short url'] },
  { domain: 'vimeo.com', description: 'Vimeo 视频平台', category: 'video', priority: 6, searchUrl: `https://vimeo.com/search?q={query}`, language: 'en', tags: ['vimeo', '视频'] },
  { domain: 'bilibili.com', description: 'B站中文视频社区', category: 'video', priority: 9, searchUrl: `https://search.bilibili.com/all?keyword={query}`, region: 'CN', tags: ['bilibili', 'b站', '中文', '弹幕'] },
  { domain: 'twitch.tv', description: 'Twitch 直播平台', category: 'video', priority: 6, searchUrl: `https://www.twitch.tv/search?term={query}`, language: 'en', tags: ['twitch', '直播', 'livestream'] },
  { domain: 'www.acfun.cn', description: 'Acfun 弹幕视频网', category: 'video', priority: 8, region: 'CN', tags: ['acfun', '弹幕', '视频'] },
  { domain: 'www.douyin.com', description: '抖音短视频社区', category: 'video', priority: 6, region: 'CN', tags: ['抖音', '短视频', '中文'] },

  // ── music ──
  { domain: 'music.163.com', description: '网易云音乐', category: 'music', priority: 7, searchUrl: `https://music.163.com/#/search/m/?s={query}`, region: 'CN', tags: ['网易云', '音乐', '中文'] },
  { domain: 'y.qq.com', description: 'QQ 音乐', category: 'music', priority: 7, searchUrl: `https://y.qq.com/n/ryqq/search?w={query}`, region: 'CN', tags: ['qq音乐', '音乐', '中文'] },
  { domain: 'www.kugou.com', description: '酷狗音乐', category: 'music', priority: 6, searchUrl: `https://www.kugou.com/yy/html/search.html#searchType=song&searchKeyWord={query}`, region: 'CN', tags: ['酷狗', '音乐', '中文'] },
  { domain: 'spotify.com', description: 'Spotify 流媒体音乐', category: 'music', priority: 7, searchUrl: `https://open.spotify.com/search/{query}`, language: 'multi', tags: ['spotify', '音乐'] },
  { domain: 'soundcloud.com', description: 'SoundCloud 音频平台', category: 'music', priority: 6, searchUrl: `https://soundcloud.com/search?q={query}`, language: 'multi', tags: ['soundcloud', '音频'] },

  // ── maps ──
  { domain: 'maps.google.com', description: 'Google 地图', category: 'maps', priority: 9, searchUrl: `https://www.google.com/maps?q={query}`, language: 'multi', tags: ['maps', 'google maps', '地图'] },
  { domain: 'openstreetmap.org', description: 'OpenStreetMap 开源地图', category: 'maps', priority: 8, searchUrl: `https://www.openstreetmap.org/search?query={query}`, language: 'multi', tags: ['osm', 'openstreetmap', '开源地图'] },
  { domain: 'amap.com', description: '高德地图（中文）', category: 'maps', priority: 7, searchUrl: `https://uri.amap.com/search?keyword={query}`, region: 'CN', tags: ['高德', 'amap', '地图'] },
  { domain: 'tianditu.gov.cn', description: '天地图（中国官方地理信息）', category: 'maps', priority: 6, region: 'CN', tags: ['天地图', '地图'] },

  // ── shopping ──
  { domain: 'amazon.com', description: 'Amazon 全球电商', category: 'shopping', priority: 8, searchUrl: `https://www.amazon.com/s?k={query}`, language: 'multi', tags: ['amazon', '亚马逊', '电商'], pathHints: [`/dp/{asin}`] },
  { domain: 'taobao.com', description: '淘宝中文电商', category: 'shopping', priority: 7, searchUrl: `https://s.taobao.com/search?q={query}`, region: 'CN', tags: ['taobao', '淘宝', '中文电商'] },
  { domain: 'jd.com', description: '京东中文电商', category: 'shopping', priority: 7, searchUrl: `https://search.jd.com/Search?keyword={query}`, region: 'CN', tags: ['jd', '京东', '中文电商'] },
  { domain: 'tmall.com', description: '天猫中文电商', category: 'shopping', priority: 7, region: 'CN', tags: ['tmall', '天猫', '中文电商'] },

  // ── finance ──
  { domain: 'finance.yahoo.com', description: 'Yahoo Finance 行情 / 财经', category: 'finance', priority: 7, searchUrl: `https://finance.yahoo.com/lookup?q={query}`, language: 'en', tags: ['yahoo finance', 'finance', '股票'] },
  { domain: 'xueqiu.com', description: '雪球中文投资社区', category: 'finance', priority: 6, searchUrl: `https://xueqiu.com/k?q={query}`, region: 'CN', tags: ['xueqiu', '雪球', '中文'] },
  { domain: 'eastmoney.com', description: '东方财富 行情 / 资讯', category: 'finance', priority: 6, searchUrl: `https://so.eastmoney.com/web/s?keyword={query}`, region: 'CN', tags: ['eastmoney', '东方财富', '中文'] },
])

/* ───────────────────────────── lookups ─────────────────────────────── */

function stripWww(host: string): string {
  const lower = host.toLowerCase()
  return lower.startsWith('www.') ? lower.slice(4) : lower
}

/**
 * Canonicalise a hostname / URL string the model hands us. Returns the
 * bare lowercase host with the `www.` prefix stripped, or `null` when
 * the input cannot be interpreted as a host.
 *
 * Accepts:
 *   - bare host: `github.com`
 *   - `https://github.com/...`
 *   - `www.github.com/...`
 */
export function canonicalHost(input: string): string | null {
  const raw = String(input).trim()
  if (!raw) return null
  let host = raw
  const slash = host.search(/[/?#]/)
  if (slash >= 0) host = host.slice(0, slash)
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i.exec(raw)
  if (m && m[1]) host = m[1]
  host = stripWww(host)
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && host !== 'localhost') return null
  return host
}

/**
 * Exact lookup. Returns `undefined` when the domain is not in the table.
 * Input is canonicalised (lowercased, `www.` stripped) before lookup.
 */
export function findByDomain(input: string): WebSitemapEntry | undefined {
  const host = canonicalHost(input)
  if (!host) return undefined
  return WEB_SITEMAP.find((e) => e.domain === host)
}

/** Case-insensitive exact match by domain key (no host parsing). */
export function findByKey(domain: string): WebSitemapEntry | undefined {
  const k = String(domain).trim().toLowerCase()
  if (!k) return undefined
  return WEB_SITEMAP.find((e) => e.domain === k)
}

/** All entries in a category, ordered by priority desc. */
export function listByCategory(category: WebSitemapCategory): WebSitemapEntry[] {
  return WEB_SITEMAP
    .filter((e) => e.category === category)
    .slice()
    .sort((a, b) => b.priority - a.priority || a.domain.localeCompare(b.domain))
}

/** Categories that have at least one entry, ordered as in `WEB_SITEMAP_CATEGORIES`. */
export function categoriesInUse(): WebSitemapCategory[] {
  const seen = new Set<WebSitemapCategory>()
  for (const e of WEB_SITEMAP) seen.add(e.category)
  return WEB_SITEMAP_CATEGORIES.filter((c) => seen.has(c))
}

/* ───────────────────────────── matchers ─────────────────────────────── */

/**
 * Tokenise a string into lowercase word-tokens. CJK characters are
 * split one-by-one (no real word segmentation library on hand) so
 *   "中文问答"  → ["中", "文", "问", "答"]
 * which is good enough for tag scoring — the alternative is a 30 MB
 * dependency we'd rather not pull in.
 */
function tokenize(s: string): string[] {
  const out: string[] = []
  const lower = String(s).toLowerCase()
  let buf = ''
  for (const ch of lower) {
    if (/[a-z0-9]/.test(ch)) {
      buf += ch
    } else {
      if (buf) {
        out.push(buf)
        buf = ''
      }
      if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) out.push(ch)
    }
  }
  if (buf) out.push(buf)
  return out
}

/**
 * Score one entry against a tokenised query. Higher score = stronger match.
 *
 * Scoring (rough weights):
 *   - +6 per exact domain token match
 *   - +5 per token present in any tag
 *   - +3 per token present in description
 *   - +2 per token present in the category label (small bonus)
 *   - priority acts as a tie-breaker when scores are close (≤3 apart)
 */
function scoreEntry(entry: WebSitemapEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const descTokens = new Set(tokenize(`${entry.description} ${(entry.tags ?? []).join(' ')}`))
  const catTokens = new Set(tokenize(entry.category.replace(/-/g, ' ')))
  const domainTokens = tokenize(entry.domain.replace(/[-.]/g, ' '))
  let score = 0
  for (const t of tokens) {
    if (!t) continue
    if (domainTokens.includes(t)) score += 6
    if (descTokens.has(t)) score += 5
    if (catTokens.has(t)) score += 2
  }
  return score
}

export interface MatchOptions {
  /** Filter by category. */
  category?: WebSitemapCategory
  /** Drop entries below this priority. */
  minPriority?: number
  /** Cap the result count (default 10). */
  limit?: number
  /** Region filter (CN / US / …). `global` means "any". */
  region?: WebSitemapRegion
  /** Language filter (en / zh / …). `multi` matches everything. */
  language?: WebSitemapLanguage
}

/**
 * Score-based search across the table. Returns entries ordered by score
 * desc, then priority desc, then domain asc.
 *
 * The intent is to answer questions like
 *   - "rust package registry"      → crates.io (high)
 *   - "中文技术问答"                → zhihu / segmentfault / v2ex
 *   - "AI 模型托管"                → huggingface / openai / replicate
 *
 * Empty queries return the top-N by priority (a useful default for
 * "show me what you know").
 */
export function searchSitemap(query: string, options: MatchOptions = {}): WebSitemapEntry[] {
  const limit = options.limit ?? 10
  const minPriority = options.minPriority ?? 1
  const tokens = tokenize(query)
  const filtered = WEB_SITEMAP.filter((e) => {
    if (options.category && e.category !== options.category) return false
    if (e.priority < minPriority) return false
    if (options.region && e.region && e.region !== 'global' && e.region !== options.region) return false
    if (options.language && e.language && e.language !== 'multi' && e.language !== options.language) return false
    return true
  })
  if (tokens.length === 0) {
    return filtered.slice().sort((a, b) => b.priority - a.priority || a.domain.localeCompare(b.domain)).slice(0, limit)
  }
  const scored = filtered
    .map((e) => ({ e, s: scoreEntry(e, tokens) }))
    .filter((x) => x.s > 0)
  return scored
    .sort((a, b) => b.s - a.s || b.e.priority - a.e.priority || a.e.domain.localeCompare(b.e.domain))
    .slice(0, limit)
    .map((x) => x.e)
}

/* ──────────────────────────── URL builder ───────────────────────────── */

/**
 * Fill the search-URL template for a given domain + query. Returns
 * `null` when the domain has no template or the template is malformed.
 *
 * The query is encoded with `encodeURIComponent` so spaces / CJK /
 * punctuation all survive the round-trip. The template is required to
 * contain exactly one `{query}` placeholder; anything else is treated
 * as malformed and returns `null`.
 */
export function buildSearchUrl(domain: string, query: string): string | null {
  const entry = findByDomain(domain)
  if (!entry || !entry.searchUrl) return null
  const tmpl = entry.searchUrl
  const count = (tmpl.match(/\{query\}/g) ?? []).length
  if (count !== 1) return null
  return tmpl.replace(/\{query\}/g, encodeURIComponent(query))
}

/* ─────────────────────────── snapshot helpers ───────────────────────── */

/** A compact, summary-friendly dump of one entry. */
export interface WebSitemapEntrySummary {
  domain: string
  description: string
  category: WebSitemapCategory
  priority: number
  hasSearchUrl: boolean
  language: WebSitemapLanguage | undefined
  region: WebSitemapRegion | undefined
  tags: string[] | undefined
}

export function summarize(entry: WebSitemapEntry): WebSitemapEntrySummary {
  return {
    domain: entry.domain,
    description: entry.description,
    category: entry.category,
    priority: entry.priority,
    hasSearchUrl: typeof entry.searchUrl === 'string' && entry.searchUrl.length > 0,
    language: entry.language,
    region: entry.region,
    tags: entry.tags,
  }
}

/** A compact, list-friendly dump for a set of entries (used by the CLI). */
export interface WebSitemapSnapshot {
  total: number
  categories: WebSitemapCategory[]
  entries: WebSitemapEntrySummary[]
}

/** Snapshot the table (or a filtered slice) for CLI / prompt consumption. */
export function snapshot(filter?: { category?: WebSitemapCategory; minPriority?: number }): WebSitemapSnapshot {
  const list = filter ? WEB_SITEMAP.filter((e) => {
    if (filter.category && e.category !== filter.category) return false
    if (filter.minPriority && e.priority < filter.minPriority) return false
    return true
  }) : WEB_SITEMAP.slice()
  return {
    total: list.length,
    categories: [...new Set(list.map((e) => e.category))] as WebSitemapCategory[],
    entries: list.map(summarize),
  }
}

/**
 * Render a compact, prompt-friendly Markdown summary that the model can paste
 * into its context when it wants to recall the available authoritative
 * sources without going through the CLI again.
 *
 * The output is intentionally terse: `domain (priority) — description`.
 */
export function renderPromptDigest(filter?: { category?: WebSitemapCategory; minPriority?: number }): string {
  const list = filter ? WEB_SITEMAP.filter((e) => {
    if (filter.category && e.category !== filter.category) return false
    if (filter.minPriority && e.priority < filter.minPriority) return false
    return true
  }) : WEB_SITEMAP.slice()
  const lines: string[] = []
  let currentCat: WebSitemapCategory | '' = ''
  for (const e of list.slice().sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category)
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.domain.localeCompare(b.domain)
  })) {
    if (e.category !== currentCat) {
      currentCat = e.category
      lines.push(`# ${currentCat}`)
    }
    lines.push(`- ${e.domain} (p${e.priority}) — ${e.description}`)
  }
  return lines.join('\n')
}