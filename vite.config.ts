import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './', plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
