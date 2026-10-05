import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { FlagSummary } from './codegen';

export interface StaleReference {
  key: string;
  status: 'archived' | 'stale' | 'unknown';
  lastEvaluatedAt: string | null;
  locations: Array<{ file: string; line: number }>;
}

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']);
const IGNORED = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next', '.turbo']);

export async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (EXTENSIONS.has(extname(entry.name))) out.push(path);
  }
  return out;
}

export function lastEvaluated(flag: FlagSummary): string | null {
  const dates = Object.values(flag.environments ?? {})
    .map((e) => e.lastEvaluatedAt)
    .filter((d): d is string => !!d)
    .sort();
  return dates.length ? dates[dates.length - 1]! : null;
}

export async function findStale(
  dir: string,
  flags: FlagSummary[],
  options: { days?: number; now?: number; includeUnknown?: boolean } = {},
): Promise<StaleReference[]> {
  const now = options.now ?? Date.now();
  const threshold = now - (options.days ?? 30) * 86400000;
  const byKey = new Map(flags.map((f) => [f.key, f]));
  const pattern = /(['"`])([a-z0-9][a-z0-9-_.]{0,63})\1/g;
  const references = new Map<string, StaleReference>();
  for (const file of await sourceFiles(dir)) {
    if ((await stat(file)).size > 2_000_000) continue;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((text, index) => {
      for (const match of text.matchAll(pattern)) {
        const key = match[2]!;
        const flag = byKey.get(key);
        let status: StaleReference['status'] | null = null;
        if (flag?.archivedAt) status = 'archived';
        else if (flag) {
          const last = lastEvaluated(flag);
          if (!last || new Date(last).getTime() < threshold) status = 'stale';
        } else if (options.includeUnknown && key.includes('-') && /flag|Variation|useFlag/.test(text))
          status = 'unknown';
        if (!status) continue;
        const reference = references.get(key) ?? {
          key,
          status,
          lastEvaluatedAt: flag ? lastEvaluated(flag) : null,
          locations: [],
        };
        reference.locations.push({ file: relative(dir, file), line: index + 1 });
        references.set(key, reference);
      }
    });
  }
  return [...references.values()].sort((a, b) => a.key.localeCompare(b.key));
}
