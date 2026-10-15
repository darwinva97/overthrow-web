import { defineConfig } from 'vite';

// En desarrollo, el WebSocket y las imágenes van al servidor de juego.
export default defineConfig({
  // El cliente usa versiones ligeras de los datos (scripts/gen-client-meta.ts).
  resolve: {
    alias: [
      { find: /^\.\/abilities\.json$/, replacement: './abilities.client.json' },
      { find: /^\.\/units\.json$/, replacement: './units.client.json' },
    ],
  },
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4060', ws: true },
      '/cdn': 'http://127.0.0.1:4060',
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
