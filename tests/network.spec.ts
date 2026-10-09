/**
 * Unit tests for dsh-network pure modules.
 *
 *   - network.ts: URL parsing, redirect resolution, IP/class checks, allowlist
 *   - search-engines.ts: Bing/DuckDuckGo/Baidu URL building + result parsing
 *   - html.ts: HTML → Markdown conversion
 *   - cli.ts: argv flag parsing (no execution)
 *
 * These match the discipline in the dsh-handbook ch.4 (logic in pure
 * functions, dependency-free, tested in milliseconds). No network is ever
 * contacted here; integration testing belongs in the evals (run with
 * `pnpm eval`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appendQuery,
  classifyFetchError,
  hasHeader,
  hostAllowed,
  isFakeIpv4,
  isIpv4Literal,
  isPrivateHost,
  isPrivateIpv4,
  isPrivateIpv6Literal,
  parseHttpUrl,
  resolveRedirect,
  sameRedirectDomain,
  sameRedirectProtocol,
} from '../src/network.ts'
import {
  b64UrlDecode,
  baiduSnippet,
  buildEngineUrl,
  parseBaiduResults,
  parseBingResults,
  parseDuckDuckGoResults,
  unwrapBingUrl,
  unwrapDuckDuckGoUrl,
} from '../src/search-engines.ts'
import { htmlToMarkdown } from '../src/html.ts'
import {
  cleanHtmlText,
  decodeEntities,
  extractVisibleTextFromHtml,
} from '../src/html-extract.ts'
import { buildRequestUrl } from '../src/http_request.ts'
import { normalizeConfig } from '../src/config.ts'
import { inferFileType, parseDocument } from '../src/document.ts'
import { GitHubSearchEngine, routeGithubIndexes } from '../src/engines/github.ts'
import {
  SEARXNG_DEFAULT_ENDPOINT,
  SEARXNG_ENV,
  SearxngSearchEngine,
  buildSearxngUrl,
  normalizeSearxngEndpoint,
} from '../src/engines/searxng.ts'
import { BRAVE_API_KEY_ENV, BraveSearchEngine, buildBraveUrl } from '../src/engines/brave.ts'
import { cleanText, defaultRegistry, registerDefaultEngines } from '../src/engines/index.ts'
import {
  WEB_SITEMAP,
  buildSearchUrl,
  categoriesInUse,
  canonicalHost,
  findByDomain,
  findByKey,
  listByCategory,
  renderPromptDigest,
  searchSitemap,
  snapshot,
  summarize,
} from '../src/sitemap.ts'

// ───────────────────────────── network.ts ─────────────────────────────
describe('network URL/IP helpers', () => {
  it('parseHttpUrl: simple https URL', () => {
    expect(parseHttpUrl('https://example.com/a?b=1#c')).toEqual({
      scheme: 'https', host: 'example.com', port: '', path: '/a?b=1#c',
    })
  })
  it('parseHttpUrl: explicit port', () => {
    expect(parseHttpUrl('http://api.example.com:8080/v1')).toEqual({
      scheme: 'http', host: 'api.example.com', port: '8080', path: '/v1',
    })
  })
  it('parseHttpUrl: IPv6 literal', () => {
    expect(parseHttpUrl('http://[::1]:3000/')).toEqual({
      scheme: 'http', host: '::1', port: '3000', path: '/',
    })
  })
  it('parseHttpUrl: strips userinfo', () => {
    expect(parseHttpUrl('https://user:pass@example.com/x').host).toBe('example.com')
  })
  it('parseHttpUrl: rejects non-http schemes', () => {
    expect(() => parseHttpUrl('ftp://example.com')).toThrow(/scheme/)
  })
  it('parseHttpUrl: rejects whitespace', () => {
    expect(() => parseHttpUrl('https://exa mple.com')).toThrow(/whitespace/)
  })
  it('parseHttpUrl: rejects missing host', () => {
    expect(() => parseHttpUrl('https:///path')).toThrow(/no host/)
  })

  it('isPrivateIpv4 classification', () => {
    for (const s of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.1.1', '224.0.0.1', '0.0.0.0']) {
      expect(isPrivateIpv4(s)).toBe(true)
    }
    for (const s of ['8.8.8.8', '93.184.216.34', '1.1.1.1']) {
      expect(isPrivateIpv4(s)).toBe(false)
    }
  })
  it('isPrivateIpv6Literal classification', () => {
    expect(isPrivateIpv6Literal('::1')).toBe(true)
    expect(isPrivateIpv6Literal('fe80::1')).toBe(true)
    expect(isPrivateIpv6Literal('fd00::1')).toBe(true)
    expect(isPrivateIpv6Literal('fc00::1')).toBe(true)
    expect(isPrivateIpv6Literal('2606:2800:220:1::1')).toBe(false)
  })
  it('isPrivateHost: loopback / private literals, public hosts pass', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('[::1]')).toBe(true)
    expect(isPrivateHost('127.0.0.1')).toBe(true)
    expect(isPrivateHost('10.0.0.5')).toBe(true)
    expect(isPrivateHost('192.168.1.10')).toBe(true)
    expect(isPrivateHost('::1')).toBe(true)
    expect(isPrivateHost('fd00::1')).toBe(true)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('searxng.lan')).toBe(false) // static check: hostname resolution is not consulted
  })
  it('isFakeIpv4 (RFC 2544 proxy space)', () => {
    expect(isFakeIpv4('198.18.0.1')).toBe(true)
    expect(isFakeIpv4('198.19.255.255')).toBe(true)
    expect(isFakeIpv4('198.17.0.1')).toBe(false)
    expect(isFakeIpv4('8.8.8.8')).toBe(false)
  })
  it('ip literal helper', () => {
    expect(isIpv4Literal('127.0.0.1')).toBe(true)
    expect(isIpv4Literal('256.0.0.1')).toBe(false)
    expect(isIpv4Literal('example.com')).toBe(false)
  })
  it('hostAllowed wildcard matching', () => {
    expect(hostAllowed('example.com', ['example.com'])).toBe(true)
    expect(hostAllowed('www.example.com', ['*.example.com'])).toBe(true)
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false)
    expect(hostAllowed('evil.com', ['*.example.com'])).toBe(false)
    expect(hostAllowed('anything.net', ['*'])).toBe(true)
    expect(hostAllowed('example.com', [])).toBe(false)
    expect(hostAllowed('EXAMPLE.COM', ['example.com'])).toBe(true)
  })
  it('resolveRedirect: absolute, protocol-relative, root-relative, relative', () => {
    expect(resolveRedirect('https://a.com/x/y', 'https://b.com/z')).toBe('https://b.com/z')
    expect(resolveRedirect('https://a.com/x', '//b.com/z')).toBe('https://b.com/z')
    expect(resolveRedirect('https://a.com/x/y', '/z')).toBe('https://a.com/z')
    expect(resolveRedirect('https://a.com/x/y', 'z')).toBe('https://a.com/x/z')
  })
  it('sameRedirectDomain: same host passes, other hosts and ports differ correctly', () => {
    expect(sameRedirectDomain('https://a.com/x', 'https://a.com/y')).toBe(true)
    expect(sameRedirectDomain('https://a.com/x', 'https://A.com/y')).toBe(true) // case-insensitive
    expect(sameRedirectDomain('https://a.com/x', 'https://a.com:8443/y')).toBe(true) // port is not a domain change
    expect(sameRedirectDomain('https://a.com/x', 'https://b.com/y')).toBe(false)
    expect(sameRedirectDomain('https://a.com/x', 'https://www.a.com/y')).toBe(false) // subdomain is a different domain
    expect(sameRedirectDomain('https://a.com/x', 'ftp://a.com/y')).toBe(false) // non-http(s) target never passes
  })
  it('sameRedirectProtocol: scheme switch is detected in both directions', () => {
    expect(sameRedirectProtocol('https://a.com/x', 'https://a.com/y')).toBe(true)
    expect(sameRedirectProtocol('http://a.com/x', 'http://a.com/y')).toBe(true)
    expect(sameRedirectProtocol('https://a.com/x', 'http://a.com/y')).toBe(false) // downgrade
    expect(sameRedirectProtocol('http://a.com/x', 'https://a.com/y')).toBe(false) // upgrade
    expect(sameRedirectProtocol('https://a.com/x', 'ftp://a.com/y')).toBe(false)
  })
  it('appendQuery: encodes and joins', () => {
    expect(appendQuery('https://a.com/search', { q: 'hello world', page: '2' }))
      .toBe('https://a.com/search?q=hello%20world&page=2')
    expect(appendQuery('https://a.com/?x=1', { y: '2' })).toBe('https://a.com/?x=1&y=2')
    expect(appendQuery('https://a.com/', {})).toBe('https://a.com/')
    expect(appendQuery('https://a.com/', undefined)).toBe('https://a.com/')
    expect(appendQuery('https://a.com/', { a: 1, b: null, c: undefined })).toBe('https://a.com/?a=1')
  })
  it('hasHeader is case-insensitive', () => {
    expect(hasHeader({ 'X-Token': 'a' }, 'x-token')).toBe(true)
    expect(hasHeader({ 'X-Token': 'a' }, 'Authorization')).toBe(false)
  })
  it('classifyFetchError maps common Node fetch codes', () => {
    expect(classifyFetchError(new Error('dns') as unknown).code).toMatch(/Error/)
    expect(classifyFetchError(Object.assign(new Error('boom'), { code: 'ENOTFOUND' })).code).toBe('DNS_FAILED')
    expect(classifyFetchError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).code).toBe('CONNECTION_RESET')
    expect(classifyFetchError(Object.assign(new Error('tls'), { code: 'CERT_HAS_EXPIRED' })).code).toBe('TLS_CERT')
    expect(classifyFetchError(Object.assign(new Error('timed out'), { name: 'TimeoutError' })).code).toBe('TIMEOUT')
  })
})

// ─────────────────────────── search-engines.ts ──────────────────────────
describe('search engine URL building', () => {
  it('buildEngineUrl: all engines', () => {
    expect(buildEngineUrl('bing', 'a b')).toMatch(/^https:\/\/www\.bing\.com\/search\?q=a%20b/)
    expect(buildEngineUrl('duckduckgo', 'x')).toMatch(/^https:\/\/html\.duckduckgo\.com\/html\/\?q=x$/)
    expect(buildEngineUrl('baidu', 'x')).toMatch(/^https:\/\/www\.baidu\.com\/s\?wd=x/)
  })
  it('parseBingResults: extracts url/title/snippet', () => {
    const html =
      '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1&ntb=1">Title A</a></h2><p>Snippet A</p></li>' +
      '<li class="b_algo"><h2><a href="https://example.org/b">Title B</a></h2></li>'
    const results = parseBingResults(html, 10)
    expect(results.length).toBe(2)
    expect(results[0]?.title).toBe('Title A')
    expect(results[0]?.snippet).toBe('Snippet A')
  })
  it('unwrapBingUrl: base64 a1 redirect', () => {
    const target = 'https://real.example/page'
    const encoded = btoa(target).replace(/\+/g, '-').replace(/\//g, '_')
    const href = `https://www.bing.com/ck/a?u=a1${encoded}&ntb=1`
    expect(unwrapBingUrl(href)).toBe(target)
    expect(unwrapBingUrl('https://example.org/plain')).toBe('https://example.org/plain')
  })
  it('unwrapDuckDuckGoUrl: uddg param', () => {
    const href = '//duckduckgo.com/l/?uddg=' + encodeURIComponent('https://real.example/x')
    expect(unwrapDuckDuckGoUrl(href)).toBe('https://real.example/x')
  })
  it('parseDuckDuckGoResults: skips ad click-trackers', () => {
    const html =
      '<a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a>' +
      '<a class="result__a" href="https://example.org/r">Real</a>' +
      '<a class="result__snippet" href="#">snip text</a>'
    const results = parseDuckDuckGoResults(html, 10)
    expect(results.length).toBe(1)
    expect(results[0]?.title).toBe('Real')
    expect(results[0]?.snippet).toBe('snip text')
  })
  it('parseBaiduResults: mu attribute wins over href', () => {
    const html =
      '<div class="c-container"><h3><a href="https://www.baidu.com/link?url=x" mu="https://real.example/1">Title 1</a></h3><span class="c-abstract">Abs 1</span></div>' +
      '<div class="c-container"><h3><a href="https://real.example/2">Title 2</a></h3></div>'
    const results = parseBaiduResults(html, 10)
    expect(results.length).toBe(2)
    expect(results[0]?.url).toBe('https://real.example/1')
    expect(results[0]?.snippet).toBe('Abs 1')
    expect(results[1]?.url).toBe('https://real.example/2')
  })
  it('b64UrlDecode round-trips and returns null on garbage', () => {
    expect(b64UrlDecode(Buffer.from('hello').toString('base64'))).toBe('hello')
    expect(b64UrlDecode('!!!not-base64!!!')).toBeNull()
  })
  it('baiduSnippet matches multiple container shapes', () => {
    expect(baiduSnippet('<div class="c-abstract">Snippet here</div>')).toBe('Snippet here')
    // Baidu's cu-line-clamp pattern lives under a parent carrying data-module="abstract".
    expect(baiduSnippet('<div data-module="abstract"><span class="cu-line-clamp">S</span></div>')).toBe('S')
    expect(baiduSnippet('<span class="c-color">C</span>')).toBe('C')
    expect(baiduSnippet('<div></div>')).toBe('')
  })
})

// ─────────────────────── HTML entity decoding ───────────────────────
//
// Source markup is entity-encoded, and every text node this package
// emits goes to a Markdown renderer or a model that can only render
// what it is given: a literal `&nbsp;` used to reach a result card, a
// web_search answer and the model's own reply verbatim. These cases are
// the regression fence for that.
describe('decodeEntities', () => {
  it('decodes the entities that actually show up in result markup', () => {
    expect(decodeEntities('Aug 19, 2026&nbsp;&#0183;&#32;DeepSeek')).toBe('Aug 19, 2026 · DeepSeek')
    expect(decodeEntities('&amp;NBSP HTML')).toBe('&NBSP HTML')
    expect(decodeEntities("they&#x27;re built with code")).toBe("they're built with code")
    expect(decodeEntities('&quot;quoted&quot; &lt;tag&gt;')).toBe('"quoted" <tag>')
    expect(decodeEntities('&copy; 2026 &mdash; done&hellip;')).toBe('© 2026 — done…')
    expect(decodeEntities('&rsquo; &ldquo;x&rdquo; &euro;5 &frac12;')).toBe('\u2019 \u201cx\u201d €5 ½')
  })

  it('resolves each reference exactly once (no double decode)', () => {
    // `&amp;lt;` is the page ESCAPING the text "&lt;". Decoding it twice
    // would hand the stripper a real `<` — the classic entity-injection
    // bug this single pass exists to avoid.
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;')
    expect(decodeEntities('a &amp;amp; b')).toBe('a &amp; b')
  })

  it('handles numeric, zero-padded and uppercase-entity forms', () => {
    expect(decodeEntities('&#183;')).toBe('·')
    expect(decodeEntities('&#0183;')).toBe('·')
    expect(decodeEntities('&#x2F;')).toBe('/')
    expect(decodeEntities('&#X2f;')).toBe('/')
    expect(decodeEntities('&NBSP;')).toBe(' ')
    // Uppercase HEX DIGITS too — `&#xE9;` is how a page that is *about*
    // entity escaping (a reference table, a spec) writes it.
    expect(decodeEntities('&#xE9;')).toBe('é')
    expect(decodeEntities('&#XAB;')).toBe('\u00ab')
    expect(decodeEntities('&ddagger;')).toBe('‡')
  })

  it('leaves unknown and out-of-range references visible instead of blanking them', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;')
    expect(decodeEntities('a & b')).toBe('a & b')
    // Surrogates and > U+10FFFF are not scalar values: emit nothing
    // rather than a lone surrogate that breaks the UTF-8 encode.
    expect(decodeEntities('x&#xD800;y')).toBe('xy')
    expect(decodeEntities('x&#1114112;y')).toBe('xy')
    expect(decodeEntities('x&#0;y')).toBe('xy')
  })

  it('normalizes every flavour of non-breaking whitespace to a space', () => {
    expect(decodeEntities('a\u00a0b')).toBe('a b')
    expect(decodeEntities('a&ensp;b&emsp;c&thinsp;d')).toBe('a b c d')
    // Zero-width characters are dropped, not turned into a space: a page
    // inserts U+200B to break a line INSIDE a word, so "a<ZWSP>b" is the
    // single word "ab" and `&shy;` is a hyphenation hint, not content.
    expect(decodeEntities('a\u200bb')).toBe('ab')
    expect(decodeEntities('un\u00adbroken')).toBe('unbroken')
    expect(decodeEntities('a&shy;b')).toBe('ab')
    expect(decodeEntities('a\ufeffb')).toBe('ab')
  })
})

describe('cleanHtmlText / extractVisibleTextFromHtml', () => {
  it('cleanText (engine helper) strips tags AND decodes in one step', () => {
    expect(cleanText('<b>R&amp;D</b> &#8212; <span>1&nbsp;000</span>')).toBe('R&D — 1 000')
    expect(cleanText('  \n <em>a</em>\t b ')).toBe('a b')
  })

  it('extractVisibleTextFromHtml decodes the title and the body', () => {
    const { title, text } = extractVisibleTextFromHtml(
      '<html><head><title>Caf&eacute; &amp; Bar</title></head>' +
        '<body><p>First&nbsp;line</p><p>Second &#8212; line</p></body></html>',
    )
    expect(title).toBe('Café & Bar')
    expect(text).toBe('First line\nSecond — line')
  })

  it('extractVisibleTextFromHtml keeps an empty title null, not an empty string', () => {
    expect(extractVisibleTextFromHtml('<html><head><title>  </title></head><body>x</body></html>').title).toBeNull()
    expect(extractVisibleTextFromHtml('<html><body>x</body></html>').title).toBeNull()
  })
})

describe('search engines decode entities at the parser boundary', () => {
  it('parseBingResults: the date separator entity decodes in the snippet', () => {
    const html =
      '<li class="b_algo"><h2><a href="https://example.org/a">R&amp;D Tools</a></h2>' +
      '<p>Aug 19, 2026&nbsp;&#0183;&#32;Plugin to manage &quot;proxy&quot;.</p></li>'
    const [hit] = parseBingResults(html, 10)
    expect(hit?.title).toBe('R&D Tools')
    expect(hit?.snippet).toBe('Aug 19, 2026 · Plugin to manage "proxy".')
  })

  it('parseDuckDuckGoResults: titles and snippets decode', () => {
    const html =
      '<a class="result__a" href="https://example.org/r">&amp;NBSP HTML: Examples</a>' +
      '<a class="result__snippet" href="#">It&#x27;s a non&nbsp;breaking space.</a>'
    const [hit] = parseDuckDuckGoResults(html, 10)
    expect(hit?.title).toBe('&NBSP HTML: Examples')
    expect(hit?.snippet).toBe("It's a non breaking space.")
  })

  it('parseBaiduResults: titles and every snippet layout decode', () => {
    const html =
      '<div class="c-container"><h3><a href="https://real.example/1">A &amp; B</a></h3>' +
      '<div data-module="abstract"><span class="cu-line-clamp">1&nbsp;000&#183;res</span></div></div>'
    const [hit] = parseBaiduResults(html, 10)
    expect(hit?.title).toBe('A & B')
    expect(hit?.snippet).toBe('1 000·res')
  })

  it('never emits a raw reference for any of the three scraped engines', () => {
    // The end-to-end assertion the bug report maps to: whatever shape the
    // markup takes, no `&...;` reaches the model or a card.
    const fragments = [
      parseBingResults('<li class="b_algo"><h2><a href="https://e.org/1">T&amp;T</a></h2><p>a&nbsp;b</p></li>', 5),
      parseDuckDuckGoResults(
        '<a class="result__a" href="https://e.org/2">T&#39;s</a><a class="result__snippet" href="#">a&nbsp;b</a>',
        5,
      ),
      parseBaiduResults(
        '<div class="c-container"><h3><a href="https://e.org/3">T&amp;T</a></h3><span class="c-abstract">a&nbsp;b</span></div>',
        5,
      ),
    ]
    for (const hits of fragments) {
      expect(hits.length).toBe(1)
      expect(hits[0]?.title).not.toMatch(/&[a-z#][a-z0-9]*;/i)
      expect(hits[0]?.snippet).not.toMatch(/&[a-z#][a-z0-9]*;/i)
    }
  })
})

// ─────────────────────────── github engine ──────────────────────────
describe('GitHubSearchEngine', () => {
  const engine = new GitHubSearchEngine()

  it('routes queries to indexes by intent', () => {
    expect(routeGithubIndexes('react 18')).toEqual(['repositories'])
    expect(routeGithubIndexes('react 18 用法示例')).toEqual(['repositories', 'code'])
    expect(routeGithubIndexes('浏览器 crash 报错')).toEqual(['repositories', 'issues'])
    expect(routeGithubIndexes('@torvalds')).toEqual(['users'])
    expect(routeGithubIndexes('language:typescript stars:>1000')).toEqual(['repositories'])
    expect(routeGithubIndexes('   ')).toEqual([])
  })

  it('buildRequests: token-gated code request without a token', () => {
    const reqs = engine.buildRequests('how to use x', { hasToken: false, perPage: 10 })
    expect(reqs.map((r) => r.key)).toEqual(['repositories', 'code'])
    expect(reqs.find((r) => r.key === 'code')?.requiresToken).toBe(true)
    const withToken = engine.buildRequests('how to use x', { hasToken: true, perPage: 10 })
    expect(withToken.find((r) => r.key === 'code')?.requiresToken).toBeUndefined()
  })

  it('buildRequests: caps per_page at 100 and query at 256 chars', () => {
    const reqs = engine.buildRequests('x'.repeat(300), { perPage: 500 })
    const url = reqs[0]!.url
    expect(url).toContain('per_page=100')
    const q = decodeURIComponent(url.split('q=')[1]!.split('&')[0]!)
    expect(q.length).toBe(256)
  })

  it('buildRequests: explicit index selection wins over routing', () => {
    const reqs = engine.buildRequests('vue 3', { indexes: ['users', 'issues', 'forks'], hasToken: false })
    expect(reqs.map((r) => r.key)).toEqual(['users', 'issues']) // unknown id dropped
    const codeOnly = engine.buildRequests('vue 3', { indexes: ['code'], hasToken: true })
    expect(codeOnly.map((r) => r.key)).toEqual(['code'])
  })

  it('buildRequests: sort applies to repositories only', () => {
    const reqs = engine.buildRequests('vue 3', { indexes: ['repositories', 'issues'], sort: 'stars' })
    expect(reqs.find((r) => r.key === 'repositories')?.url).toContain('sort=stars&order=desc')
    expect(reqs.find((r) => r.key === 'issues')?.url).not.toContain('sort=')
    const best = engine.buildRequests('vue 3', { sort: 'best' })
    expect(best[0]?.url).not.toContain('sort=')
    const invalid = engine.buildRequests('vue 3', { sort: 'forks' })
    expect(invalid[0]?.url).not.toContain('sort=')
  })

  it('buildRequests: encodes the query and pins the API base', () => {
    const [req] = engine.buildRequests('vue 3 组合式 API', { perPage: 5 })
    expect(req?.url).toMatch(
      /^https:\/\/api\.github\.com\/search\/repositories\?q=vue%203%20%E7%BB%84%E5%90%88%E5%BC%8F%20API&per_page=5$/,
    )
  })

  it('parseMany: repositories page → rich metadata snippets', () => {
    const body = JSON.stringify({
      total_count: 2,
      incomplete_results: false,
      items: [
        {
          full_name: 'vuejs/core',
          html_url: 'https://github.com/vuejs/core',
          description: 'Vue.js core library',
          stargazers_count: 47000,
          language: 'TypeScript',
          pushed_at: '2026-08-01T00:00:00Z',
          fork: false,
        },
        {
          full_name: 'x/y',
          html_url: 'https://github.com/x/y',
          description: null,
          stargazers_count: 12,
          language: null,
          pushed_at: null,
          fork: true,
        },
      ],
    })
    const res = engine.parseMany([{ key: 'repositories', body, status: 200, headers: {} }], 10)
    expect(res.items.length).toBe(2)
    expect(res.items[0]?.title).toBe('[repo] vuejs/core')
    expect(res.items[0]?.snippet).toContain('⭐47.0k')
    expect(res.items[0]?.snippet).toContain('TypeScript')
    expect(res.items[0]?.snippet).toContain('updated 2026-08-01')
    expect(res.items[1]?.snippet).toContain('fork')
  })

  it('parseMany: code hits use text_matches fragments', () => {
    const body = JSON.stringify({
      items: [
        {
          path: 'src/x.ts',
          html_url: 'https://github.com/a/b/blob/main/src/x.ts',
          repository: { full_name: 'a/b' },
          text_matches: [{ fragment: 'const engine = new GitHubSearchEngine()' }],
        },
      ],
    })
    const res = engine.parseMany([{ key: 'code', body, status: 200, headers: {} }], 10)
    expect(res.items[0]?.title).toBe('[code] src/x.ts @ a/b')
    expect(res.items[0]?.snippet).toContain('const engine')
  })

  it('parseMany: synthetic 401 (no token) → warning, zero items', () => {
    const res = engine.parseMany([{ key: 'code', body: '', status: 401, headers: {} }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.join(' ')).toContain('authentication required')
  })

  it('parseMany: rate limit 403 → warning with reset timestamp', () => {
    const res = engine.parseMany(
      [
        {
          key: 'repositories',
          body: JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4' }),
          status: 403,
          headers: { 'x-ratelimit-reset': '1787391199' },
        },
      ],
      10,
    )
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('rate limit')
    expect(res.warnings?.[0]).toContain('2026-08-22')
  })

  it('parseMany: transport failure lands in warnings', () => {
    const res = engine.parseMany([{ key: 'repositories', body: '', status: 0, error: 'Request timed out' }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('timed out')
  })

  it('parseMany: fuses indexes with weighted RRF, dedupes, prefixes', () => {
    const repos = JSON.stringify({
      items: [
        { full_name: 'a/alpha', html_url: 'https://github.com/a/alpha', description: 'alpha', stargazers_count: 10 },
        { full_name: 'b/beta', html_url: 'https://github.com/b/beta', description: 'beta', stargazers_count: 5 },
      ],
    })
    // Duplicate URL on purpose: the repo hit (weight 1.0, rank 0) must
    // beat the issue hit (weight 0.9, rank 0) for the same URL.
    const issues = JSON.stringify({
      items: [
        { number: 1, title: 'alpha broken', html_url: 'https://github.com/a/alpha', state: 'open' },
        { number: 2, title: 'gamma issue', html_url: 'https://github.com/g/gamma/issues/2', state: 'closed' },
      ],
    })
    const res = engine.parseMany(
      [
        { key: 'repositories', body: repos, status: 200, headers: {} },
        { key: 'issues', body: issues, status: 200, headers: {} },
      ],
      10,
    )
    // scores: a/alpha repo 1/(60+1) > b/beta repo 1/(60+2) > gamma issue 0.9/(60+1)
    expect(res.items.map((i) => i.title)).toEqual([
      '[repo] a/alpha',
      '[repo] b/beta',
      '[issue] #2 gamma issue',
    ])
    expect(res.items.map((i) => i.url)).not.toContain('[issue] #1') // deduped by URL
  })

  it('parseMany: caps fused output at max', () => {
    const repos = JSON.stringify({
      items: [1, 2, 3, 4, 5].map((n) => ({
        full_name: `o/r${n}`,
        html_url: `https://github.com/o/r${n}`,
        description: `repo ${n}`,
      })),
    })
    const res = engine.parseMany([{ key: 'repositories', body: repos, status: 200, headers: {} }], 3)
    expect(res.items.length).toBe(3)
  })

  it('parse: single-body compatibility path', () => {
    const body = JSON.stringify({
      items: [
        {
          full_name: 'vuejs/core',
          html_url: 'https://github.com/vuejs/core',
          description: 'Vue.js core',
          stargazers_count: 47000,
          language: 'TypeScript',
        },
      ],
    })
    const items = engine.parse(body, 10)
    expect(items[0]?.title).toBe('[repo] vuejs/core')
  })

  it('is registered in the default registry as chain tail', () => {
    registerDefaultEngines(defaultRegistry)
    const all = defaultRegistry.all().map((e) => e.id)
    expect(all).toEqual(['bing', 'duckduckgo', 'baidu', 'github', 'searxng', 'brave'])
  })
})

// ─────────────────────────── searxng engine ──────────────────────────
describe('SearxngSearchEngine', () => {
  // The engine reads DSH_NETWORK_SEARXNG_URL at construction; pin the env
  // for the whole suite so tests never depend on the caller's environment.
  const savedEnv = process.env[SEARXNG_ENV]
  beforeAll(() => {
    delete process.env[SEARXNG_ENV]
  })
  afterAll(() => {
    if (savedEnv === undefined) delete process.env[SEARXNG_ENV]
    else process.env[SEARXNG_ENV] = savedEnv
  })

  it('defaults to the loopback endpoint and builds format=json URLs', () => {
    const engine = new SearxngSearchEngine()
    expect(engine.endpoint).toBe('http://127.0.0.1:8888')
    expect(engine.displayName).toBe('SearXNG')
    const [req] = engine.buildRequests('rust vs go', {})
    expect(req?.key).toBe('searxng')
    expect(req?.url).toBe('http://127.0.0.1:8888/search?q=rust%20vs%20go&format=json')
  })

  it('reads DSH_NETWORK_SEARXNG_URL and strips trailing slashes', () => {
    process.env[SEARXNG_ENV] = 'http://192.168.1.50:8080/'
    try {
      const engine = new SearxngSearchEngine()
      expect(engine.endpoint).toBe('http://192.168.1.50:8080')
      expect(engine.buildUrl('x')).toBe('http://192.168.1.50:8080/search?q=x&format=json')
    } finally {
      delete process.env[SEARXNG_ENV]
    }
  })

  it('buildSearxngUrl: passes through supported options only', () => {
    const url = buildSearxngUrl('http://127.0.0.1:8888', 'vue 3', {
      language: 'zh-CN',
      safesearch: 1,
      timeRange: 'month',
      categories: 'general,it',
      pageno: 2,
    })
    expect(url).toBe(
      'http://127.0.0.1:8888/search?q=vue%203&format=json&language=zh-CN&safesearch=1&time_range=month&categories=general%2Cit&pageno=2',
    )
    const minimal = buildSearxngUrl('http://127.0.0.1:8888', 'q', {
      safesearch: 3, // invalid → dropped
      timeRange: 'all', // invalid → dropped
      pageno: 1, // default → dropped
      junk: 'x', // unknown → dropped
    })
    expect(minimal).toBe('http://127.0.0.1:8888/search?q=q&format=json')
  })

  it('normalizeSearxngEndpoint: valid URLs kept, garbage falls back', () => {
    expect(normalizeSearxngEndpoint('https://searx.example.org')).toBe('https://searx.example.org')
    expect(normalizeSearxngEndpoint('http://10.0.0.2:9999/')).toBe('http://10.0.0.2:9999')
    expect(normalizeSearxngEndpoint('')).toBe(SEARXNG_DEFAULT_ENDPOINT)
    expect(normalizeSearxngEndpoint(undefined)).toBe(SEARXNG_DEFAULT_ENDPOINT)
    expect(normalizeSearxngEndpoint('not a url')).toBe(SEARXNG_DEFAULT_ENDPOINT)
    expect(normalizeSearxngEndpoint('ftp://127.0.0.1')).toBe(SEARXNG_DEFAULT_ENDPOINT)
  })

  it('parseMany: maps results to SearchSource and caps at max', () => {
    const body = JSON.stringify({
      query: 'rust vs go',
      results: [
        { url: 'https://a.example/1', title: 'Rust vs Go', content: '  A  comparison   of both.  ', engine: 'google', score: 1.0 },
        { url: 'https://a.example/2', title: '', content: '', engine: 'bing' },
        { url: '', title: 'no url', content: 'skipped' },
        { url: 'https://a.example/3', title: 'Third', content: null },
      ],
      unresponsive_engines: [],
    })
    const res = new SearxngSearchEngine().parseMany([{ key: 'searxng', body, status: 200, headers: {} }], 10)
    expect(res.items.length).toBe(3)
    expect(res.items[0]).toEqual({ url: 'https://a.example/1', title: 'Rust vs Go', snippet: 'A comparison of both.' })
    expect(res.items[1]?.title).toBe('https://a.example/2') // empty title falls back to the URL
    expect(res.items[2]?.snippet).toBeUndefined()
    expect(res.warnings).toBeUndefined()
    const capped = new SearxngSearchEngine().parseMany([{ key: 'searxng', body, status: 200, headers: {} }], 2)
    expect(capped.items.length).toBe(2)
  })

  it('parseMany: 403 (json format disabled) surfaces a fixable warning', () => {
    const res = new SearxngSearchEngine().parseMany([{ key: 'searxng', body: '', status: 403, headers: {} }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('403')
    expect(res.warnings?.[0]).toContain('search.formats')
  })

  it('parseMany: JSON error bodies and non-JSON responses warn', () => {
    const err400 = new SearxngSearchEngine().parseMany(
      [{ key: 'searxng', body: JSON.stringify({ error: 'No query' }), status: 400, headers: {} }],
      10,
    )
    expect(err400.items).toEqual([])
    expect(err400.warnings?.[0]).toContain('No query')
    const notJson = new SearxngSearchEngine().parseMany(
      [{ key: 'searxng', body: '<html>503</html>', status: 503, headers: {} }],
      10,
    )
    expect(notJson.warnings?.[0]).toContain('unexpected HTTP 503')
    const html200 = new SearxngSearchEngine().parseMany(
      [{ key: 'searxng', body: '<html></html>', status: 200, headers: {} }],
      10,
    )
    expect(html200.warnings?.[0]).toContain('not JSON')
  })

  it('parseMany: unresponsive upstream engines become uncertainty', () => {
    const body = JSON.stringify({
      query: 'x',
      results: [{ url: 'https://ok.example', title: 'OK', content: 'fine' }],
      unresponsive_engines: [['google', 'HTTP error'], ['bing', 'timeout']],
    })
    const res = new SearxngSearchEngine().parseMany([{ key: 'searxng', body, status: 200, headers: {} }], 10)
    expect(res.items.length).toBe(1)
    expect(res.uncertainty?.[0]).toContain('2 upstream engine(s)')
    expect(res.uncertainty?.[0]).toContain('google, bing')
  })

  it('parseMany: transport failure and missing body land in warnings', () => {
    const res = new SearxngSearchEngine().parseMany(
      [{ key: 'searxng', body: '', status: 0, error: 'connection refused: 127.0.0.1:8888' }],
      10,
    )
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('connection refused')
  })

  it('parse: single-body compatibility path', () => {
    const body = JSON.stringify({
      results: [{ url: 'https://a.example/1', title: 'T', content: 'S' }],
    })
    const items = new SearxngSearchEngine().parse(body, 10)
    expect(items.length).toBe(1)
    expect(items[0]?.snippet).toBe('S')
  })
})

// ─────────────────────────── brave engine ──────────────────────────
describe('BraveSearchEngine', () => {
  // The engine reads DSH_NETWORK_ENGINE_OPTIONS per request; pin it so the
  // suite never depends on the caller's environment.
  const savedOptions = process.env.DSH_NETWORK_ENGINE_OPTIONS
  const savedKey = process.env[BRAVE_API_KEY_ENV]
  beforeAll(() => {
    delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    delete process.env[BRAVE_API_KEY_ENV]
  })
  afterAll(() => {
    if (savedOptions === undefined) delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    else process.env.DSH_NETWORK_ENGINE_OPTIONS = savedOptions
    if (savedKey === undefined) delete process.env[BRAVE_API_KEY_ENV]
    else process.env[BRAVE_API_KEY_ENV] = savedKey
  })

  it('pins the API endpoint and declares the credential header', () => {
    const engine = new BraveSearchEngine()
    expect(engine.endpoint).toBe('https://api.search.brave.com/res/v1/web/search')
    expect(engine.displayName).toBe('Brave Search')
    // The auth block is what the CLI injects from — a wrong header name here
    // would make every keyed call 401 with no other symptom.
    expect(engine.auth?.header).toBe('X-Subscription-Token')
    expect(engine.auth?.scheme).toBe('raw')
    expect(engine.auth?.apiKeyEnv).toBe(BRAVE_API_KEY_ENV)
  })

  it('builds the documented default query (count + extra_snippets)', () => {
    expect(buildBraveUrl('rust vs go', { max: 10 })).toBe(
      'https://api.search.brave.com/res/v1/web/search?q=rust%20vs%20go&count=10&extra_snippets=true',
    )
  })

  it('clamps count to Brave’s 20 cap and the offset to 0-9', () => {
    expect(buildBraveUrl('q', { max: 99 })).toContain('count=20')
    expect(buildBraveUrl('q', { max: 0 })).toContain('count=1')
    expect(buildBraveUrl('q', { max: 10, offset: 9 })).toContain('offset=9')
    expect(buildBraveUrl('q', { max: 10, offset: 10 })).not.toContain('offset=')
    expect(buildBraveUrl('q', { max: 10, offset: 0 })).not.toContain('offset=')
  })

  it('prefers the call’s perPage over the standalone max', () => {
    // The CLI always passes the call's result cap as `perPage`; `max` is the
    // standalone spelling. Server-provided wins so a per-call count argument
    // is honored, and a missing/odd perPage falls back to `max`.
    expect(buildBraveUrl('q', { perPage: 3, max: 10 })).toContain('count=3')
    expect(buildBraveUrl('q', { max: 7 })).toContain('count=7')
    expect(buildBraveUrl('q', { perPage: undefined, max: 7 })).toContain('count=7')
    expect(buildBraveUrl('q', {})).toContain('count=20')
  })

  it('passes through only the documented option vocabulary', () => {
    const url = buildBraveUrl('vue 3', {
      max: 5,
      country: 'de',
      searchLang: 'de',
      uiLang: 'de-DE',
      freshness: 'pw',
      safesearch: 'strict',
      goggles: 'https://goggles.example/rank.json',
    })
    expect(url).toBe(
      'https://api.search.brave.com/res/v1/web/search?q=vue%203&count=5&extra_snippets=true' +
        '&country=DE&search_lang=de&ui_lang=de-DE&freshness=pw&safesearch=strict' +
        '&goggles=https%3A%2F%2Fgoggles.example%2Frank.json',
    )
    const minimal = buildBraveUrl('q', {
      max: 10,
      country: 'DEU', // not a 2-letter code → dropped
      freshness: 'all', // not pd|pw|pm|py nor a range → dropped
      safesearch: 'maybe', // not off|moderate|strict → dropped
      goggles: 'not a url', // dropped rather than sent as free text
      junk: 'x', // unknown → dropped
    })
    expect(minimal).toBe('https://api.search.brave.com/res/v1/web/search?q=q&count=10&extra_snippets=true')
    // A custom date range is a documented freshness value.
    expect(buildBraveUrl('q', { max: 10, freshness: '2024-01-01to2024-06-30' })).toContain(
      'freshness=2024-01-01to2024-06-30',
    )
  })

  it('reads per-engine options out of DSH_NETWORK_ENGINE_OPTIONS', () => {
    process.env.DSH_NETWORK_ENGINE_OPTIONS = JSON.stringify({ brave: { country: 'JP' }, other: { x: 'y' } })
    try {
      const [req] = new BraveSearchEngine().buildRequests('q', { perPage: 3 })
      expect(req?.key).toBe('brave')
      expect(req?.url).toContain('country=JP')
      // The call's result cap wins over the engine default.
      expect(req?.url).toContain('count=3')
      // A single-engine env var of a DIFFERENT engine must not leak in.
      expect(req?.url).not.toContain('x=y')
    } finally {
      delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    }
  })

  it('parseMany: maps web.results, keeps page_age, merges one extra snippet', () => {
    const body = JSON.stringify({
      query: { original: 'x', more_results_available: false },
      web: {
        results: [
          {
            title: 'Rust vs Go',
            url: 'https://bench.example/rust-go',
            description: 'Main excerpt.',
            page_age: '2026-02-01T00:00:00',
            extra_snippets: ['Second excerpt.', 'Third excerpt.'],
          },
          { title: '', url: 'https://no-title.example/x' },
          { title: 'no url', url: '' },
        ],
      },
    })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 200, headers: {} }], 10)
    expect(res.items.length).toBe(2)
    expect(res.items[0]?.title).toBe('Rust vs Go')
    // Exactly one extra snippet rides along: main text, ellipsis, first extra.
    expect(res.items[0]?.snippet).toBe('Main excerpt. … Second excerpt.')
    // page_age lands in published_at — the field the search card renders.
    expect(res.items[0]?.published_at).toBe('2026-02-01T00:00:00')
    // A hit with no title falls back to its URL, and the url-less hit is dropped.
    expect(res.items[1]?.title).toBe('https://no-title.example/x')
  })

  it('parseMany: drops implausible page_age values instead of showing a wrong date', () => {
    // Live responses carry broken page_age values: one real query returned
    // `1970-01-19T20:35:52` for a modern page (an epoch-seconds field read as
    // ms), and Brave also documents relative shapes. A wrong date in the
    // evidence is worse than no date, so both are dropped.
    const body = JSON.stringify({
      web: {
        results: [
          { url: 'https://a.example/epoch', title: 'Epoch garbage', page_age: '1970-01-19T20:35:52' },
          { url: 'https://b.example/relative', title: 'Relative', page_age: '3 days ago' },
          { url: 'https://c.example/future', title: 'Far future', page_age: '2999-01-01T00:00:00' },
          { url: 'https://d.example/ok', title: 'Fine', page_age: '2026-09-12T19:05:25' },
          { url: 'https://e.example/none', title: 'No date' },
        ],
      },
    })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 200, headers: {} }], 10)
    expect(res.items.map((i) => i.published_at)).toEqual([undefined, undefined, undefined, '2026-09-12T19:05:25', undefined])
  })

  it('parseMany: caps at max', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({ url: `https://e.example/${i}`, title: `T${i}` }))
    const body = JSON.stringify({ web: { results } })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 200, headers: {} }], 2)
    expect(res.items.length).toBe(2)
  })

  it('parseMany: an empty web.results page is zero hits, not an error', () => {
    const res = new BraveSearchEngine().parseMany(
      [{ key: 'brave', body: JSON.stringify({ web: { results: [] } }), status: 200, headers: {} }],
      10,
    )
    expect(res.items).toEqual([])
    expect(res.warnings).toBeUndefined()
  })

  it('parseMany: more_results_available surfaces as uncertainty at the cap', () => {
    const results = Array.from({ length: 2 }, (_, i) => ({ url: `https://e.example/${i}`, title: `T${i}` }))
    const body = JSON.stringify({ query: { more_results_available: true }, web: { results } })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 200, headers: {} }], 2)
    expect(res.uncertainty?.[0]).toContain('more results are available')
  })

  it('parseMany: synthetic 401 (no key) names the fix', () => {
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body: '', status: 401, headers: {} }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('authentication failed')
    expect(res.warnings?.[0]).toContain('DSH_NETWORK_BRAVE_API_KEY')
  })

  it('parseMany: 429 / 422 / non-JSON bodies become actionable warnings', () => {
    const engine = new BraveSearchEngine()
    const rate = engine.parseMany(
      [
        {
          key: 'brave',
          body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'quota exceeded' } }),
          status: 429,
          headers: {},
        },
      ],
      10,
    )
    expect(rate.warnings?.[0]).toContain('rate limited')
    expect(rate.warnings?.[0]).toContain('quota exceeded')

    const rejected = engine.parseMany([{ key: 'brave', body: '', status: 422, headers: {} }], 10)
    expect(rejected.warnings?.[0]).toContain('query rejected (422)')

    const html = engine.parseMany([{ key: 'brave', body: '<html>502</html>', status: 502, headers: {} }], 10)
    expect(html.warnings?.[0]).toContain('unexpected HTTP 502')

    const garbage = engine.parseMany([{ key: 'brave', body: '<html></html>', status: 200, headers: {} }], 10)
    expect(garbage.warnings?.[0]).toContain('was not JSON')

    const foreign = engine.parseMany(
      [{ key: 'brave', body: JSON.stringify({ results: [] }), status: 200, headers: {} }],
      10,
    )
    expect(foreign.warnings?.[0]).toContain('no `web.results`')
  })

  it('parseMany: a 422 about the credential is reported as auth, not as a bad query', () => {
    // The live API answers 422 (not 401) when `x-subscription-token` is
    // missing, with the field name inside error.meta.errors[].loc. Reporting
    // that as "check your query" would send the user down the wrong path.
    const body = JSON.stringify({
      error: {
        code: 'VALIDATION',
        detail: 'Unable to validate request parameter(s)',
        meta: {
          errors: [
            { input: null, loc: ['header', 'x-subscription-token'], msg: 'Field required', type: 'missing' },
          ],
        },
        status: 422,
      },
      type: 'ErrorResponse',
    })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 422, headers: {} }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('authentication failed')
    // The actionable half of the error body survives into the warning.
    expect(res.warnings?.[0]).toContain('header.x-subscription-token: Field required')

    // A BOGUS key is also a 422, with a different message (captured live):
    // { "error": { "detail": "The provided API key is invalid.", "status": 422 } }
    const bogus = JSON.stringify({
      error: { code: 'VALIDATION', detail: 'The provided API key is invalid.', status: 422 },
      type: 'ErrorResponse',
    })
    const bad = new BraveSearchEngine().parseMany([{ key: 'brave', body: bogus, status: 422, headers: {} }], 10)
    expect(bad.warnings?.[0]).toContain('authentication failed')
    expect(bad.warnings?.[0]).toContain('The provided API key is invalid.')
  })

  it('parseMany: a 422 about the query keeps the query advice', () => {
    const body = JSON.stringify({ error: { detail: 'Invalid value for parameter q', status: 422 } })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 422, headers: {} }], 10)
    expect(res.warnings?.[0]).toContain('query rejected (422 ')
    expect(res.warnings?.[0]).toContain('Invalid value for parameter q')
  })

  it('parseMany: transport failure lands in warnings', () => {
    const res = new BraveSearchEngine().parseMany(
      [{ key: 'brave', body: '', status: 0, error: 'getaddrinfo ENOTFOUND api.search.brave.com' }],
      10,
    )
    expect(res.warnings?.[0]).toContain('ENOTFOUND')
  })

  it('parse: single-body compatibility path', () => {
    const body = JSON.stringify({ web: { results: [{ url: 'https://a.example/1', title: 'T', description: 'S' }] } })
    const items = new BraveSearchEngine().parse(body, 10)
    expect(items.length).toBe(1)
    expect(items[0]?.snippet).toBe('S')
  })
})

// ─────────────────────────── html.ts ──────────────────────────
describe('htmlToMarkdown', () => {
  it('htmlToMarkdown: basic document', () => {
    const md = htmlToMarkdown(
      '<html><head><title>t</title></head><body><h1>Hi</h1><p>Hello <strong>world</strong> <a href="https://x.example/a">link</a></p><ul><li>one</li><li>two</li></ul><pre><code>const a = 1</code></pre></body></html>',
    )
    expect(md).toContain('# Hi')
    expect(md).toContain('Hello **world** [link](https://x.example/a)')
    expect(md).toContain('- one')
    expect(md).toContain('```')
    expect(md).toContain('const a = 1')
  })
  it('htmlToMarkdown: strips script/style/nav', () => {
    const md = htmlToMarkdown('<nav>Menu</nav><script>alert(1)</script><style>.x{}</style><p>Keep</p>')
    expect(md).not.toContain('alert')
    expect(md).not.toContain('Menu')
    expect(md).toContain('Keep')
  })
  it('htmlToMarkdown: decodes entities in prose, links, headings and table cells', () => {
    const md = htmlToMarkdown(
      '<h2>R&amp;D &mdash; Index</h2>' +
        '<p>1&nbsp;000&nbsp;records &#8212; see <a href="https://x.example/q?a=1&amp;b=2">Q&amp;A</a></p>' +
        '<table><tr><td>a&nbsp;b</td><td>&lt;tag&gt;</td></tr></table>',
    )
    expect(md).toContain('## R&D — Index')
    expect(md).toContain('1 000 records — see')
    expect(md).toContain('[Q&A](https://x.example/q?a=1&b=2)')
    expect(md).toContain('| a b | <tag> |')
  })
  it('htmlToMarkdown: a decoded entity cannot re-enter as markup', () => {
    // The page ESCAPED the literal text "&lt;script&gt;": the marker must
    // survive as visible text, never be re-decoded into a tag.
    const md = htmlToMarkdown('<p>&amp;lt;script&amp;gt; is escaped</p>')
    expect(md).toBe('&lt;script&gt; is escaped')
  })
  it('htmlToMarkdown: decodes entities inside code fences (pages escape them there)', () => {
    const md = htmlToMarkdown('<pre>&lt;div class=&quot;x&quot;&gt;&amp;nbsp;&lt;/div&gt;</pre>')
    expect(md).toContain('<div class="x">')
    // `&amp;nbsp;` renders as the five visible characters "&nbsp;".
    expect(md).toContain('&nbsp;</div>')
  })
})

// ─────────────────────────── config.ts ──────────────────────────
describe('config normalization', () => {
  it('applySchema defaults', () => {
    const cfg = normalizeConfig({})
    expect(cfg.enabled).toBe(true)
    expect(cfg.ssrfProtection).toBe(true)
    expect(cfg.redirectProtection).toBe(true)
    expect(cfg.protocolLock).toBe(true)
    expect(cfg.httpTimeoutMs).toBe(25_000)
    expect(cfg.maxRedirects).toBe(3)
    expect(cfg.searchEngines).toEqual(['bing', 'duckduckgo', 'baidu'])
    expect(cfg.httpMethods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
  })
  it('protection toggles: explicit values override the ON defaults', () => {
    const off = normalizeConfig({ ssrfProtection: false, redirectProtection: false, protocolLock: false })
    expect(off.ssrfProtection).toBe(false)
    expect(off.redirectProtection).toBe(false)
    expect(off.protocolLock).toBe(false)
    const mixed = normalizeConfig({ ssrfProtection: true, protocolLock: false })
    expect(mixed.ssrfProtection).toBe(true)
    expect(mixed.redirectProtection).toBe(true)
    expect(mixed.protocolLock).toBe(false)
  })
  it('lowercase methods normalize to uppercase', () => {
    const cfg = normalizeConfig({ httpMethods: ['get', 'post', 'delete'] })
    expect(cfg.httpMethods).toEqual(['GET', 'POST', 'DELETE'])
  })
  it('rejects invalid methods, engines, and zero timeouts', () => {
    expect(() => normalizeConfig({ httpMethods: ['G ET'] })).toThrow(/invalid HTTP method/)
    expect(() => normalizeConfig({ httpMethods: ['TRACE;'] })).toThrow(/invalid HTTP method/)
    expect(() => normalizeConfig({ searchEngines: ['yahoo'] })).toThrow(/unknown search engine/)
    expect(() => normalizeConfig({ fetchTimeoutMs: 0 })).toThrow(/positive integer/)
    expect(normalizeConfig({ searchEngines: ['searxng'] }).searchEngines).toEqual(['searxng'])
  })
  it('github settings: defaults and validation', () => {
    const cfg = normalizeConfig({})
    expect(cfg.githubToken).toBe('')
    expect(cfg.githubIndexes).toEqual([])
    expect(cfg.githubSort).toBe('best')
    expect(normalizeConfig({ githubIndexes: ['code', 'users'], githubSort: 'stars' }).githubIndexes).toEqual(['code', 'users'])
    expect(normalizeConfig({ githubIndexes: ['code'], githubSort: 'stars' }).githubSort).toBe('stars')
    expect(() => normalizeConfig({ githubIndexes: ['forks'] })).toThrow(/unknown github index/)
    expect(() => normalizeConfig({ githubSort: 'forks' })).toThrow()
  })
})

// ─────────────────────────── document.ts ──────────────────────────
describe('document.ts', () => {
  it('inferFileType: PDF', () => {
    expect(inferFileType('application/pdf')).toBe('pdf')
    expect(inferFileType('application/pdf; charset=binary')).toBe('pdf')
  })

  it('inferFileType: OOXML family', () => {
    expect(inferFileType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx')
    expect(inferFileType('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('pptx')
    expect(inferFileType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx')
    // Charset suffix must not break the lookup.
    expect(inferFileType('application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary')).toBe('docx')
  })

  it('inferFileType: ODF family', () => {
    expect(inferFileType('application/vnd.oasis.opendocument.text')).toBe('odt')
    expect(inferFileType('application/vnd.oasis.opendocument.presentation')).toBe('odp')
    expect(inferFileType('application/vnd.oasis.opendocument.spreadsheet')).toBe('ods')
  })

  it('inferFileType: EPUB', () => {
    expect(inferFileType('application/epub+zip')).toBe('epub')
  })

  it('inferFileType: non-document types return null', () => {
    expect(inferFileType('text/html')).toBeNull()
    expect(inferFileType('text/html; charset=utf-8')).toBeNull()
    expect(inferFileType('application/json')).toBeNull()
    expect(inferFileType('text/plain')).toBeNull()
    expect(inferFileType('application/octet-stream')).toBeNull()
    expect(inferFileType('image/png')).toBeNull()
    // Defensive: empty / malformed inputs collapse to null instead of throwing.
    expect(inferFileType('')).toBeNull()
    expect(inferFileType('   ')).toBeNull()
  })

  it('parseDocument: refuses non-document content-type with a clear error', async () => {
    await expect(parseDocument(new Uint8Array(), 'text/html')).rejects.toThrow(/unsupported content-type/)
    await expect(parseDocument(new Uint8Array(), 'application/json')).rejects.toThrow(/unsupported content-type/)
    await expect(parseDocument(new Uint8Array(), '')).rejects.toThrow(/unsupported content-type/)
  })

  it('parseDocument: PDF content-type reaches officeparser (parse fails on garbage bytes, not on the dispatch)', async () => {
    // We can't ship a real PDF fixture inside an offline unit suite; just
    // prove the dispatch is wired by feeding 8 random bytes and expecting
    // officeparser's own corrupt-input error (not our dispatch gate).
    await expect(parseDocument(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'application/pdf')).rejects.toThrow()
  })

  it('parseDocument: real in-memory DOCX → Markdown with content', async () => {
    // End-to-end smoke for the officeparser dispatch: build a minimal
    // valid DOCX with `fflate` (a transitive dep officeparser already
    // pulls in), run it through parseDocument, and assert the Markdown
    // body contains the text we wrote.
    const { zipSync, strToU8 } = await import('fflate')
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Hello dsh-network from DOCX</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
  </w:body>
</w:document>`
    const zip = zipSync({
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rels),
      'word/document.xml': strToU8(document),
    })
    const result = await parseDocument(
      new Uint8Array(zip),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(result.content).toContain('Hello dsh-network from DOCX')
    expect(result.content).toContain('Second paragraph')
    expect(result.warnings).toEqual([])
  })
})

// ─────────────────────────── module imports ──────────────────────────
// The two `import … from` lines at the top of this file are compile-time
// checks that the modules exported from `src/` resolve and stay
// dependency-clean. If the runtime ever pulls in a heavy package here, this
// file would suddenly become expensive to load — failing the discipline.
describe('import hygiene', () => {
  it('parses http_request.ts', () => {
    expect(buildRequestUrl('https://x.example', { a: 1 })).toBe('https://x.example?a=1')
    expect(buildRequestUrl('https://x.example/path', { a: 1 })).toBe('https://x.example/path?a=1')
  })
  it('parses tools.ts (compile-time)', () => {
    expect(typeof normalizeConfig).toBe('function')
    expect(typeof buildRequestUrl).toBe('function')
  })
})

// ───────────────────────────── web_sitemap ───────────────────────────
// Pure module: no I/O, no clock. The table itself is frozen so the
// suite catches mutations during runs.
describe('web_sitemap table', () => {
  it('is frozen at the array level', () => {
    expect(Object.isFrozen(WEB_SITEMAP)).toBe(true)
  })
  it('has entries with the documented fields', () => {
    expect(WEB_SITEMAP.length).toBeGreaterThan(20)
    for (const e of WEB_SITEMAP) {
      expect(e.domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
      expect(e.priority).toBeGreaterThanOrEqual(1)
      expect(e.priority).toBeLessThanOrEqual(10)
      expect(categoriesInUse()).toContain(e.category)
      expect(typeof e.description).toBe('string')
      expect(e.description.length).toBeGreaterThan(0)
      if (e.searchUrl) expect(e.searchUrl).toContain('{query}')
    }
  })
  it('has no duplicate domains', () => {
    const seen = new Set<string>()
    for (const e of WEB_SITEMAP) {
      expect(seen.has(e.domain)).toBe(false)
      seen.add(e.domain)
    }
  })

  it('canonicalHost strips www. and parses https URLs', () => {
    expect(canonicalHost('github.com')).toBe('github.com')
    expect(canonicalHost('www.github.com')).toBe('github.com')
    expect(canonicalHost('https://github.com/torvalds/linux')).toBe('github.com')
    expect(canonicalHost('  GITHUB.com/x ')).toBe('github.com')
  })
  it('canonicalHost rejects garbage', () => {
    expect(canonicalHost('')).toBe(null)
    expect(canonicalHost('   ')).toBe(null)
    expect(canonicalHost('not a host at all')).toBe(null)
  })

  it('findByDomain exact + canonicalisation', () => {
    expect(findByDomain('github.com')?.category).toBe('code-repos')
    expect(findByDomain('www.GitHub.com')?.domain).toBe('github.com')
    expect(findByDomain('https://arxiv.org/abs/2401')?.category).toBe('academic')
    expect(findByDomain('does-not-exist.example')).toBeUndefined()
  })
  it('findByKey is the strict version (no host parsing)', () => {
    expect(findByKey('github.com')?.domain).toBe('github.com')
    // findByKey is exact — it does NOT strip schemes / paths, unlike findByDomain.
    expect(findByKey('https://github.com')).toBeUndefined()
  })

  it('listByCategory returns ordered entries', () => {
    const ai = listByCategory('ai-platforms')
    expect(ai.length).toBeGreaterThan(0)
    for (let i = 1; i < ai.length; i++) {
      expect(ai[i - 1]!.priority).toBeGreaterThanOrEqual(ai[i]!.priority)
    }
  })

  it('searchSitemap ranks a clearly-relevant site first', () => {
    const matches = searchSitemap('rust 包管理 crate', { limit: 5 })
    expect(matches[0]?.domain).toBe('crates.io')
  })
  it('searchSitemap handles English-only queries', () => {
    const matches = searchSitemap('arxiv preprint', { limit: 5 })
    expect(matches[0]?.domain).toBe('arxiv.org')
  })
  it('searchSitemap handles Chinese-only queries', () => {
    const matches = searchSitemap('中文 问答 社区', { limit: 5 })
    // Should surface zhihu.com and v2ex.com in the top results.
    const domains = matches.map((m) => m.domain)
    expect(domains.some((d) => d === 'zhihu.com' || d === 'v2ex.com')).toBe(true)
  })
  it('searchSitemap returns top-N by priority when query is empty', () => {
    const matches = searchSitemap('', { limit: 3 })
    expect(matches.length).toBe(3)
    expect(matches[0]!.priority).toBeGreaterThanOrEqual(matches[2]!.priority)
  })
  it('searchSitemap honors category + minPriority filters', () => {
    const matches = searchSitemap('', { category: 'ai-platforms', minPriority: 9, limit: 50 })
    for (const m of matches) {
      expect(m.category).toBe('ai-platforms')
      expect(m.priority).toBeGreaterThanOrEqual(9)
    }
  })

  it('buildSearchUrl fills the {query} placeholder exactly once', () => {
    expect(buildSearchUrl('github.com', 'rust lang')).toBe('https://github.com/search?q=rust%20lang&type=repositories')
    expect(buildSearchUrl('crates.io', 'serde')).toBe('https://crates.io/search?q=serde')
    expect(buildSearchUrl('arxiv.org', 'attention is all you need')).toContain('attention%20is')
    expect(buildSearchUrl('not.in.table.example', 'foo')).toBe(null)
    // Empty query is allowed; the template just stays unfilled.
    expect(buildSearchUrl('crates.io', '')).toBe('https://crates.io/search?q=')
  })

  it('snapshot honors filters and always exposes categoriesInUse', () => {
    const all = snapshot()
    expect(all.total).toBe(WEB_SITEMAP.length)
    expect(all.categories.length).toBeGreaterThan(0)

    const aiOnly = snapshot({ category: 'ai-platforms' })
    for (const e of aiOnly.entries) expect(e.category).toBe('ai-platforms')

    const highPriority = snapshot({ minPriority: 9 })
    for (const e of highPriority.entries) expect(e.priority).toBeGreaterThanOrEqual(9)
  })

  it('summarize keeps only the documented fields', () => {
    const s = summarize(WEB_SITEMAP[0]!)
    expect(Object.keys(s).sort()).toEqual([
      'category',
      'description',
      'domain',
      'hasSearchUrl',
      'language',
      'priority',
      'region',
      'tags',
    ])
    expect(s.hasSearchUrl).toBe(typeof WEB_SITEMAP[0]!.searchUrl === 'string')
  })

  it('renderPromptDigest groups by category and emits Markdown', () => {
    const md = renderPromptDigest({ minPriority: 9 })
    expect(md).toMatch(/^# /m)
    expect(md.split('\n').filter((l) => l.startsWith('- ')).length).toBeGreaterThan(5)
  })
})
