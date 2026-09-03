import path from 'node:path';
import { defineConfig } from 'vite';

// Bundles the Path B pairing client (identity + mailbox invites) for the
// browser. Pure WebCrypto + IndexedDB — no WASM — so this is a small
// module. Must be SERVED (http): it uses IndexedDB and ES module imports,
// which don't work from file://.
export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: path.resolve(__dirname, 'pairing-client.ts'),
      formats: ['es'],
      fileName: () => 'member.mjs',
    },
  },
});
