/**
 * `prepare` hook: build `dist/cli.cjs` when a git-hosted install asks for it.
 *
 * `dsh plugin add github:NaivG/dsh-network` installs this package from its git
 * source, and `dist/` is gitignored — so pnpm clones the repo, installs the
 * dependencies, and runs `prepare` to produce the CLI bundle the host spawns.
 * pnpm's build-script policy gates that step behind `allowBuilds` in the
 * *profile's* pnpm-workspace.yaml; when it is allowed, this file is what
 * actually produces the bundle.
 *
 * Skips (exit 0) instead of failing when the dev toolchain is absent, so
 * `pnpm install --prod` or a prebuilt/packed install never breaks on it. A
 * missing bundle is still reported loudly by dsh/serverClient.js at spawn
 * time ("dsh-network CLI bundle is missing").
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const vite = fileURLToPath(new URL('node_modules/vite/bin/vite.js', root))

if (!existsSync(vite)) {
  console.warn(
    '[dsh-network] prepare: vite is not installed (devDependencies missing) — ' +
      'skipping the CLI build. Run `pnpm install` followed by `pnpm build`.',
  )
  process.exit(0)
}

const result = spawnSync(
  process.execPath,
  [vite, 'build', '--config', 'vite.cli.config.ts'],
  { cwd: fileURLToPath(root), stdio: 'inherit' },
)

process.exit(result.status ?? 1)