import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
})
