import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findStale, generateTypes, run, type FlagSummary } from '../src';

const now = Date.parse('2026-10-01T00:00:00Z');
const flags: FlagSummary[] = [
  {
    key: 'new-checkout',
    kind: 'boolean',
    variations: [
      { id: 'on', value: true },
      { id: 'off', value: false },
    ],
    environments: { production: { lastEvaluatedAt: '2026-09-30T00:00:00Z' } },
  },
  {
    key: 'dark-mode',
    kind: 'boolean',
    variations: [
      { id: 'on', value: true },
      { id: 'off', value: false },
    ],
    environments: { production: { lastEvaluatedAt: '2026-07-01T00:00:00Z' } },
  },
  {
    key: 'legacy-search',
    kind: 'boolean',
    archivedAt: '2026-01-01T00:00:00Z',
    variations: [
      { id: 'on', value: true },
      { id: 'off', value: false },
    ],
  },
  {
    key: 'pricing-page-layout',
    kind: 'json',
    variations: [
      { id: 'grid', value: { layout: 'grid', columns: 3, highlight: 'pro' } },
      { id: 'list', value: { layout: 'list', columns: 1, highlight: null } },
    ],
  },
  {
    key: 'max-cart-items',
    kind: 'number',
    variations: [
      { id: 'a', value: 5 },
      { id: 'b', value: 20 },
    ],
  },
];

describe('codegen', () => {
  it('generates typed flag keys and module augmentation for both SDKs', () => {
    const output = generateTypes('web-shop', flags, 'fixed');
    expect(output).toContain('"new-checkout": boolean;');
    expect(output).toContain('"max-cart-items": number;');
    expect(output).toContain(
      '"pricing-page-layout": { layout: string; columns: number; highlight: string } | { layout: string; columns: number; highlight: null };',
    );
    expect(output).not.toContain('legacy-search');
    expect(output).toContain("declare module '@ashamrai/flags-node'");
    expect(output).toContain("declare module '@ashamrai/flags-web'");
  });
});

describe('find-stale', () => {
  it('reports archived and long-unevaluated flags referenced in code with locations', async () => {
    const refs = await findStale(join(import.meta.dirname, 'fixtures'), flags, { now, days: 30 });
    expect(refs.map((r) => [r.key, r.status])).toEqual([
      ['dark-mode', 'stale'],
      ['legacy-search', 'archived'],
    ]);
    expect(refs[1]!.locations).toEqual([{ file: 'src/app.ts', line: 5 }]);
  });
});

describe('cli', () => {
  it('runs codegen and find-stale against an API', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/projects/web-shop/flags')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: flags }));
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    process.env.FLAGS_TOKEN = 'token';
    process.env.FLAGS_API_URL = `http://127.0.0.1:${port}`;
    try {
      const dir = await mkdtemp(join(tmpdir(), 'flags-cli-'));
      const lines: string[] = [];
      expect(
        await run(['codegen', '--project', 'web-shop', '--out', join(dir, 'flags.gen.ts')], (l) =>
          lines.push(l),
        ),
      ).toBe(0);
      expect(await readFile(join(dir, 'flags.gen.ts'), 'utf8')).toContain('GeneratedFlagTypes');
      expect(
        await run(
          ['find-stale', '--project', 'web-shop', '--dir', join(import.meta.dirname, 'fixtures'), '--fail'],
          (l) => lines.push(l),
        ),
      ).toBe(1);
      expect(lines.join('\n')).toContain('legacy-search (archived');
      expect(await run([], (l) => lines.push(l))).toBe(0);
    } finally {
      delete process.env.FLAGS_TOKEN;
      server.close();
    }
  });
});
