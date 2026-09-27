import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the daemon at /ui/. No inline scripts or styles: the daemon's CSP is 'self' only.
export default defineConfig({
  base: '/ui/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});
