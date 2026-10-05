import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Bench } from 'tinybench';
import { evaluateFlag } from '../src';
import { context, keysFor, store, targets } from './cases';

const bench = new Bench({ time: 1000, warmupTime: 300 });
let sink = 0;
for (const [name, key] of Object.entries(keysFor)) {
  bench.add(name, () => {
    const result = evaluateFlag(store, key, context);
    if (result.value === true) sink++;
  });
}

await bench.run();

const rows = bench.tasks.map((task) => {
  const result = task.result as unknown as {
    latency: { mean: number; p99?: number };
    throughput: { mean: number };
  };
  const meanUs = result.latency.mean * 1000;
  const p99Us = (result.latency.p99 ?? result.latency.mean) * 1000;
  const target = targets[task.name]!;
  return {
    case: task.name,
    meanUs: Number(meanUs.toFixed(3)),
    p99Us: Number(p99Us.toFixed(3)),
    opsPerSec: Math.round(result.throughput.mean),
    targetUs: target,
    ok: meanUs < target,
  };
});

const environment = {
  cpu: cpus()[0]?.model ?? 'unknown',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  date: new Date().toISOString(),
};

console.log(
  `Environment: ${environment.cpu}, Node ${environment.node}, ${environment.platform}, ${environment.date}`,
);
console.log('| Case | Mean (µs) | p99 (µs) | ops/sec | Target (µs) | OK |');
console.log('|---|---|---|---|---|---|');
for (const row of rows) {
  console.log(
    `| ${row.case} | ${row.meanUs} | ${row.p99Us} | ${row.opsPerSec.toLocaleString('en-US')} | < ${row.targetUs} | ${row.ok ? 'yes' : 'NO'} |`,
  );
}
writeFileSync(
  process.env.BENCH_OUTPUT ?? 'bench-results.json',
  JSON.stringify({ environment, rows }, null, 2),
);
if (sink < 0) console.log(sink);
if (process.env.BENCH_STRICT === '1' && rows.some((row) => !row.ok)) process.exit(1);
