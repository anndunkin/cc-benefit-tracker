import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      external: ['better-sqlite3', 'electron'],
    },
  },
  optimizeDeps: {
    exclude: ['better-sqlite3'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    environmentMatchGlobs: [
      ['tests/security.test.ts', 'node'],
      ['tests/validation.test.ts', 'node'],
      ['tests/boundary.test.ts', 'node'],
      ['tests/functionality.test.ts', 'node'],
    ],
    alias: [
      { find: 'electron', replacement: path.resolve(__dirname, 'tests/__mocks__/electron.ts') },
    ],
  },
})
