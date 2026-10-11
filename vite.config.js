import { defineConfig } from 'vite'

// npm run dev : Vite (5173) sert le client, le serveur Node (5174) l'API et le temps réel
const SERVER = process.env.YARICHE_SERVER || 'http://localhost:5174'

export default defineConfig({
  root: './client',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/attachments': SERVER,
      '/uploads': SERVER,
      '/login': SERVER,
      '/logout': SERVER,
      '/auth': SERVER,
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
})
