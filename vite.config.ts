import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => {
  // Without this, builds can inherit a development NODE_ENV and ship React's
  // development runtime, which is several times slower.
  if (command === 'build') process.env.NODE_ENV = 'production';
  return {
    base: './',
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { chunkSizeWarningLimit: 4500 },
  };
});
