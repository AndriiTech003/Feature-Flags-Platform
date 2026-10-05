import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: false,
  clean: true,
  sourcemap: true,
});
