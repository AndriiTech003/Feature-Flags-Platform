import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../scripts/check-size.mjs';
import { router } from '../src/router';
import { vendorChunk } from '../vendor-chunks';

const dirs: string[] = [];

function fakeDist(files: Record<string, number>, initial: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ffp-dash-size-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  for (const [name, size] of Object.entries(files)) {
    let content = '';
    let seed = name.length;
    while (content.length < size) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      content += seed.toString(36);
    }
    writeFileSync(join(dir, 'assets', name), content.slice(0, size));
  }
  const tags = initial.map((n) => `<link rel="modulepreload" href="/assets/${n}">`).join('\n');
  writeFileSync(join(dir, 'index.html'), `<html><head>${tags}</head></html>`);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const lazyChunks = {
  'vendor-charts-a.js': 1000,
  'vendor-dnd-a.js': 1000,
  'flag-detail-a.js': 1000,
  'experiment-detail-a.js': 1000,
};

describe('dashboard bundle budget', () => {
  it('assigns third-party modules to stable vendor chunks', () => {
    expect(vendorChunk('/x/node_modules/.pnpm/react-dom@19/node_modules/react-dom/client.js')).toBe(
      'vendor-react',
    );
    expect(vendorChunk('/x/node_modules/.pnpm/recharts@3/node_modules/recharts/es6/index.js')).toBe(
      'vendor-charts',
    );
    expect(vendorChunk('/x/node_modules/.pnpm/d3-scale@4/node_modules/d3-scale/src/linear.js')).toBe(
      'vendor-charts',
    );
    expect(vendorChunk('/x/node_modules/@dnd-kit/core/dist/core.esm.js')).toBe('vendor-dnd');
    expect(vendorChunk('/x/node_modules/@tanstack/react-router/dist/esm/index.js')).toBe('vendor-router');
    expect(vendorChunk('/x/node_modules/sonner/dist/index.mjs')).toBe('vendor');
    expect(vendorChunk('/x/apps/dashboard/src/pages/flag-detail.tsx')).toBeNull();
  });

  it('loads every project page lazily', () => {
    const lazy = Object.values(router.routesById)
      .filter((route) => route.id.startsWith('/projects/$project/'))
      .map((route) => route.options.component as unknown as { preload?: unknown });
    expect(lazy.length).toBe(13);
    for (const component of lazy) expect(typeof component.preload).toBe('function');
  });

  it('passes when chunks are within budget and heavy chunks are lazy', () => {
    const dir = fakeDist({ ...lazyChunks, 'index-a.js': 2000, 'vendor-react-a.js': 3000 }, [
      'index-a.js',
      'vendor-react-a.js',
    ]);
    const result = check(dir, { chunkRawBytes: 5000, initialGzipBytes: 100000, lazyOnly: ['vendor-charts'] });
    expect(result.problems).toEqual([]);
    expect(result.chunks.find((c) => c.name === 'index-a.js')?.initial).toBe(true);
    expect(result.chunks.find((c) => c.name === 'vendor-charts-a.js')?.initial).toBe(false);
  });

  it('fails on an oversized chunk, an eager heavy chunk and a missing split', () => {
    const dir = fakeDist({ ...lazyChunks, 'index-a.js': 9000 }, ['index-a.js', 'vendor-charts-a.js']);
    const result = check(dir, {
      chunkRawBytes: 5000,
      initialGzipBytes: 100,
      lazyOnly: ['vendor-charts', 'vendor-missing'],
    });
    expect(result.problems.some((p) => p.startsWith('index-a.js is'))).toBe(true);
    expect(result.problems.some((p) => p.includes('initial JavaScript'))).toBe(true);
    expect(result.problems).toContain('vendor-charts-a.js is loaded eagerly but must be lazy');
    expect(result.problems).toContain('no vendor-missing chunk was emitted');
  });
});
