import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.config.js';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  publicDir: 'public',
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
  },
  server: {
    port: 5174,
    strictPort: true,
    cors: { origin: [/^chrome-extension:\/\//] },
    hmr: { port: 5174 },
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
});
