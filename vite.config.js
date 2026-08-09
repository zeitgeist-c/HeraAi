import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'

import manifest from './manifest.json'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
  ],
  worker: {
    format: 'es',
  },
  build: {
    // Chrome extension pages do not need Vite's modulepreload polyfill. The
    // generated preload link is treated as a cross-world resource mismatch in
    // offscreen documents and is reported as an extension error by Chrome.
    modulePreload: false,
    rollupOptions: {
      input: {
        app: resolve(projectRoot, 'index.html'),
        micPermission: resolve(projectRoot, 'mic-permission.html'),
        offscreen: resolve(projectRoot, 'offscreen.html'),
      },
    },
  },
})
