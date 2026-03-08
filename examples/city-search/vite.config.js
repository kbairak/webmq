import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: './frontend',
  resolve: {
    alias: {
      '@webmq-frontend/react': path.resolve(
        __dirname,
        '../../packages/frontend/src/react.ts'
      ),
      '@webmq-frontend': path.resolve(
        __dirname,
        '../../packages/frontend/src/index.ts'
      ),
      '@webmq-backend': path.resolve(
        __dirname,
        '../../packages/backend/src/index.ts'
      ),
    },
  },
});
