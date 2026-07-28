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
    rollupOptions: {
      input: {
        app: resolve(projectRoot, 'index.html'),
        offscreen: resolve(projectRoot, 'offscreen.html'),
      },
    },
  },
})
