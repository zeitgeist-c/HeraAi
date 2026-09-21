import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'

import manifest from './manifest.json'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '')
  const googleOAuthClientId = env.VITE_GOOGLE_OAUTH_CLIENT_ID?.trim()
  const buildManifest = googleOAuthClientId
    ? {
        ...manifest,
        oauth2: {
          client_id: googleOAuthClientId,
          scopes: ['https://www.googleapis.com/auth/drive.appdata'],
        },
      }
    : manifest

  return {
    plugins: [
      react(),
      crx({ manifest: buildManifest }),
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
  }
})
