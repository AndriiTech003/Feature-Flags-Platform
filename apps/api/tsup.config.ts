import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/index.ts', 'src/seed.ts', 'src/db/migrate-cli.ts', 'src/outbox-main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: true,
});
