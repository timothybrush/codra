import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@client': path.resolve(rootDir, 'src/client'),
      '@server': path.resolve(rootDir, 'src/server'),
      '@': path.resolve(rootDir, 'src/client'),
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: mode !== 'development',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
              return 'vendor-react';
            }
            if (id.includes('recharts')) {
              return 'vendor-recharts';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-lucide';
            }
            if (id.includes('motion')) {
              return 'vendor-motion';
            }
            if (id.includes('remark') || id.includes('rehype') || id.includes('micromark') || id.includes('markdown')) {
              return 'vendor-markdown';
            }
            if (id.includes('@base-ui')) {
              return 'vendor-base-ui';
            }
            if (id.includes('hono') || id.includes('zod') || id.includes('jsonrepair')) {
              return 'vendor-utils';
            }
            return 'vendor';
          }
        },
      },
    },
  },
}));
