/**
 * `prepare` / `prepack` hook: build `dist/cli.cjs` into the working tree.
 *
 * Two callers, one job:
 *
 *   - **npm publish / npm pack** (`prepack`, and `prepare` right after it) —
 *     `dist/` is gitignored, so without this the published tarball would ship
 *     no CLI bundle and every tool call on a registry install would die with
 *     "dsh-network CLI bundle is missing" (`assertCliPresent()` in
 *     dsh/serverClient.js).
 *   - **git installs** (`dsh plugin add github:NaivG/dsh-network`) — pnpm
 *     clones the repo, installs devDependencies, and runs `prepare` to
 *     produce the bundle the host spawns. pnpm's build-script policy gates
 *     that step behind `allowBuilds` in the *profile's* pnpm-workspace.yaml.
 *
 * Because npm runs BOTH hooks around one pack, the build is skipped when
 * `dist/cli.cjs` is already newer than every CLI input — `pnpm build` and a
 * re-pack stay cheap. Set `DSH_NETWORK_FORCE_BUILD=1` to bypass the check.
 *
 * Skips (exit 0) instead of failing when the dev toolchain is absent, so
 * `pnpm install --prod` or a prebuilt/packed install never breaks on it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)
const vite = fileURLToPath(new URL('node_modules/vite/bin/vite.js', root))
const bundle = fileURLToPath(new URL('dist/cli.cjs', root))

if (!existsSync(vite)) {
  console.warn(
    '[dsh-network] prepare: vite is not installed (devDependencies missing) — ' +
      'skipping the CLI build. Run `pnpm install` followed by `pnpm build`.',
  )
  process.exit(0)
}

/** Newest mtime under `dir`, or 0 when it cannot be read. */
function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    try {
      newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
    } catch {
      // A race with an editor's atomic write is not worth failing over.
    }
  }
  return newest
}

/**
 * True when the bundle is at least as new as every CLI input. Any doubt
 * (missing bundle, unreadable tree) returns false and rebuilds.
 */
function bundleIsFresh() {
  if (!existsSync(bundle)) return false
  try {
    const built = statSync(bundle).mtimeMs
    const inputs = [newestMtime(join(rootPath, 'src'))]
    for (const file of ['vite.cli.config.ts', 'package.json']) {
      const full = join(rootPath, file)
      inputs.push(existsSync(full) ? statSync(full).mtimeMs : 0)
    }
    return inputs.every((mtime) => built >= mtime)
  } catch {
    return false
  }
}

if (process.env.DSH_NETWORK_FORCE_BUILD !== '1' && bundleIsFresh()) {
  console.log('[dsh-network] prepare: dist/cli.cjs is up to date — skipping the build.')
  process.exit(0)
}

const result = spawnSync(
  process.execPath,
  [vite, 'build', '--config', 'vite.cli.config.ts'],
  { cwd: rootPath, stdio: 'inherit' },
)

process.exit(result.status ?? 1)
