import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Project Pages URL is https://<user>.github.io/slakk/
export default defineConfig({
  base: process.env.SLAKK_BASE || '/slakk/',
  // Do not set COEP require-corp here: Kartverket/NVE lack CORP headers, so DEM
  // fetch would fail. Isolation for Wasm threads uses coi-serviceworker
  // (credentialless) in production.
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        howItWorks: resolve(__dirname, 'how-it-works.html'),
      },
    },
  },
  worker: {
    format: 'es',
  },
});
