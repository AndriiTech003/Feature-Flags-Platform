import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const KB = 1024;

export const budgets = {
  chunkRawBytes: 400 * KB,
  initialGzipBytes: 260 * KB,
  lazyOnly: ['vendor-charts', 'vendor-dnd', 'flag-detail', 'experiment-detail'],
};

export function analyze(dir) {
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const assets = join(dir, 'assets');
  const initialNames = new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map((m) => m[1]));
  const chunks = readdirSync(assets)
    .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
    .map((name) => {
      const content = readFileSync(join(assets, name));
      return {
        name,
        raw: content.length,
        gzip: gzipSync(content, { level: 9 }).length,
        initial: initialNames.has(name),
      };
    })
    .sort((a, b) => b.raw - a.raw);
  return { chunks, initialNames };
}

export function check(dir, limits = budgets) {
  const { chunks } = analyze(dir);
  const problems = [];
  const js = chunks.filter((c) => c.name.endsWith('.js'));
  if (js.length < 5) problems.push(`expected route and vendor chunks, found ${js.length} JavaScript files`);
  for (const chunk of chunks) {
    if (chunk.raw > limits.chunkRawBytes)
      problems.push(
        `${chunk.name} is ${(chunk.raw / KB).toFixed(1)} kB, budget ${(limits.chunkRawBytes / KB).toFixed(0)} kB`,
      );
  }
  const initialGzip = js.filter((c) => c.initial).reduce((sum, c) => sum + c.gzip, 0);
  if (initialGzip > limits.initialGzipBytes)
    problems.push(
      `initial JavaScript is ${(initialGzip / KB).toFixed(1)} kB gzip, budget ${(limits.initialGzipBytes / KB).toFixed(0)} kB`,
    );
  for (const prefix of limits.lazyOnly) {
    const matching = js.filter((c) => c.name.startsWith(`${prefix}-`));
    if (matching.length === 0) problems.push(`no ${prefix} chunk was emitted`);
    for (const chunk of matching)
      if (chunk.initial) problems.push(`${chunk.name} is loaded eagerly but must be lazy`);
  }
  return { chunks, initialGzip, problems };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const dir = resolve(process.argv[2] ?? 'dist');
  if (!existsSync(join(dir, 'index.html'))) {
    console.error(`${dir}/index.html not found, run the build first`);
    process.exit(1);
  }
  const { chunks, initialGzip, problems } = check(dir);
  for (const c of chunks)
    console.log(
      `${c.initial ? 'initial' : 'lazy   '}  ${(c.raw / KB).toFixed(1).padStart(7)} kB  ${(c.gzip / KB).toFixed(1).padStart(6)} kB gzip  ${c.name}`,
    );
  console.log(
    `largest chunk ${(chunks[0].raw / KB).toFixed(1)} kB (budget ${budgets.chunkRawBytes / KB} kB), initial JavaScript ${(initialGzip / KB).toFixed(1)} kB gzip (budget ${budgets.initialGzipBytes / KB} kB)`,
  );
  if (problems.length > 0) {
    for (const p of problems) console.error(`size budget exceeded: ${p}`);
    process.exit(1);
  }
  console.log('dashboard bundle within budget');
}
