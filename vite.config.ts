import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: Number(process.env.PORT) || 5173, open: false },
  build: { target: 'es2022', sourcemap: true },
});
