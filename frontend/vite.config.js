import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The console talks only to the Go gateway (:8080). The Python engine stays private.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.GATEWAY_URL || 'http://localhost:8080', changeOrigin: true },
    },
  },
});
