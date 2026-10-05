import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { server: 'src/server/main.ts', traffic: 'src/traffic.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    clean: true,
    sourcemap: true,
  },
  {
    entry: { app: 'src/client/app.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2020',
    outDir: 'public/build',
    minify: true,
    noExternal: [/.*/],
    clean: true,
  },
]);
