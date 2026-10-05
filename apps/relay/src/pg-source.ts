import { createHash } from 'node:crypto';
import pg from 'pg';
import type { EventBatch } from '@ashamrai/flags-contracts';
import type { FlagWithConfig, Ruleset, Segment } from '@ashamrai/flags-evaluator';
import type { IngestResult, KeyInfo, RelaySource, RulesetSnapshot } from './source';

pg.types.setTypeParser(20, (value) => Number(value));

interface CachedKey {
  info: KeyInfo | null;
  expiresAt: number | null;
  cachedAt: number;
}

export class PostgresSource implements RelaySource {
  private readonly pool: pg.Pool;
  private readonly keyCache = new Map<string, CachedKey>();

  constructor(
    databaseUrl: string,
    private readonly keyCacheTtlMs: number,
  ) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    this.pool.on('error', () => undefined);
  }

  async resolveKey(key: string): Promise<KeyInfo | null> {
    const hash = createHash('sha256').update(key).digest('hex');
    const now = Date.now();
    const cached = this.keyCache.get(hash);
    if (cached && now - cached.cachedAt < this.keyCacheTtlMs) {
      if (cached.expiresAt !== null && cached.expiresAt <= now) return null;
      return cached.info;
    }
    const result = await this.pool.query<{
      env_id: string;
      kind: 'server' | 'client';
      expires_at: Date | null;
    }>('SELECT env_id, kind, expires_at FROM sdk_keys WHERE key_hash = $1', [hash]);
    const row = result.rows[0];
    const entry: CachedKey = {
      info: row ? { envId: row.env_id, kind: row.kind } : null,
      expiresAt: row?.expires_at ? new Date(row.expires_at).getTime() : null,
      cachedAt: now,
    };
    if (this.keyCache.size > 10000) this.keyCache.clear();
    this.keyCache.set(hash, entry);
    if (entry.expiresAt !== null && entry.expiresAt <= now) return null;
    return entry.info;
  }

  invalidateKeys(): void {
    this.keyCache.clear();
  }

  async loadRuleset(envId: string): Promise<RulesetSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const env = await client.query<{ id: string; key: string; version: number; project_id: string }>(
        'SELECT id, key, version, project_id FROM environments WHERE id = $1',
        [envId],
      );
      const envRow = env.rows[0];
      if (!envRow) {
        await client.query('COMMIT');
        return null;
      }
      const flags = await client.query<Record<string, unknown>>(
        `SELECT f.key, f.name, f.kind, f.variations, f.salt, f.prerequisites, f.client_side_available, f.tags, f.temporary,
           fc."on", fc.off_variation, fc.targets, fc.rules, fc.fallthrough, fc.version, fc.updated_at,
           x.id AS exp_id, x.key AS exp_key
         FROM flags f
         JOIN flag_configs fc ON fc.flag_id = f.id AND fc.env_id = $1
         LEFT JOIN experiments x ON x.flag_id = f.id AND x.env_id = $1 AND x.status = 'running'
         WHERE f.project_id = $2 AND f.archived_at IS NULL`,
        [envId, envRow.project_id],
      );
      const segments = await client.query<Record<string, unknown>>(
        'SELECT key, name, context_kind, included, excluded, rules, version FROM segments WHERE env_id = $1',
        [envId],
      );
      await client.query('COMMIT');
      const ruleset: Ruleset = { env: envRow.key, version: envRow.version, flags: {}, segments: {} };
      for (const row of flags.rows) {
        const flag: FlagWithConfig = {
          key: String(row.key),
          name: String(row.name),
          kind: row.kind as FlagWithConfig['kind'],
          variations: row.variations as FlagWithConfig['variations'],
          salt: String(row.salt),
          prerequisites: (row.prerequisites as FlagWithConfig['prerequisites']) ?? [],
          clientSideAvailable: Boolean(row.client_side_available),
          config: {
            on: Boolean(row.on),
            offVariation: (row.off_variation as string | null) ?? null,
            targets: row.targets as FlagWithConfig['config']['targets'],
            rules: row.rules as FlagWithConfig['config']['rules'],
            fallthrough: row.fallthrough as FlagWithConfig['config']['fallthrough'],
            version: Number(row.version),
            updatedAt: new Date(row.updated_at as Date).toISOString(),
            experiment: row.exp_id ? { id: String(row.exp_id), key: String(row.exp_key) } : null,
          },
        };
        ruleset.flags[flag.key] = flag;
      }
      for (const row of segments.rows) {
        const segment: Segment = {
          key: String(row.key),
          name: String(row.name),
          contextKind: String(row.context_kind),
          included: row.included as string[],
          excluded: row.excluded as string[],
          rules: row.rules as Segment['rules'],
          version: Number(row.version),
        };
        ruleset.segments[segment.key] = segment;
      }
      return { envId, envKey: envRow.key, version: envRow.version, ruleset };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async currentVersions(envIds: string[]): Promise<Map<string, number>> {
    if (envIds.length === 0) return new Map();
    const result = await this.pool.query<{ id: string; version: number }>(
      'SELECT id, version FROM environments WHERE id = ANY($1::uuid[])',
      [envIds],
    );
    return new Map(result.rows.map((r) => [r.id, r.version]));
  }

  async ingest(envId: string, batch: EventBatch): Promise<IngestResult> {
    const result: IngestResult = { exposures: 0, custom: 0, summaries: 0, diagnostics: 0 };
    const kinds: string[] = [];
    const flagKeys: Array<string | null> = [];
    const variations: Array<string | null> = [];
    const contexts: string[] = [];
    const eventKeys: Array<string | null> = [];
    const values: Array<number | null> = [];
    const experiments: boolean[] = [];
    const timestamps: Date[] = [];
    const lastSeen = new Map<string, number>();
    const counters = new Map<string, { flagKey: string; variationId: string; hour: Date; count: number }>();
    const attributes = new Set<string>();
    const diagnostics: Array<{ name: string; version: string; id: string; payload: string }> = [];
    for (const event of batch.events) {
      if (event.kind === 'exposure') {
        result.exposures++;
        kinds.push('exposure');
        flagKeys.push(event.flagKey);
        variations.push(event.variationId);
        contexts.push(event.contextKey);
        eventKeys.push(null);
        values.push(null);
        experiments.push(event.inExperiment === true);
        timestamps.push(new Date(event.ts));
        lastSeen.set(event.flagKey, Math.max(lastSeen.get(event.flagKey) ?? 0, event.ts));
        for (const attribute of event.attributes ?? []) attributes.add(attribute);
      } else if (event.kind === 'custom') {
        result.custom++;
        kinds.push('custom');
        flagKeys.push(null);
        variations.push(null);
        contexts.push(event.contextKey);
        eventKeys.push(event.key);
        values.push(event.value ?? null);
        experiments.push(false);
        timestamps.push(new Date(event.ts));
      } else if (event.kind === 'summary') {
        result.summaries++;
        const hour = new Date(Math.floor(event.endTs / 3600000) * 3600000);
        for (const counter of event.counters) {
          const id = `${counter.flagKey}\u0000${counter.variationId ?? ''}\u0000${hour.getTime()}`;
          const existing = counters.get(id);
          if (existing) existing.count += counter.count;
          else
            counters.set(id, {
              flagKey: counter.flagKey,
              variationId: counter.variationId ?? '',
              hour,
              count: counter.count,
            });
          lastSeen.set(counter.flagKey, Math.max(lastSeen.get(counter.flagKey) ?? 0, event.endTs));
        }
      } else if (event.kind === 'diagnostic') {
        result.diagnostics++;
        diagnostics.push({
          name: event.sdk.name,
          version: event.sdk.version,
          id: event.id,
          payload: JSON.stringify(event),
        });
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (kinds.length > 0) {
        await client.query(
          `INSERT INTO events (env_id, kind, flag_key, variation_id, context_key, event_key, value, in_experiment, ts)
           SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::float8[], $8::bool[], $9::timestamptz[])`,
          [envId, kinds, flagKeys, variations, contexts, eventKeys, values, experiments, timestamps],
        );
      }
      if (counters.size > 0) {
        const list = [...counters.values()];
        await client.query(
          `INSERT INTO flag_eval_counts (env_id, flag_key, variation_id, hour, count)
           SELECT $1, * FROM unnest($2::text[], $3::text[], $4::timestamptz[], $5::bigint[])
           ON CONFLICT (env_id, flag_key, hour, variation_id) DO UPDATE SET count = flag_eval_counts.count + EXCLUDED.count`,
          [
            envId,
            list.map((c) => c.flagKey),
            list.map((c) => c.variationId),
            list.map((c) => c.hour),
            list.map((c) => c.count),
          ],
        );
      }
      if (lastSeen.size > 0) {
        const keys = [...lastSeen.keys()];
        await client.query(
          `INSERT INTO flag_last_seen (env_id, flag_key, last_evaluated_at)
           SELECT $1, * FROM unnest($2::text[], $3::timestamptz[])
           ON CONFLICT (env_id, flag_key) DO UPDATE SET last_evaluated_at = greatest(flag_last_seen.last_evaluated_at, EXCLUDED.last_evaluated_at)`,
          [envId, keys, keys.map((k) => new Date(lastSeen.get(k)!))],
        );
      }
      for (const d of diagnostics) {
        await client.query(
          'INSERT INTO sdk_diagnostics (env_id, sdk_name, sdk_version, instance_id, payload) VALUES ($1, $2, $3, $4, $5)',
          [envId, d.name, d.version, d.id, d.payload],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (attributes.size > 0) {
      await this.recordAttributes(
        envId,
        [...attributes].map((a) => {
          const index = a.indexOf(':');
          return index > 0
            ? { kind: a.slice(0, index), name: a.slice(index + 1) }
            : { kind: 'user', name: a };
        }),
      );
    }
    return result;
  }

  async recordAttributes(envId: string, attributes: Array<{ kind: string; name: string }>): Promise<void> {
    if (attributes.length === 0) return;
    const unique = new Map(attributes.map((a) => [`${a.kind}\u0000${a.name}`, a]));
    const list = [...unique.values()].slice(0, 200);
    await this.pool.query(
      `INSERT INTO context_attributes (env_id, kind, name, last_seen_at)
       SELECT $1, k, n, now() FROM unnest($2::text[], $3::text[]) AS t(k, n)
       ON CONFLICT (env_id, kind, name) DO UPDATE SET last_seen_at = now()`,
      [envId, list.map((a) => a.kind.slice(0, 64)), list.map((a) => a.name.slice(0, 256))],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
