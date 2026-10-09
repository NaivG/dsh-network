/**
 * dsh-network — DeepSeek Harness (dsh) plugin, host side (entry).
 *
 * Hand-written ESM, no build step, no dsh package imports: the loader hands
 * `apply(ctx, config)` a live cordis context and we register into the
 * existing registries. The heavy lifting (network I/O, HTML→Markdown,
 * engine parsing) lives in the bundled CLI binary at `dist/cli.cjs`,
 * version-locked with this plugin so updating either side moves the other.
 *
 * This file is the WIRING only: the plugin contract exports (`name` /
 * `inject`), the eager server start + lifecycle binding, and the apply()
 * assembly of the split-out host modules:
 *
 *   - `./schemas.js`        JSON Schema outputs + enum vocabularies
 *   - `./cli-runner.js`     persistent server client singleton + runners
 *   - `./evidence.js`       model-facing evidence rendering
 *   - `./providers.js`      web seam providers (search / fetch)
 *   - `./tools.js`          the five model-facing tool registrations
 *   - `./routes.js`         loopback HTTP routes (config/health/search)
 *   - `./config-summary.js` config projection, mutation, request fence
 *
 * Why hand-written JS and not a TS bundle:
 *
 *   - vite's lib mode replaces every `node:*` import with
 *     `__vite-browser-external` during scope analysis, regardless of
 *     `build.target: 'node20'` and external lists. A built host bundle
 *     therefore drops `spawn`, `fileURLToPath`, `readFileSync` to
 *     `undefined` at runtime. The CLI binary handles all those
 *     imports in a Node-targeted build without the lib-mode trip-up,
 *     and plain hand-written files never go through lib mode.
 *   - Schema definitions are JSON Schema objects, so TypeScript buys
 *     little. Modsearch applies the same separation.
 */
import { loadPersistedConfig } from './persist.js'
import { defaultConfig } from './config-summary.js'
import { getNetworkClient, releaseNetworkClient } from './cli-runner.js'
import { makeSearchProvider, makeFetchProvider } from './providers.js'
import {
  registerWebSearchTool,
  registerWebFetchTool,
  registerHttpRequestTool,
  registerWebConfigTool,
  registerWebSitemapTool,
  registerWebDownloadTool,
} from './tools.js'
import { registerConfigRoute, registerHealthRoute, registerSearchRoute } from './routes.js'

// Cordis keeps no copy of the entry config after apply() returns, so
// `apply()` resolves the row config once into a live object the loopback
// route mutates; policy fields are read again at every tool call.
export const name = 'dsh-network'
export const inject = ['tools', 'web', 'systemPrompt']

export function apply(ctx, rawConfig) {
  // Durable overlay: the persisted snapshot (written by the loopback route on
  // every UI save, see registerConfigRoute) wins over the cordis row config,
  // so UI edits survive restarts. `enabled` is never part of the snapshot and
  // is stripped here too — the row config is the only kill-switch, so a
  // hand-edited file cannot disable the plugin past the route that could
  // re-enable it. Delete the file to reset to row config.
  const persisted = loadPersistedConfig()
  if (persisted.error) {
    ctx.logger?.warn?.(
      '[dsh-network] ignoring unreadable config file %s: %s',
      persisted.file,
      persisted.error.message ?? String(persisted.error),
    )
  }
  const persistedOverlay = persisted.value ? { ...persisted.value } : null
  if (persistedOverlay) delete persistedOverlay.enabled
  const seed = persistedOverlay ? { ...(rawConfig ?? {}), ...persistedOverlay } : rawConfig
  const config = defaultConfig(seed)
  if (!config.enabled) {
    ctx.logger?.info?.('[dsh-network] disabled by config')
    return
  }

  // ── eager server start + lifecycle binding ─────────────────────────────
  // One persistent `dsh-network server` child handles every tool call. We
  // spawn it at apply() so the first user-visible invocation doesn't pay
  // the cold-start cost (Node + undici + officeparser ≈ a couple seconds
  // on Windows). The effect disposer below binds the child to this cordis
  // fiber — the server dies when dsh unloads, alongside the providers and
  // tools registered below.
  //
  // ensure() failure here is logged but NOT fatal: a misconfigured dist
  // (missing cli.cjs, port already taken, …) shouldn't block the whole
  // plugin from loading, and the tool execute paths will surface a clear
  // error on first use. The compact summary's eager strategy is preserved
  // by retrying on every invoke() — serverClient respawns on death.
  const client = getNetworkClient()
  client.ensure().catch((error) => {
    ctx.logger?.warn?.(
      '[dsh-network] failed to pre-warm server (will retry on first tool call): %s',
      error?.message ?? String(error),
    )
  })
  ctx.logger?.info?.('[dsh-network] server client initialized (pid=%s)', client.pid)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void client.dispose()
      // Release the module singleton (cli-runner.js). A disposed client can
      // never serve another call (`ensure()` throws "server client is
      // disposed"), and this module outlives every cordis fiber — so without
      // dropping the reference, the NEXT apply() (plugin reload after
      // `plugin add`, a settings save that re-applies the row, a session
      // fiber restart) would hand out the corpse and every tool call + the
      // health route would fail with that opaque error for the rest of the
      // host's lifetime.
      releaseNetworkClient(client)
    })
  }

  // ── providers into the web seam ─────────────────────────────────────────
  const searchProvider = makeSearchProvider(config)
  const fetchProvider = makeFetchProvider(config)

  // Both providers live on ctx.web and degrade gracefully in headless
  // contexts where ctx.web may not exist.
  if (ctx.web && typeof ctx.web.registerSearchProvider === 'function') {
    ctx.web.registerSearchProvider({
      id: searchProvider.id,
      available: searchProvider.available,
      search: searchProvider.search,
    })
  }
  if (ctx.web && typeof ctx.web.registerFetchProvider === 'function') {
    ctx.web.registerFetchProvider({
      id: fetchProvider.id,
      available: fetchProvider.available,
      fetch: fetchProvider.fetch,
    })
  }

  // ── model-facing tools ─────────────────────────────────────────────────
  if (config.webSearchTool) registerWebSearchTool(ctx, config)
  if (config.webFetchTool) registerWebFetchTool(ctx, config)
  if (config.httpRequestTool) registerHttpRequestTool(ctx, config)
  if (config.webSitemapTool) registerWebSitemapTool(ctx, config)
  if (config.webConfigTool !== false) registerWebConfigTool(ctx, config)
  // web_download is gated at REGISTRATION time (not at call time like the
  // rest): it is off by default, and a tool that is not registered is
  // absent from the model's tool list entirely — a stronger statement than
  // a call that throws.
  if (config.downloadTool === true) registerWebDownloadTool(ctx, config)

  // ── settings: NO settings-namespace registration, own durable file ─────
  // A `dsh-network` namespace in the settings document would be persisted,
  // but this plugin's runtime reads the cordis row config (cordis.patch.yml)
  // plus the live in-memory object the loopback route edits — a persisted
  // `dsh-network:` section would silently do nothing and mislead users.
  // Durability instead comes from `dsh/persist.js`: every successful UI save
  // snapshots the live config to ~/.dsh/dsh-network.json (atomic write), and
  // `apply()` above reloads it, so UI edits survive restarts.
  // The browser surface is the dedicated "网络" settings section
  // (`settings.section`, in dsh/client.js) talking to the loopback route
  // below; the legacy Plugins-tab card stays dormant in stock profiles.
  registerConfigRoute(ctx, config)
  registerHealthRoute(ctx)
  registerSearchRoute(ctx, config)

  ctx.logger?.info?.(
    '[dsh-network] active (engines=%s, fetchTimeoutMs=%d, httpTimeoutMs=%d, tools: search=%s fetch=%s http=%s sitemap=%s config=%s download=%s, allowConfigEdit=%s)',
    config.searchEngines.join(','),
    config.fetchTimeoutMs,
    config.httpTimeoutMs,
    String(config.webSearchTool),
    String(config.webFetchTool),
    String(config.httpRequestTool),
    String(config.webSitemapTool),
    String(config.webConfigTool),
    String(config.downloadTool === true),
    String(config.allowConfigEdit),
  )
}
