import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import pg from 'pg';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(
  new Agent({ connections: null, pipelining: 1, keepAliveTimeout: 60000, headersTimeout: 0, bodyTimeout: 0 }),
);

const SUBSCRIBERS = Number(process.env.LOAD_SUBSCRIBERS ?? 1000);
const MAX_CONNECTIONS = Number(process.env.LOAD_MAX_CONNECTIONS ?? 3000);
const RPS_SECONDS = Number(process.env.LOAD_RPS_SECONDS ?? 10);
const RPS_CONCURRENCY = Number(process.env.LOAD_RPS_CONCURRENCY ?? 64);
const PG = process.env.LOAD_PG_URL ?? 'postgres://127.0.0.1:5432';
const id = `${Date.now().toString(36)}${process.pid}`;
const database = `ffp_test_load_${id}`;
const env = {
  ...process.env,
  DATABASE_URL: `${PG}/${database}`,
  REDIS_URL: process.env.LOAD_REDIS_URL ?? 'redis://127.0.0.1:6379/2',
  REDIS_PREFIX: `ffp_load_${id}`,
  API_PORT: '4270',
  RELAY_PORT: '4271',
  WORKER_ENABLED: 'false',
  RELAY_RATE_LIMIT: 'off',
};
const API = 'http://127.0.0.1:4270';
const RELAY = 'http://127.0.0.1:4271';
const children = [];

function run(args) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => undefined);
  child.stdout.on('data', () => undefined);
  children.push(child);
  return child;
}

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(url)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not start`);
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

async function openStream(onEvent) {
  const controller = new AbortController();
  const response = await fetch(`${RELAY}/sdk/v1/stream`, {
    headers: { authorization: 'srv-demo-production' },
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`stream ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (block.startsWith('event: patch')) onEvent(performance.now());
        }
      }
    } catch {
      return;
    }
  })();
  return () => controller.abort();
}

async function main() {
  const admin = new pg.Client({ connectionString: `${PG}/postgres` });
  await admin.connect();
  try {
    const seed = run(['apps/api/dist/seed.js', '--reset', '--no-history']);
    await new Promise((resolve, reject) =>
      seed.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`)))),
    );
    run(['apps/api/dist/main.js']);
    run(['apps/relay/dist/main.js']);
    await waitFor(`${API}/health`);
    await waitFor(`${RELAY}/health`);
    const token = (
      await (
        await fetch(`${API}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'demo@demo.dev', password: 'demo1234' }),
        })
      ).json()
    ).token;
    const baseline = await (await fetch(`${RELAY}/health`)).json();

    console.log(`opening ${SUBSCRIBERS} SSE subscribers`);
    const arrivals = [];
    const closers = [];
    for (let i = 0; i < SUBSCRIBERS; i += 100) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(100, SUBSCRIBERS - i) }, () => openStream((t) => arrivals.push(t))),
      );
      closers.push(...batch);
    }
    await new Promise((r) => setTimeout(r, 1000));
    const withSubscribers = await (await fetch(`${RELAY}/health`)).json();
    const fanout = [];
    for (let round = 0; round < 5; round++) {
      arrivals.length = 0;
      const config = await (
        await fetch(`${API}/projects/web-shop/flags/dark-mode/envs/production`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json();
      const started = performance.now();
      const response = await fetch(`${API}/projects/web-shop/flags/dark-mode/envs/production`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'if-match': `"${config.version}"`,
        },
        body: JSON.stringify([{ kind: round % 2 === 0 ? 'turnOff' : 'turnOn' }]),
      });
      await response.text();
      const committed = performance.now();
      const deadline = Date.now() + 10000;
      while (arrivals.length < SUBSCRIBERS && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 2));
      const latencies = arrivals.map((t) => t - committed);
      fanout.push({
        round,
        delivered: arrivals.length,
        apiMs: committed - started,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: Math.max(...latencies),
      });
      await new Promise((r) => setTimeout(r, 300));
    }

    let extra = 0;
    let connectionError = null;
    while (SUBSCRIBERS + extra < MAX_CONNECTIONS) {
      try {
        const batch = await Promise.all(Array.from({ length: 100 }, () => openStream(() => undefined)));
        closers.push(...batch);
        extra += 100;
      } catch (error) {
        connectionError = String(error);
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
    const atMax = await (await fetch(`${RELAY}/health`)).json();
    for (const close of closers) close();
    await new Promise((r) => setTimeout(r, 1000));

    console.log(`client evaluate for ${RPS_SECONDS}s with concurrency ${RPS_CONCURRENCY}`);
    const evalLatencies = [];
    let errors = 0;
    const stopAt = Date.now() + RPS_SECONDS * 1000;
    let n = 0;
    await Promise.all(
      Array.from({ length: RPS_CONCURRENCY }, async () => {
        while (Date.now() < stopAt) {
          const started = performance.now();
          try {
            const response = await fetch(`${RELAY}/sdk/v1/evaluate`, {
              method: 'POST',
              headers: { authorization: 'cli-demo-production', 'content-type': 'application/json' },
              body: JSON.stringify({
                context: {
                  kind: 'user',
                  key: `load-${n++}`,
                  plan: n % 3 === 0 ? 'pro' : 'free',
                  country: 'DE',
                },
              }),
            });
            await response.arrayBuffer();
            if (!response.ok) errors++;
          } catch {
            errors++;
          }
          evalLatencies.push(performance.now() - started);
        }
      }),
    );
    const results = {
      date: new Date().toISOString(),
      environment: {
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        memoryGb: Math.round(totalmem() / 2 ** 30),
        node: process.version,
        note: 'API, relay, Postgres, Redis and the load generator share one machine',
      },
      sse: {
        subscribers: SUBSCRIBERS,
        maxConnectionsOpened: SUBSCRIBERS + extra,
        connectionError,
        relayRssMbBaseline: Math.round(baseline.rssBytes / 2 ** 20),
        relayRssMbWithSubscribers: Math.round(withSubscribers.rssBytes / 2 ** 20),
        relayRssMbAtMax: Math.round(atMax.rssBytes / 2 ** 20),
        relayReportedConnectionsAtMax: atMax.serverConnections,
      },
      fanout,
      evaluate: {
        seconds: RPS_SECONDS,
        concurrency: RPS_CONCURRENCY,
        requests: evalLatencies.length,
        rps: Math.round(evalLatencies.length / RPS_SECONDS),
        errors,
        p50: percentile(evalLatencies, 50),
        p95: percentile(evalLatencies, 95),
        p99: percentile(evalLatencies, 99),
      },
    };
    mkdirSync('docs/benchmarks', { recursive: true });
    writeFileSync('docs/benchmarks/loadtest-results.json', JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  for (const child of children) child.kill('SIGKILL');
  process.exit(1);
});
