import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: './frontend',
  resolve: {
    alias: {
      '@webmq-frontend': path.resolve(
        __dirname,
        '../../packages/frontend/src/index.ts'
      ),
    },
  },
});
