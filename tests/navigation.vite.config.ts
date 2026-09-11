import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: { alias: { 'next/navigation': fileURLToPath(new URL('./navigation-router.ts', import.meta.url)), '@': fileURLToPath(new URL('..', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 4175, strictPort: true },
});
