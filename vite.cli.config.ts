// CLI entry: a single CommonJS bundle the host plugin spawns. It is a sibling
// of the host (no shared state), reads its own config from the host's stdin
// pipe, and emits one JSON envelope on stdout. CJS keeps child_process spawn
// arguments as plain strings (no ESM URL dance) and works under Electron's
// `ELECTRON_RUN_AS_NODE` (see dsh/index.js).
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'node20',
    // SSR build keeps `node:*` imports as real Node imports instead of the
    // browser `__vite-browser-external` stub. Without it, `node:dns` (and any
    // other built-in) is rewritten to a stub that has no named exports, so
    // `import { promises as dns } from 'node:dns'` fails to build (see AGENTS.md).
    ssr: true,
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/cli.ts',
      formats: ['cjs'],
      fileName: () => 'cli.cjs',
    },
    rollupOptions: {
      external: ['undici', 'node:*'],
    },
  },
})
