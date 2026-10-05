import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningApi } from '../../src/app';
import { Database } from '../../src/infra/database';
import { ScheduledService } from '../../src/scheduled/scheduled.service';
import { routeDocs, toOpenApiPath } from '../../src/openapi/openapi';
import { listRoutes } from '../../src/openapi/system.controller';
import { WebhookDispatcher } from '../../src/webhooks/dispatcher';
import { ApiClient, startApi, uniqueKey } from './helpers';

let api: RunningApi;
let admin: ApiClient;
let reviewer: ApiClient;
let reader: ApiClient;
let project: string;
let orgId: string;

const rollout = (on: number) => ({
  rollout: {
    weights: [
      { variation: 'on', weight: on },
      { variation: 'off', weight: 100000 - on },
    ],
  },
});

beforeAll(async () => {
  api = await startApi();
  admin = new ApiClient(api.url);
  await admin.signup(`${uniqueKey('admin')}@test.dev`, 'Ada Admin');
  const me = await admin.get('/auth/me');
  orgId = me.body.organizations[0].id;
  project = uniqueKey('proj');
  const created = await admin.post('/projects', { key: project, name: 'Test project' });
  expect(created.status).toBe(201);
  reviewer = new ApiClient(api.url);
  const reviewerEmail = `${uniqueKey('rev')}@test.dev`;
  const invite = await admin.post(`/orgs/${orgId}/members`, {
    email: reviewerEmail,
    role: 'writer',
    name: 'Rex Reviewer',
  });
  expect(invite.status).toBe(201);
  const login = await reviewer.post('/auth/login', {
    email: reviewerEmail,
    password: invite.body.temporaryPassword,
  });
  reviewer.token = login.body.token;
  reader = new ApiClient(api.url);
  const readerEmail = `${uniqueKey('read')}@test.dev`;
  const readerInvite = await admin.post(`/orgs/${orgId}/members`, { email: readerEmail, role: 'reader' });
  reader.token = (
    await reader.post('/auth/login', { email: readerEmail, password: readerInvite.body.temporaryPassword })
  ).body.token;
});

afterAll(async () => {
  await api.close();
});

async function createFlag(key = uniqueKey('flag'), extra: Record<string, unknown> = {}) {
  const result = await admin.post(`/projects/${project}/flags`, { key, name: key, ...extra });
  expect(result.status).toBe(201);
  return key;
}

describe('auth', () => {
  it('rejects bad credentials and anonymous access', async () => {
    const anonymous = new ApiClient(api.url);
    expect((await anonymous.get('/projects')).status).toBe(401);
    expect((await anonymous.post('/auth/login', { email: 'nobody@test.dev', password: 'nope' })).status).toBe(
      401,
    );
    expect((await anonymous.post('/auth/signup', { email: 'bad', password: 'short', name: '' })).status).toBe(
      400,
    );
    const tampered = new ApiClient(api.url);
    tampered.token = `${admin.token!.slice(0, -2)}xx`;
    expect((await tampered.get('/auth/me')).status).toBe(401);
  });

  it('creates projects with default environments', async () => {
    const result = await admin.get(`/projects/${project}`);
    expect(result.body.environments.map((e: { key: string }) => e.key)).toEqual([
      'development',
      'staging',
      'production',
    ]);
  });
});

describe('flags and semantic patch', () => {
  it('applies instructions with If-Match and returns 409 on a stale version', async () => {
    const key = await createFlag();
    const config = await admin.get(`/projects/${project}/flags/${key}/envs/production`);
    expect(config.headers.get('etag')).toBe('"1"');
    const first = await admin.patch(
      `/projects/${project}/flags/${key}/envs/production`,
      {
        instructions: [
          { kind: 'turnOn' },
          {
            kind: 'addRule',
            rule: {
              id: 'de',
              clauses: [{ attribute: 'country', op: 'in', values: ['DE'] }],
              serve: { variation: 'on' },
            },
          },
        ],
        comment: 'launch in DE',
      },
      { 'if-match': '"1"' },
    );
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(2);
    expect(first.body.descriptions).toEqual(['turned flag on', 'added rule: country in [DE] → On']);
    const stale = await admin.patch(
      `/projects/${project}/flags/${key}/envs/production`,
      [{ kind: 'turnOff' }],
      { 'if-match': '"1"' },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.currentVersion).toBe(2);
    const concurrentOther = await reviewer.patch(`/projects/${project}/flags/${key}/envs/production`, [
      { kind: 'updateFallthrough', serve: rollout(50000) },
    ]);
    expect(concurrentOther.status).toBe(200);
    expect(concurrentOther.body.rules).toHaveLength(1);
    expect(concurrentOther.body.version).toBe(3);
  });

  it('rejects invalid instructions with the failing index and validates weights', async () => {
    const key = await createFlag();
    const bad = await admin.patch(`/projects/${project}/flags/${key}/envs/staging`, [
      { kind: 'turnOn' },
      { kind: 'removeRule', ruleId: 'missing' },
    ]);
    expect(bad.status).toBe(422);
    expect(bad.body.index).toBe(1);
    const badWeights = await admin.patch(`/projects/${project}/flags/${key}/envs/staging`, [
      { kind: 'updateFallthrough', serve: { rollout: { weights: [{ variation: 'on', weight: 10 }] } } },
    ]);
    expect(badWeights.status).toBe(400);
    const unchanged = await admin.get(`/projects/${project}/flags/${key}/envs/staging`);
    expect(unchanged.body.version).toBe(1);
    expect(unchanged.body.on).toBe(false);
  });

  it('enforces roles', async () => {
    const key = await createFlag();
    expect((await reader.get(`/projects/${project}/flags/${key}`)).status).toBe(200);
    expect(
      (await reader.patch(`/projects/${project}/flags/${key}/envs/staging`, [{ kind: 'turnOn' }])).status,
    ).toBe(403);
    expect((await reader.post(`/projects/${project}/flags`, { key: 'x-reader', name: 'x' })).status).toBe(
      403,
    );
  });

  it('records every change in the audit log with author, diff and intent', async () => {
    const key = await createFlag();
    await reviewer.patch(`/projects/${project}/flags/${key}/envs/production`, [
      { kind: 'addTargets', variationId: 'on', keys: ['alice'] },
    ]);
    const log = await admin.get(`/projects/${project}/audit-log?resource=${key}&env=production`);
    const entry = log.body.items[0];
    expect(entry.action).toBe('flag.config.updated');
    expect(entry.actor.name).toBe('Rex Reviewer');
    expect(entry.descriptions).toEqual(['targeted user alice → On']);
    expect(entry.before.targets).toEqual([]);
    expect(entry.after.targets).toEqual([{ variation: 'on', contextKind: 'user', keys: ['alice'] }]);
  });

  it('validates prerequisites, lists flags with filters and archives', async () => {
    const parent = await createFlag(uniqueKey('parent'), { tags: ['core'] });
    const child = await createFlag(uniqueKey('child'), {
      prerequisites: [{ flagKey: parent, variationId: 'on' }],
    });
    const cycle = await admin.patch(`/projects/${project}/flags/${parent}`, {
      prerequisites: [{ flagKey: child, variationId: 'on' }],
    });
    expect(cycle.status).toBe(422);
    const list = await admin.get(`/projects/${project}/flags?tag=core`);
    expect(list.body.items.map((f: { key: string }) => f.key)).toEqual([parent]);
    expect(list.body.items[0].environments.production).toMatchObject({ on: false, stale: false });
    expect((await admin.request('DELETE', `/projects/${project}/flags/${child}`)).status).toBe(409);
    expect(
      (await admin.patch(`/projects/${project}/flags/${child}`, { archived: true })).body.archivedAt,
    ).not.toBeNull();
    expect((await admin.request('DELETE', `/projects/${project}/flags/${child}`)).status).toBe(204);
  });

  it('copies configuration between environments with a diff preview and compares environments', async () => {
    const key = await createFlag();
    await admin.patch(`/projects/${project}/flags/${key}/envs/staging`, [
      { kind: 'turnOn' },
      { kind: 'updateFallthrough', serve: rollout(20000) },
    ]);
    const preview = await admin.post(`/projects/${project}/flags/${key}/copy`, {
      source: 'staging',
      target: 'production',
      dryRun: true,
    });
    expect(preview.body.applied).toBe(false);
    expect(preview.body.instructions.map((i: { kind: string }) => i.kind)).toEqual([
      'turnOn',
      'updateFallthrough',
    ]);
    expect(preview.body.diff.length).toBeGreaterThan(0);
    const compareBefore = await admin.get(`/projects/${project}/compare?envs=staging,production`);
    expect(compareBefore.body.flags.find((f: { key: string }) => f.key === key).identical).toBe(false);
    const applied = await admin.post(`/projects/${project}/flags/${key}/copy`, {
      source: 'staging',
      target: 'production',
      dryRun: false,
    });
    expect(applied.body.applied).toBe(true);
    const compare = await admin.get(`/projects/${project}/compare?envs=staging,production`);
    expect(compare.body.flags.find((f: { key: string }) => f.key === key).identical).toBe(true);
  });
});

describe('change requests', () => {
  it('requires approval in protected environments and applies semantically', async () => {
    const key = await createFlag();
    expect(
      (await admin.patch(`/projects/${project}/environments/production`, { requireApproval: true })).body
        .requireApproval,
    ).toBe(true);
    const direct = await admin.patch(`/projects/${project}/flags/${key}/envs/production`, [
      { kind: 'turnOn' },
    ]);
    expect(direct.status).toBe(403);
    expect(direct.body.error).toBe('approval_required');
    const cr = await admin.post(`/projects/${project}/flags/${key}/envs/production/change-requests`, {
      instructions: [{ kind: 'turnOn' }, { kind: 'updateFallthrough', serve: rollout(50000) }],
      comment: 'go 50%',
    });
    expect(cr.status).toBe(201);
    expect(cr.body.status).toBe('pending');
    expect((await admin.post(`/change-requests/${cr.body.id}/apply`)).status).toBe(409);
    expect((await admin.post(`/change-requests/${cr.body.id}/approve`, {})).status).toBe(403);
    expect((await reader.post(`/change-requests/${cr.body.id}/approve`, {})).status).toBe(403);
    const detail = await reviewer.get(`/change-requests/${cr.body.id}`);
    expect(detail.body.preview.diff.length).toBeGreaterThan(0);
    const approved = await reviewer.post(`/change-requests/${cr.body.id}/approve`, { comment: 'lgtm' });
    expect(approved.body.status).toBe('approved');
    expect(approved.body.reviewer.name).toBe('Rex Reviewer');
    const applied = await admin.post(`/change-requests/${cr.body.id}/apply`);
    expect(applied.status).toBe(201);
    expect(applied.body.status).toBe('applied');
    const config = await admin.get(`/projects/${project}/flags/${key}/envs/production`);
    expect(config.body.on).toBe(true);
    expect(config.body.fallthrough).toEqual(rollout(50000));
    const log = await admin.get(`/projects/${project}/audit-log?resource=${key}`);
    expect(log.body.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['change_request.created', 'change_request.approved', 'change_request.applied']),
    );
    await admin.patch(`/projects/${project}/environments/production`, { requireApproval: false });
  });

  it('marks a change request failed when it no longer applies', async () => {
    const key = await createFlag();
    await admin.patch(`/projects/${project}/flags/${key}/envs/staging`, [
      { kind: 'addRule', rule: { id: 'r1', clauses: [], serve: { variation: 'on' } } },
    ]);
    const cr = await admin.post(`/projects/${project}/flags/${key}/envs/staging/change-requests`, {
      instructions: [{ kind: 'removeRule', ruleId: 'r1' }],
    });
    await reviewer.post(`/change-requests/${cr.body.id}/approve`, {});
    await admin.patch(`/projects/${project}/flags/${key}/envs/staging`, [
      { kind: 'removeRule', ruleId: 'r1' },
    ]);
    const applied = await admin.post(`/change-requests/${cr.body.id}/apply`);
    expect(applied.status).toBe(409);
    expect((await admin.get(`/change-requests/${cr.body.id}`)).body.status).toBe('failed');
  });
});

describe('scheduled changes', () => {
  it('executes due changes exactly once with FOR UPDATE SKIP LOCKED', async () => {
    const key = await createFlag();
    const scheduled = await admin.post(`/projects/${project}/flags/${key}/envs/staging/schedule`, {
      instructions: [{ kind: 'turnOn' }, { kind: 'updateFallthrough', serve: rollout(50000) }],
      executeAt: new Date(Date.now() + 300).toISOString(),
      comment: 'friday rollout',
    });
    expect(scheduled.status).toBe(201);
    const later = await admin.post(`/projects/${project}/flags/${key}/envs/staging/schedule`, {
      instructions: [{ kind: 'turnOff' }],
      executeAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const scheduler = api.app.get(ScheduledService);
    expect(await scheduler.runDue()).toBe(0);
    await new Promise((r) => setTimeout(r, 400));
    const results = await Promise.all([scheduler.runDue(), scheduler.runDue(), scheduler.runDue()]);
    expect(results.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
    const config = await admin.get(`/projects/${project}/flags/${key}/envs/staging`);
    expect(config.body.on).toBe(true);
    expect(config.body.version).toBe(2);
    const list = await admin.get(`/projects/${project}/scheduled-changes`);
    const executed = list.body.items.find((s: { id: string }) => s.id === scheduled.body.id);
    expect(executed.status).toBe('executed');
    expect(list.body.items.find((s: { id: string }) => s.id === later.body.id).status).toBe('pending');
    expect((await admin.request('DELETE', `/scheduled-changes/${later.body.id}`)).body.status).toBe(
      'cancelled',
    );
    const log = await admin.get(`/projects/${project}/audit-log?action=scheduled_change.executed`);
    expect(log.body.items.some((e: { resource: string }) => e.resource.includes(key))).toBe(true);
  });

  it('runs the background worker on an interval', async () => {
    const workerApi = await startApi({ workerEnabled: true, workerIntervalMs: 100 });
    try {
      const key = await createFlag();
      await admin.post(`/projects/${project}/flags/${key}/envs/development/schedule`, {
        instructions: [{ kind: 'turnOn' }],
        executeAt: new Date().toISOString(),
      });
      let on = false;
      for (let i = 0; i < 50 && !on; i++) {
        await new Promise((r) => setTimeout(r, 100));
        on = (await admin.get(`/projects/${project}/flags/${key}/envs/development`)).body.on;
      }
      expect(on).toBe(true);
    } finally {
      await workerApi.close();
    }
  });
});

describe('segments', () => {
  it('supports CRUD with versioning and blocks deleting used segments', async () => {
    const base = `/projects/${project}/envs/production/segments`;
    const created = await admin.post(base, {
      key: 'beta',
      name: 'Beta',
      included: ['u1'],
      rules: [{ clauses: [{ attribute: 'email', op: 'ends_with', values: ['@corp.io'] }] }],
    });
    expect(created.status).toBe(201);
    const stale = await admin.patch(`${base}/beta`, { included: ['u1', 'u2'] }, { 'if-match': '"7"' });
    expect(stale.status).toBe(409);
    const updated = await admin.patch(`${base}/beta`, { included: ['u1', 'u2'] }, { 'if-match': '"1"' });
    expect(updated.body.version).toBe(2);
    const key = await createFlag();
    await admin.patch(`/projects/${project}/flags/${key}/envs/production`, [
      {
        kind: 'addRule',
        rule: {
          clauses: [{ attribute: 'segment', op: 'segment_match', values: ['beta'] }],
          serve: { variation: 'on' },
        },
      },
    ]);
    expect((await admin.get(base)).body.items[0].usedBy).toEqual([key]);
    expect((await admin.request('DELETE', `${base}/beta`)).status).toBe(409);
    const ruleset = await admin.get(`/projects/${project}/envs/production/ruleset`);
    expect(ruleset.body.segments.beta.included).toEqual(['u1', 'u2']);
  });
});

describe('sdk keys', () => {
  it('creates, rotates with a grace period and revokes', async () => {
    const base = `/projects/${project}/envs/production/sdk-keys`;
    const created = await admin.post(base, { kind: 'server' });
    expect(created.body.key).toMatch(/^srv-/);
    const rotated = await admin.post(`${base}/${created.body.id}/rotate`, { gracePeriodMinutes: 60 });
    expect(rotated.body.current.key).toMatch(/^srv-/);
    expect(rotated.body.previous.active).toBe(true);
    expect(new Date(rotated.body.previous.expiresAt).getTime()).toBeGreaterThan(Date.now() + 59 * 60000);
    const list = await admin.get(base);
    expect(list.body.items.every((k: Record<string, unknown>) => !('key' in k))).toBe(true);
    expect((await admin.request('DELETE', `${base}/${created.body.id}`)).status).toBe(204);
    expect((await reviewer.post(base, { kind: 'client' })).status).toBe(403);
  });
});

describe('experiments', () => {
  it('computes z-test, Welch t-test, lift, CI and SRM from partitioned events', async () => {
    const key = await createFlag(uniqueKey('exp-flag'), {
      kind: 'string',
      variations: [
        { id: 'A', value: 'control' },
        { id: 'B', value: 'treatment' },
      ],
    });
    await admin.patch(`/projects/${project}/flags/${key}/envs/production`, [
      { kind: 'turnOn' },
      {
        kind: 'updateFallthrough',
        serve: {
          rollout: {
            weights: [
              { variation: 'A', weight: 50000 },
              { variation: 'B', weight: 50000 },
            ],
          },
        },
      },
    ]);
    const conversion = uniqueKey('purchase');
    await admin.post(`/projects/${project}/metrics`, {
      key: conversion,
      name: 'Purchase',
      eventKey: 'purchase',
      kind: 'conversion',
    });
    const revenue = uniqueKey('revenue');
    await admin.post(`/projects/${project}/metrics`, {
      key: revenue,
      name: 'Revenue',
      eventKey: 'purchase',
      kind: 'numeric',
      unit: 'USD',
    });
    const exp = await admin.post(`/projects/${project}/experiments`, {
      key: uniqueKey('exp'),
      name: 'Exp',
      envKey: 'production',
      flagKey: key,
      metricKeys: [conversion, revenue],
      controlVariationId: 'A',
    });
    expect(exp.status).toBe(201);
    const started = await admin.post(`/experiments/${exp.body.id}/start`);
    expect(started.body.status).toBe('running');
    const ruleset = await admin.get(`/projects/${project}/envs/production/ruleset`);
    expect(ruleset.body.flags[key].config.experiment.id).toBe(exp.body.id);
    const db = api.app.get(Database);
    const env = await db.one<{ id: string }>(
      "SELECT e.id FROM environments e JOIN projects p ON p.id = e.project_id WHERE p.key = $1 AND e.key = 'production'",
      [project],
    );
    await db.query(
      `INSERT INTO events (env_id, kind, flag_key, variation_id, context_key, in_experiment, ts)
       SELECT $1, 'exposure', $2, CASE WHEN i % 2 = 0 THEN 'A' ELSE 'B' END, 'user-' || i, true, now() FROM generate_series(1, 4000) i`,
      [env.id, key],
    );
    await db.query(
      `INSERT INTO events (env_id, kind, event_key, context_key, value, ts)
       SELECT $1, 'custom', 'purchase', 'user-' || i, 20 + (i % 7), now() + interval '1 second' FROM generate_series(1, 4000) i
       WHERE (i % 2 = 0 AND i % 10 < 4) OR (i % 2 = 1 AND i % 10 < 6)`,
      [env.id],
    );
    const results = await admin.get(`/experiments/${exp.body.id}/results`);
    expect(results.body.exposures).toEqual({ A: 2000, B: 2000 });
    expect(results.body.srm.mismatch).toBe(false);
    const conv = results.body.metrics.find((m: { metricKey: string }) => m.metricKey === conversion);
    const control = conv.variations.find((v: { variationId: string }) => v.variationId === 'A');
    const treatment = conv.variations.find((v: { variationId: string }) => v.variationId === 'B');
    expect(control.rate).toBeCloseTo(0.4, 5);
    expect(treatment.rate).toBeCloseTo(0.6, 5);
    expect(treatment.relativeLift).toBeCloseTo(0.5, 5);
    expect(treatment.significant).toBe(true);
    expect(treatment.ciLow).toBeGreaterThan(0);
    expect(treatment.test).toBe('two-proportion-z');
    const rev = results.body.metrics.find((m: { metricKey: string }) => m.metricKey === revenue);
    expect(rev.variations.find((v: { variationId: string }) => v.variationId === 'B').test).toBe('welch-t');
    await db.query(
      `INSERT INTO events (env_id, kind, flag_key, variation_id, context_key, in_experiment, ts)
       SELECT $1, 'exposure', $2, 'B', 'extra-' || i, true, now() FROM generate_series(1, 600) i`,
      [env.id, key],
    );
    const broken = await admin.get(`/experiments/${exp.body.id}/results`);
    expect(broken.body.srm.mismatch).toBe(true);
    expect(broken.body.warnings.join(' ')).toMatch(/Sample ratio mismatch/);
    const stopped = await admin.post(`/experiments/${exp.body.id}/stop`);
    expect(stopped.body.status).toBe('stopped');
    const sample = await admin.get('/experiments/sample-size?baselineRate=0.1&minimumDetectableEffect=0.2');
    expect(sample.body.perVariation).toBeGreaterThan(3800);
    const partitions = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'events'",
    );
    expect(partitions[0]!.n).toBeGreaterThan(30);
  });
});

describe('webhooks and realtime', () => {
  it('delivers Slack-compatible signed payloads on flag changes', async () => {
    const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    try {
      const hook = await admin.post('/webhooks', {
        url,
        secret: 'super-secret',
        events: ['flag.config.updated'],
        projectKey: project,
      });
      expect(hook.status).toBe(201);
      const key = await createFlag();
      await admin.patch(`/projects/${project}/flags/${key}/envs/production`, [{ kind: 'turnOn' }]);
      await api.app.get(WebhookDispatcher).idle();
      const delivery = received.find((r) => r.body.includes(key))!;
      expect(delivery).toBeDefined();
      const payload = JSON.parse(delivery.body);
      expect(payload.text).toContain('turned flag on');
      expect(payload.blocks[0].type).toBe('section');
      expect(delivery.headers['x-ffp-signature']).toBe(
        `sha256=${createHmac('sha256', 'super-secret').update(delivery.body).digest('hex')}`,
      );
      const deliveries = await admin.get(`/webhooks/${hook.body.id}/deliveries`);
      expect(deliveries.body.items[0].ok).toBe(true);
      await admin.request('DELETE', `/webhooks/${hook.body.id}`);
    } finally {
      server.close();
    }
  });

  it('streams changes with the actor name to dashboard clients', async () => {
    const key = await createFlag();
    const controller = new AbortController();
    const response = await fetch(`${api.url}/projects/${project}/stream?access_token=${admin.token}`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    await reviewer.patch(`/projects/${project}/flags/${key}/envs/staging`, [{ kind: 'turnOn' }]);
    const deadline = Date.now() + 3000;
    while (!text.includes('Rex Reviewer') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    const line = text
      .split('\n')
      .find((l) => l.startsWith('data:') && l.includes(key) && l.includes('Rex Reviewer'))!;
    const event = JSON.parse(line.slice(5));
    expect(event.actor.name).toBe('Rex Reviewer');
    expect(event.flagKey).toBe(key);
  });
});

describe('openapi', () => {
  it('documents every registered route', async () => {
    const routes = listRoutes(api.app.getHttpAdapter().getInstance());
    expect(routes.length).toBeGreaterThan(60);
    const missing = routes
      .filter((r) => !routeDocs[`${r.method} ${toOpenApiPath(r.path)}`])
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    const doc = await admin.get('/openapi.json');
    expect(doc.body.paths['/projects/{p}/flags/{key}/envs/{env}'].patch.responses['409']).toBeDefined();
  });
});
