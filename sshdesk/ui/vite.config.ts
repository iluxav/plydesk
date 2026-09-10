import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  // Tauri serves the bundle from a custom protocol, not a web root.
  // Absolute /assets/... paths do not resolve there; relative ones do.
  base: './',
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // App views load this server through their own appview:// origin, which has
  // no port, so the hot-reload client must be told where the socket is rather
  // than guessing from location.host.
  server: { port: 5173, strictPort: true, hmr: { host: 'localhost', port: 5173 } },
  build: { target: 'esnext', emptyOutDir: true, rolldownOptions: {
    input: { main: resolve(import.meta.dirname, 'index.html'), runtime: resolve(import.meta.dirname, 'runtime.html') },
  } },
})
