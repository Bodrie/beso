import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const API_PROXY_TARGET = process.env.VITE_DEV_API_URL ?? 'http://localhost:3000';

// Same-origin in development and in `vite preview` (e2e): cookies stay first-party and CORS never applies.
const apiProxy = {
  '/api': { target: API_PROXY_TARGET, changeOrigin: false },
  '/socket.io': { target: API_PROXY_TARGET, ws: true },
};

// Long-lived framework code gets its own chunk so it caches across releases. The small runtimes
// every screen needs (the theme, lucide's icon factory but not the icons, the class-name
// helpers) ride with it: left to the bundler, they land in a chunk of their own whenever a lazy
// chunk's imports change shape, and the glue of one more initial file is what then breaks the
// first-paint budget.
const REACT_PACKAGES = [
  'react',
  'react-dom',
  'scheduler',
  'react-router',
  'next-themes',
  'clsx',
  'tailwind-merge',
];
const isIconRuntime = (id: string): boolean =>
  id.includes('/node_modules/lucide-react/') && !id.includes('/icons/');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  build: {
    rollupOptions: {
      output: {
        // Long-lived vendor chunks cache across releases; the app code changes far more often.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (REACT_PACKAGES.some((name) => id.includes(`/node_modules/${name}/`))) return 'react';
          if (isIconRuntime(id)) return 'react';
          if (id.includes('socket.io') || id.includes('engine.io')) return 'socket';
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**'],
    css: false,
    // Dialog flows type into several fields; on a loaded CI runner they can pass 5 s.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
