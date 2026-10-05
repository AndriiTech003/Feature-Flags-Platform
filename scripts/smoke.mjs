const API = process.env.API_URL;
const RELAY = process.env.RELAY_URL;
const SHOP = process.env.SHOP_URL;
const DASHBOARD = process.env.DASHBOARD_URL;
const SERVER_KEY = 'srv-demo-production';
const CLIENT_KEY = 'cli-demo-production';
let passed = 0;

function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
  passed++;
  console.log(`  ok  ${message}`);
}

async function call(token, method, path, body, headers = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}

async function login(email) {
  const result = await call(null, 'POST', '/auth/login', { email, password: 'demo1234' });
  check(result.status === 200, `login ${email}`);
  return result.body.token;
}

async function openStream(url, headers) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { text: '', status: response.status };
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        state.text += decoder.decode(value, { stream: true });
      }
    } catch {
      return;
    }
  })();
  return { state, close: () => controller.abort() };
}

async function until(fn, timeoutMs, step = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

console.log('smoke: management API');
const admin = await login('demo@demo.dev');
const reviewer = await login('reviewer@demo.dev');
const projects = await call(admin, 'GET', '/projects');
check(
  projects.body.items[0].key === 'web-shop' && projects.body.items[0].environments.length === 3,
  'seeded project web-shop with 3 environments',
);
const openapi = await call(null, 'GET', '/openapi.json');
check(
  Object.keys(openapi.body.paths).length > 40,
  `OpenAPI document lists ${Object.keys(openapi.body.paths).length} paths`,
);
const created = await call(admin, 'POST', '/projects/web-shop/flags', {
  key: 'smoke-flag',
  name: 'Smoke flag',
  clientSideAvailable: true,
});
check(created.status === 201, 'create flag smoke-flag');

console.log('smoke: relay ruleset, SSE and client evaluation');
let ruleset = null;
const propagated = await until(
  async () => {
    ruleset = await fetch(`${RELAY}/sdk/v1/ruleset`, { headers: { authorization: SERVER_KEY } });
    return (await ruleset.json()).flags['smoke-flag'] !== undefined;
  },
  2000,
  5,
);
const etag = ruleset.headers.get('etag');
check(propagated, 'relay ruleset contains the new flag once the outbox has published the change');
check(
  (await fetch(`${RELAY}/sdk/v1/ruleset`, { headers: { authorization: SERVER_KEY, 'if-none-match': etag } }))
    .status === 304,
  'ruleset answers 304 for a matching ETag',
);
const stream = await openStream(`${RELAY}/sdk/v1/stream`, { authorization: SERVER_KEY });
check(await until(() => stream.state.text.includes('event: put'), 3000), 'SSE stream sends put on connect');
const afterPut = stream.state.text.length;
const patched = await call(
  admin,
  'PATCH',
  '/projects/web-shop/flags/smoke-flag/envs/production',
  [
    { kind: 'turnOn' },
    {
      kind: 'updateFallthrough',
      serve: {
        rollout: {
          weights: [
            { variation: 'on', weight: 50000 },
            { variation: 'off', weight: 50000 },
          ],
        },
      },
    },
  ],
  { 'if-match': '"1"' },
);
check(
  patched.status === 200 && patched.body.version === 2,
  'semantic patch with If-Match applied (version 2)',
);
const committedAt = Date.now();
const delivered = await until(
  () => {
    const tail = stream.state.text.slice(afterPut);
    return tail.includes('event: patch') && tail.includes('"key":"smoke-flag"');
  },
  1000,
  1,
);
check(delivered, `SSE patch delivered ${Date.now() - committedAt} ms after the API response (< 1000)`);
stream.close();
const stale = await call(
  admin,
  'PATCH',
  '/projects/web-shop/flags/smoke-flag/envs/production',
  [{ kind: 'turnOff' }],
  { 'if-match': '"1"' },
);
check(stale.status === 409, 'stale If-Match is rejected with 409');
const evaluated = await fetch(`${RELAY}/sdk/v1/evaluate`, {
  method: 'POST',
  headers: { authorization: CLIENT_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ context: { kind: 'user', key: 'smoke-user', plan: 'pro' }, withReasons: true }),
});
const evaluatedText = await evaluated.text();
const evaluatedBody = JSON.parse(evaluatedText);
check(
  evaluatedBody.flags['new-checkout'].reason.kind === 'RULE_MATCH',
  'client evaluate returns RULE_MATCH for a pro user',
);
check(
  !evaluatedText.includes('"rules"') && !evaluatedText.includes('"salt"'),
  'client evaluate never exposes rules',
);

console.log('smoke: demo-shop and dashboard');
const shopHtml = await (await fetch(`${SHOP}/?user=smoke-user&plan=pro`)).text();
check(
  shopHtml.includes('data-testid="debug-panel"') && shopHtml.includes('One-page checkout'),
  'demo-shop renders the debug panel and the new checkout for pro users',
);
const dashboardHtml = await (await fetch(`${DASHBOARD}/`)).text();
check(dashboardHtml.includes('<div id="root">'), 'dashboard preview build is served');
check(
  /vendor-react-[\w-]+\.js/.test(dashboardHtml) && !dashboardHtml.includes('vendor-charts'),
  'dashboard is code-split: vendor chunks preloaded, charts loaded lazily',
);
let health = null;
const drained = await until(
  async () => {
    health = await (await fetch(`${API}/health`)).json();
    return health.outbox.listening === true && health.outbox.pending === 0 && health.outbox.published > 0;
  },
  5000,
  100,
);
check(drained, `outbox publisher is listening and drained (${health.outbox.published} published, 0 pending)`);

console.log('smoke: change request and scheduled change');
await call(admin, 'PATCH', '/projects/web-shop/environments/staging', { requireApproval: true });
const blocked = await call(admin, 'PATCH', '/projects/web-shop/flags/smoke-flag/envs/staging', [
  { kind: 'turnOn' },
]);
check(
  blocked.status === 403 && blocked.body.error === 'approval_required',
  'direct change to a protected environment is blocked',
);
const cr = await call(admin, 'POST', '/projects/web-shop/flags/smoke-flag/envs/staging/change-requests', {
  instructions: [{ kind: 'turnOn' }],
  comment: 'smoke',
});
check(
  (await call(admin, 'POST', `/change-requests/${cr.body.id}/approve`, {})).status === 403,
  'author cannot approve their own change request',
);
check(
  (await call(reviewer, 'POST', `/change-requests/${cr.body.id}/approve`, {})).body.status === 'approved',
  'reviewer approves',
);
check(
  (await call(reviewer, 'POST', `/change-requests/${cr.body.id}/apply`)).body.status === 'applied',
  'approved change request is applied',
);
check(
  (await call(admin, 'GET', '/projects/web-shop/flags/smoke-flag/envs/staging')).body.on === true,
  'staging config reflects the applied change',
);
await call(admin, 'PATCH', '/projects/web-shop/environments/staging', { requireApproval: false });
const scheduled = await call(admin, 'POST', '/projects/web-shop/flags/smoke-flag/envs/development/schedule', {
  instructions: [{ kind: 'turnOn' }],
  executeAt: new Date(Date.now() + 1000).toISOString(),
});
check(scheduled.status === 201, 'scheduled change created');
check(
  await until(
    async () =>
      (await call(admin, 'GET', '/projects/web-shop/flags/smoke-flag/envs/development')).body.on === true,
    8000,
    250,
  ),
  'worker executed the scheduled change',
);

console.log('smoke: experiment with generated traffic (+8% on variant B)');
const { runTraffic } = await import('../apps/demo-shop/dist/traffic.js');
const summary = await runTraffic(
  {
    relayUrl: RELAY,
    serverKey: SERVER_KEY,
    users: Number(process.env.SMOKE_USERS ?? 27000),
    baselineRate: 0.3,
    lift: 0.08,
    treatment: 'B',
    flagKey: 'banner-text',
    seed: 42,
    prefix: 'smoke',
  },
  () => undefined,
);
check(summary.users > 0, `traffic generator sent ${summary.users} visitors in ${summary.durationMs} ms`);
const experiments = await call(admin, 'GET', '/projects/web-shop/experiments');
const experiment = experiments.body.items.find((x) => x.key === 'banner-copy');
const results = (await call(admin, 'GET', `/experiments/${experiment.id}/results`)).body;
const purchase = results.metrics.find((m) => m.metricKey === 'purchase');
const b = purchase.variations.find((v) => v.variationId === 'B');
const c = purchase.variations.find((v) => v.variationId === 'C');
console.log(
  `  results: units=${results.totalUnits} A/B/C=${JSON.stringify(results.exposures)} SRM p=${results.srm.pValue.toFixed(3)} B lift=${(b.relativeLift * 100).toFixed(2)}% p=${b.pValue.toFixed(5)} C lift=${(c.relativeLift * 100).toFixed(2)}% p=${c.pValue.toFixed(3)}`,
);
check(results.totalUnits === summary.users, 'every visitor counted once as an experiment unit');
check(results.srm.mismatch === false, 'no sample ratio mismatch');
check(b.significant === true && b.relativeLift > 0, 'experiment detects the positive effect of variant B');
console.log(
  `  info  variant C (no built-in effect): ${c.significant ? 'significant by chance, see the multiple comparison warning' : 'not significant'}`,
);

console.log('smoke: insights, audit, metrics');
const insights = await call(admin, 'GET', '/projects/web-shop/flags/banner-text/insights?env=production');
check(
  insights.body.last24h.reduce((s, x) => s + x.count, 0) >= summary.users,
  'insights count the evaluations reported by the SDK',
);
const audit = await call(admin, 'GET', '/projects/web-shop/audit-log?resource=smoke-flag');
check(audit.body.items.length >= 4, `audit log has ${audit.body.items.length} entries for smoke-flag`);
const metrics = await (await fetch(`${RELAY}/metrics`)).text();
check(
  metrics.includes('relay_sse_connections') && metrics.includes('relay_events_ingested_total'),
  'relay exposes Prometheus metrics',
);
console.log('smoke: relay rate limiting');
let throttled = null;
for (let i = 0; i < 40 && !throttled; i++) {
  const response = await fetch(`${RELAY}/sdk/v1/ruleset`, { headers: { authorization: `guess-${i}` } });
  if (response.status === 429) throttled = response;
}
check(
  throttled !== null && Number(throttled.headers.get('retry-after')) >= 1,
  'relay answers 429 with Retry-After after repeated invalid SDK keys',
);
console.log(`smoke: ${passed} checks passed`);
