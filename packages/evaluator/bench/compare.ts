import { readFileSync } from 'node:fs';

interface Row {
  case: string;
  meanUs: number;
}

const [basePath, headPath] = process.argv.slice(2);
if (!basePath || !headPath) {
  console.error('usage: compare <base.json> <head.json>');
  process.exit(2);
}
const base = JSON.parse(readFileSync(basePath, 'utf8')) as { rows: Row[] };
const head = JSON.parse(readFileSync(headPath, 'utf8')) as { rows: Row[] };
const threshold = Number(process.env.BENCH_REGRESSION_THRESHOLD ?? '0.25');
const lines = ['| Case | main (µs) | PR (µs) | Change |', '|---|---|---|---|'];
let regressed = false;
for (const row of head.rows) {
  const before = base.rows.find((r) => r.case === row.case);
  if (!before) continue;
  const change = (row.meanUs - before.meanUs) / before.meanUs;
  if (change > threshold) regressed = true;
  lines.push(
    `| ${row.case} | ${before.meanUs} | ${row.meanUs} | ${(change * 100).toFixed(1)}%${change > threshold ? ' REGRESSION' : ''} |`,
  );
}
console.log(lines.join('\n'));
console.log(
  regressed ? `\nRegression above ${threshold * 100}% detected.` : '\nNo regression above threshold.',
);
