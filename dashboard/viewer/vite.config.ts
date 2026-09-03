import path from 'node:path';
import { defineConfig } from 'vite';

// Self-contained library build for the v3 viewer. Bundles the decoder,
// the CardMirror schema, and loro-crdt's WASM into dist/, which the
// dashboard imports as an ES module. es2022 target: loro-crdt's wasm
// loader uses top-level await. The emitted .wasm sits next to viewer.mjs
// and is fetched relative to it — so dist/ must be SERVED, not opened
// from file://.
export default defineConfig({
  // Don't copy the repo's public/ dir into the viewer bundle.
  publicDir: false,
  resolve: {
    // The default loro-crdt "browser" entry loads its WASM via synchronous
    // XMLHttpRequest. The "base64" entry embeds the WASM and instantiates it
    // asynchronously — self-contained, no separate asset, no sync XHR, works
    // in browser and node. Exact-match so ./base64, ./web subpaths are safe.
    alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/base64' }],
  },
  build: {
    target: 'es2022',
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: path.resolve(__dirname, 'resolve-name.ts'),
      formats: ['es'],
      fileName: () => 'viewer.mjs',
    },
    rollupOptions: {
      output: { inlineDynamicImports: false },
    },
  },
});
