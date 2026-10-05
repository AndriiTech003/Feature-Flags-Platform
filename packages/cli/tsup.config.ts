import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node20',
  },
  {
    entry: ['src/bin.ts'],
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    target: 'node20',
    sourcemap: true,
  },
]);
