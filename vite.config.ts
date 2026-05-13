import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/uploads': 'http://localhost:3001',
    },
  },
})
