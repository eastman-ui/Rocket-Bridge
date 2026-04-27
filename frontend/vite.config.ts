import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: ['react-plotly.js', 'plotly.js'],
  },
  server: {
    watch: {
      usePolling: true,
      interval: 300,
    },
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:8080',
        rewrite: (path) => path.replace(/^\/api/, ''),
      }
    }
  }
})
