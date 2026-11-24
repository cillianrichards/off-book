// Builds the progressive web app (P2-14). In development, Vite serves the client and passes the API and
// the game WebSocket through to the live server, so both share one origin as they will when deployed.

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.OFF_BOOK_SERVER ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': server,
      '/play': { target: server, ws: true },
    },
  },
  build: { sourcemap: true },
});
