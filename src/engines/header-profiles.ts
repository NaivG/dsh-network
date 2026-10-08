/**
 * dsh-network search engine header profiles.
 *
 * The free search engines (Bing, DuckDuckGo, Baidu) detect bots by the
 * HTTP fingerprint: missing `Sec-Fetch-*` headers, default Node
 * `User-Agent`, plain `Accept: *\/*`, etc. We send a Firefox-154 desktop
 * profile so the engines serve real results instead of challenge pages.
 *
 * Per-engine tweaks live in each engine file (e.g. Baidu's `Host` and
 * omitted `Accept-Encoding`); this module owns the shared baseline so a
 * future Chrome profile can sit beside it.
 *
 */

const FIREFOX_154_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0'

const EDGE_151_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0' // Newer Edge send `Edg` instead of `Edge` in the UA string.

/**
 * The baseline profile: Sec-Fetch-Dest/Mode/Site/User, DNT, Upgrade-
 * Insecure-Requests, full Accept with avif/webp, and English+Chinese
 * Accept-Language. Engines spread this base then add their own overrides
 * (Bing adds `TE: trailers`, Baidu overrides `Host` and strips
 * `Accept-Encoding`).
 *
 * `TE: trailers` is intentionally absent from the base because not
 * every server tolerates it; engines that need it add it explicitly.
 */
export const BROWSER_BASE: Readonly<Record<string, string>> = {
  'User-Agent': FIREFOX_154_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,*;q=0.6',
  'Accept-Encoding': 'gzip, deflate, br',
  DNT: '1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
} as const

/**
 * Bing-specific overlay. Bing's anti-bot gates on:
 *   - `Sec-Fetch-User: ?1` (must be present for top-level navigations)
 *   - `TE: trailers` (mild bot signal when absent — Bing still serves
 *     without it, but it scores the request higher)
 *   - The query params `pc=MOZI&form=MOZLBR` (cosmetic; tells Bing the
 *     client is on a layout the new Bing homepage assumes). See bing.ts.
 */
export const FIREFOX_BING: Readonly<Record<string, string>> = {
  ...BROWSER_BASE,
  TE: 'trailers',
  'User-Agent': EDGE_151_UA,
} as const

/**
 * DuckDuckGo-specific overlay. DDG's `/html` lite endpoint accepts the
 * Firefox base unchanged. The only engine-specific knob is that DDG
 * serves correct results only to navigations, so Sec-Fetch-Mode is
 * already `navigate` from the base.
 */
export const FIREFOX_DUCKDUCKGO: Readonly<Record<string, string>> = {
  ...BROWSER_BASE,
} as const

/**
 * Baidu-specific overlay. Baidu is the most sensitive of the three:
 *   - It demands `Host: www.baidu.com` (a few reverse proxies break
 *     otherwise).
 *   - It does NOT want `Accept-Encoding: br` (sometimes serves a stale
 *     cache when brotli is requested). `gzip, deflate` only.
 *   - It likes a slightly newer Firefox UA — Tessera's tests pinned
 *     154 and saw fewer 302s to the captcha page.
 *   - The query param `ie=utf-8` overrides Baidu's default GB2132 —
 *     without it, Chinese characters come back mojibake.
 */
export const FIREFOX_BAIDU: Readonly<Record<string, string>> = {
  ...BROWSER_BASE,
  'Accept-Encoding': 'gzip, deflate',
  Host: 'www.baidu.com',
  'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,en-US;q=0.8,en;q=0.8,zh-HK;q=0.7',
} as const

/**
 * Generic "browser-shaped" fetch profile used by the non-search
 * `web_fetch` tool. Mirrors the Firefox base so a default fetch looks
 * like a real browser navigation, which keeps static sites from
 * blocking or rewriting the response.
 *
 * Lives here (next to the engine profiles) so any future tweak to the
 * base fingerprint automatically benefits both the engine chain and
 * the bare fetch path.
 */
export const BROWSER_FETCH_BASE: Readonly<Record<string, string>> = BROWSER_BASE
