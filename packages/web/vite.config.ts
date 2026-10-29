import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Mermaid diagrams (src/diagrams.ts): the single-file browser build, emitted as one hashed asset and
// loaded on first use. Bundling the ESM build instead would add dozens of chunks to the daemon's
// integrity manifest.
const mermaidSource = readFileSync(join(dirname(createRequire(import.meta.url).resolve('mermaid/package.json')), 'dist/mermaid.min.js'));
const mermaidFile = `assets/mermaid-${createHash('sha256').update(mermaidSource).digest('hex').slice(0, 8)}.min.js`;
const mermaidAsset: Plugin = {
  name: 'mermaid-asset',
  configureServer(server) {
    server.middlewares.use(`/ui/${mermaidFile}`, (_req, res) => { res.setHeader('Content-Type', 'text/javascript'); res.end(mermaidSource); });
  },
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: mermaidFile, source: mermaidSource });
  },
};

// Served by the daemon at /ui/. No inline scripts or styles: the daemon's CSP is 'self' only.
export default defineConfig({
  base: '/ui/',
  plugins: [react(), mermaidAsset],
  define: { __MERMAID_JS__: JSON.stringify(mermaidFile) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});
