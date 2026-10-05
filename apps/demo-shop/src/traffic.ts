import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { init } from '@ashamrai/flags-node';

export interface TrafficOptions {
  relayUrl: string;
  serverKey: string;
  users: number;
  baselineRate: number;
  lift: number;
  treatment: string;
  flagKey: string;
  seed: number;
  prefix: string;
}

export interface TrafficSummary {
  users: number;
  byVariation: Record<string, { users: number; purchases: number; revenue: number }>;
  durationMs: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function runTraffic(
  options: TrafficOptions,
  log: (line: string) => void = console.log,
): Promise<TrafficSummary> {
  const started = Date.now();
  const random = mulberry32(options.seed);
  const client = init({
    sdkKey: options.serverKey,
    baseUrl: options.relayUrl,
    stream: false,
    events: { capacity: 500000, flushIntervalMs: 60000, exposureDedupCapacity: options.users + 10 },
    diagnostics: { enabled: false },
  });
  const status = await client.waitForInitialization({ timeoutMs: 10000 });
  if (!status.initialized) throw new Error(`flags SDK did not initialize: ${status.error ?? 'timeout'}`);
  const byVariation: TrafficSummary['byVariation'] = {};
  for (let i = 0; i < options.users; i++) {
    const context = {
      kind: 'user',
      key: `${options.prefix}-${i}`,
      plan: random() < 0.2 ? 'pro' : 'free',
      country: 'DE',
    };
    const detail = client.stringVariationDetail(options.flagKey, context, 'Welcome');
    const variation = detail.variationId ?? 'default';
    const stats = (byVariation[variation] ??= { users: 0, purchases: 0, revenue: 0 });
    stats.users++;
    const rate = options.baselineRate * (variation === options.treatment ? 1 + options.lift : 1);
    if (random() < rate) {
      const value = Math.round((20 + random() * 100) * 100) / 100;
      client.track('purchase', context, { value });
      stats.purchases++;
      stats.revenue += value;
    }
    if (random() < 0.4) client.track('add-to-cart', context);
    if ((i + 1) % 2000 === 0) {
      await client.flush();
      log(`  ${i + 1}/${options.users} visitors sent`);
    }
  }
  await client.flush();
  await client.close();
  return { users: options.users, byVariation, durationMs: Date.now() - started };
}

async function main() {
  const { values } = parseArgs({
    options: {
      relay: { type: 'string', default: process.env.RELAY_URL ?? 'http://127.0.0.1:4210' },
      key: { type: 'string', default: process.env.FLAGS_SERVER_KEY ?? 'srv-demo-production' },
      users: { type: 'string', default: '27000' },
      baseline: { type: 'string', default: '0.3' },
      lift: { type: 'string', default: '0.08' },
      treatment: { type: 'string', default: 'B' },
      flag: { type: 'string', default: 'banner-text' },
      seed: { type: 'string', default: '42' },
      prefix: { type: 'string', default: 'shopper' },
    },
  });
  const summary = await runTraffic({
    relayUrl: values.relay!,
    serverKey: values.key!,
    users: Number(values.users),
    baselineRate: Number(values.baseline),
    lift: Number(values.lift),
    treatment: values.treatment!,
    flagKey: values.flag!,
    seed: Number(values.seed),
    prefix: values.prefix!,
  });
  console.log(`traffic done in ${summary.durationMs} ms`);
  for (const [variation, stats] of Object.entries(summary.byVariation).sort()) {
    console.log(
      `  ${variation}: ${stats.users} visitors, ${stats.purchases} purchases (${((stats.purchases / stats.users) * 100).toFixed(2)}%), revenue $${stats.revenue.toFixed(2)}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
