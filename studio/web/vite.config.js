import { defineConfig } from 'vite';

const API = process.env.API_URL || 'http://localhost:8765';

export default defineConfig({
  // Vite serves the page with hot reload; the Python backend (studio/server.py) keeps owning the data.
  server: {
    port: 5173,
    open: false,
    proxy: {
      '/api': API,
      '/assets': API,   // generated plates
      '/outputs': API,  // exported mp4
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'static', // not "assets": the backend already serves /assets/ai-plates
  },
});
