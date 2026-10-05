import { hashPassword, sha256 } from './common/crypto';
import type { Db, Sql } from './db/db';

export interface SeedOptions {
  reset?: boolean;
  history?: boolean;
  keySuffix?: string;
}

export interface SeedResult {
  skipped: boolean;
  users: Array<{ email: string; password: string; role: string }>;
  project: string;
  keys: Record<string, { server: string; client: string }>;
  experimentId: string | null;
}

const PASSWORD = 'demo1234';
const ENVIRONMENTS = [
  { key: 'development', name: 'Development', color: '#22c55e' },
  { key: 'staging', name: 'Staging', color: '#f59e0b' },
  { key: 'production', name: 'Production', color: '#ef4444' },
];

const bool = [
  { id: 'on', value: true, name: 'On' },
  { id: 'off', value: false, name: 'Off' },
];

interface FlagSeed {
  key: string;
  name: string;
  description: string;
  kind: 'boolean' | 'string' | 'number' | 'json';
  variations: Array<{ id: string; value: unknown; name?: string }>;
  tags: string[];
  temporary: boolean;
  createdDaysAgo?: number;
  archived?: boolean;
  config: (env: string) => {
    on: boolean;
    off: string;
    fallthrough: unknown;
    rules?: unknown[];
    targets?: unknown[];
  };
}

const FLAGS: FlagSeed[] = [
  {
    key: 'new-checkout',
    name: 'New checkout',
    description: 'One-page checkout flow replacing the three step wizard.',
    kind: 'boolean',
    variations: bool,
    tags: ['checkout', 'release'],
    temporary: true,
    config: (env) => ({
      on: true,
      off: 'off',
      targets: env === 'production' ? [{ variation: 'on', contextKind: 'user', keys: ['qa-alice'] }] : [],
      rules: [
        {
          id: 'pro-users',
          description: 'Pro plan users first',
          clauses: [{ attribute: 'plan', op: 'eq', values: ['pro'] }],
          serve: { variation: 'on' },
        },
      ],
      fallthrough: {
        rollout: {
          weights: [
            { variation: 'on', weight: 25000 },
            { variation: 'off', weight: 75000 },
          ],
        },
      },
    }),
  },
  {
    key: 'banner-text',
    name: 'Homepage banner text',
    description: 'Experiment: which banner copy converts best.',
    kind: 'string',
    variations: [
      { id: 'A', value: 'Welcome to the Demo Shop', name: 'A · Welcome' },
      { id: 'B', value: 'Summer sale: everything -20% today', name: 'B · Sale' },
      { id: 'C', value: 'Free shipping on every order', name: 'C · Free shipping' },
    ],
    tags: ['experiment', 'marketing'],
    temporary: true,
    config: () => ({
      on: true,
      off: 'A',
      fallthrough: {
        rollout: {
          weights: [
            { variation: 'A', weight: 33333 },
            { variation: 'B', weight: 33333 },
            { variation: 'C', weight: 33334 },
          ],
        },
      },
    }),
  },
  {
    key: 'max-cart-items',
    name: 'Max cart items',
    description: 'Remote config: maximum number of items allowed in the cart.',
    kind: 'number',
    variations: [
      { id: 'small', value: 5, name: 'Small (5)' },
      { id: 'default', value: 20, name: 'Default (20)' },
      { id: 'large', value: 50, name: 'Large (50)' },
    ],
    tags: ['remote-config'],
    temporary: false,
    config: () => ({
      on: true,
      off: 'default',
      rules: [
        {
          id: 'key-accounts',
          clauses: [{ attribute: 'segment', op: 'segment_match', values: ['key-accounts'] }],
          serve: { variation: 'large' },
        },
      ],
      fallthrough: { variation: 'default' },
    }),
  },
  {
    key: 'pricing-page-layout',
    name: 'Pricing page layout',
    description: 'JSON remote config for the pricing page.',
    kind: 'json',
    variations: [
      { id: 'grid', value: { layout: 'grid', columns: 3, highlight: 'pro' }, name: 'Grid' },
      { id: 'list', value: { layout: 'list', columns: 1, highlight: null }, name: 'List' },
    ],
    tags: ['remote-config', 'pricing'],
    temporary: false,
    config: () => ({
      on: true,
      off: 'list',
      rules: [
        {
          id: 'beta',
          clauses: [{ attribute: 'segment', op: 'segment_match', values: ['beta-testers'] }],
          serve: { variation: 'grid' },
        },
      ],
      fallthrough: { variation: 'list' },
    }),
  },
  {
    key: 'dark-mode',
    name: 'Dark mode',
    description: 'Fully rolled out long ago: a candidate for removal.',
    kind: 'boolean',
    variations: bool,
    tags: ['ui'],
    temporary: true,
    createdDaysAgo: 90,
    config: () => ({ on: true, off: 'off', fallthrough: { variation: 'on' } }),
  },
  {
    key: 'legacy-search',
    name: 'Legacy search',
    description: 'Old search backend, archived.',
    kind: 'boolean',
    variations: bool,
    tags: ['search'],
    temporary: true,
    createdDaysAgo: 120,
    archived: true,
    config: () => ({ on: false, off: 'off', fallthrough: { variation: 'off' } }),
  },
];

async function insertKey(sql: Sql, envId: string, kind: 'server' | 'client', key: string) {
  await sql.query('INSERT INTO sdk_keys (env_id, kind, name, key_hash, prefix) VALUES ($1, $2, $3, $4, $5)', [
    envId,
    kind,
    `${kind} key (seed)`,
    sha256(key),
    key.slice(0, 10),
  ]);
}

export async function seed(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const suffix = options.keySuffix ?? 'demo';
  const keys: SeedResult['keys'] = {};
  for (const env of ENVIRONMENTS)
    keys[env.key] = { server: `srv-${suffix}-${env.key}`, client: `cli-${suffix}-${env.key}` };
  const users = [
    { email: 'demo@demo.dev', password: PASSWORD, role: 'admin', name: 'Dana Admin' },
    { email: 'reviewer@demo.dev', password: PASSWORD, role: 'writer', name: 'Riley Reviewer' },
    { email: 'viewer@demo.dev', password: PASSWORD, role: 'reader', name: 'Val Viewer' },
  ];
  const existing = await db.maybe("SELECT id FROM projects WHERE key = 'web-shop'");
  if (existing && !options.reset) {
    return {
      skipped: true,
      users: users.map(({ email, password, role }) => ({ email, password, role })),
      project: 'web-shop',
      keys,
      experimentId: null,
    };
  }
  const passwordHash = await hashPassword(PASSWORD);
  const experimentId = await db.tx(async (sql) => {
    if (options.reset) {
      await sql.query(
        'TRUNCATE organizations, users, events, flag_eval_counts, flag_last_seen, context_attributes, sdk_diagnostics RESTART IDENTITY CASCADE',
      );
    }
    const org = await sql.one<{ id: string }>(
      "INSERT INTO organizations (name) VALUES ('Demo Inc') RETURNING id",
    );
    const userIds: Record<string, string> = {};
    for (const user of users) {
      const row = await sql.one<{ id: string }>(
        'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [user.email, user.name, passwordHash],
      );
      userIds[user.email] = row.id;
      await sql.query('INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)', [
        org.id,
        row.id,
        user.role,
      ]);
    }
    const admin = userIds['demo@demo.dev']!;
    const project = await sql.one<{ id: string }>(
      "INSERT INTO projects (org_id, key, name) VALUES ($1, 'web-shop', 'Web Shop') RETURNING id",
      [org.id],
    );
    const envIds: Record<string, string> = {};
    for (const [index, env] of ENVIRONMENTS.entries()) {
      const row = await sql.one<{ id: string }>(
        'INSERT INTO environments (project_id, key, name, color, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [project.id, env.key, env.name, env.color, index],
      );
      envIds[env.key] = row.id;
      await insertKey(sql, row.id, 'server', keys[env.key]!.server);
      await insertKey(sql, row.id, 'client', keys[env.key]!.client);
    }
    for (const env of ENVIRONMENTS) {
      await sql.query(
        `INSERT INTO segments (env_id, key, name, description, context_kind, included, excluded, rules) VALUES
         ($1, 'beta-testers', 'Beta testers', 'Opted-in users and staff', 'user', $2, '{}', $3),
         ($1, 'key-accounts', 'Key accounts', 'Large B2B customers', 'organization', $4, '{}', '[]')`,
        [
          envIds[env.key],
          ['qa-alice', 'qa-bob'],
          JSON.stringify([{ clauses: [{ attribute: 'email', op: 'ends_with', values: ['@demo.dev'] }] }]),
          ['acme', 'globex'],
        ],
      );
    }
    const flagIds: Record<string, string> = {};
    for (const flag of FLAGS) {
      const createdAt = new Date(Date.now() - (flag.createdDaysAgo ?? 3) * 86400000);
      const row = await sql.one<{ id: string }>(
        `INSERT INTO flags (project_id, key, name, description, kind, variations, tags, temporary, salt, client_side_available, maintainer_id, archived_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $12) RETURNING id`,
        [
          project.id,
          flag.key,
          flag.name,
          flag.description,
          flag.kind,
          JSON.stringify(flag.variations),
          flag.tags,
          flag.temporary,
          sha256(`seed-salt:${flag.key}`).slice(0, 16),
          admin,
          flag.archived ? createdAt : null,
          createdAt,
        ],
      );
      flagIds[flag.key] = row.id;
      for (const env of ENVIRONMENTS) {
        const config = flag.config(env.key);
        await sql.query(
          `INSERT INTO flag_configs (flag_id, env_id, "on", off_variation, targets, rules, fallthrough, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            row.id,
            envIds[env.key],
            config.on,
            config.off,
            JSON.stringify(config.targets ?? []),
            JSON.stringify(config.rules ?? []),
            JSON.stringify(config.fallthrough),
            admin,
          ],
        );
      }
      await sql.query(
        `INSERT INTO audit_log (org_id, project_id, actor_id, actor_name, action, resource, descriptions, created_at) VALUES ($1, $2, $3, 'Dana Admin', 'flag.created', $4, $5, $6)`,
        [org.id, project.id, admin, `flag/${flag.key}`, [`created ${flag.kind} flag ${flag.key}`], createdAt],
      );
    }
    const metric = async (key: string, name: string, eventKey: string, kind: string, unit: string | null) =>
      (
        await sql.one<{ id: string }>(
          'INSERT INTO metrics (project_id, key, name, event_key, kind, unit) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [project.id, key, name, eventKey, kind, unit],
        )
      ).id;
    const purchase = await metric('purchase', 'Purchase conversion', 'purchase', 'conversion', null);
    const revenue = await metric('revenue', 'Revenue per visitor', 'purchase', 'numeric', 'USD');
    await metric('add-to-cart', 'Add to cart', 'add-to-cart', 'conversion', null);
    const experiment = await sql.one<{ id: string }>(
      `INSERT INTO experiments (project_id, env_id, flag_id, key, name, hypothesis, metric_ids, control_variation_id, minimum_sample_size, status, started_at)
       VALUES ($1, $2, $3, 'banner-copy', 'Banner copy test', 'A sale banner (B) increases purchase conversion vs. the welcome banner (A).', $4, 'A', 6000, 'running', now() - interval '1 minute') RETURNING id`,
      [project.id, envIds.production, flagIds['banner-text'], [purchase, revenue]],
    );
    await sql.query(
      `INSERT INTO change_requests (flag_id, env_id, instructions, comment, status, author_id, base_version)
       VALUES ($1, $2, $3, 'Raise the new checkout to 50% for everyone', 'pending', $4, 1)`,
      [
        flagIds['new-checkout'],
        envIds.production,
        JSON.stringify([
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
        ]),
        admin,
      ],
    );
    const friday = new Date();
    friday.setUTCDate(friday.getUTCDate() + ((5 - friday.getUTCDay() + 7) % 7 || 7));
    friday.setUTCHours(10, 0, 0, 0);
    await sql.query(
      `INSERT INTO scheduled_changes (flag_id, env_id, instructions, execute_at, status, comment, author_id)
       VALUES ($1, $2, $3, $4, 'pending', 'Friday 10:00: raise new checkout to 50%', $5)`,
      [
        flagIds['new-checkout'],
        envIds.staging,
        JSON.stringify([
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
        ]),
        friday,
        admin,
      ],
    );
    if (options.history !== false) {
      await sql.query(
        `INSERT INTO flag_eval_counts (env_id, flag_key, variation_id, hour, count)
         SELECT $1, f.key, v.id, h, (100 + floor(random() * 400))::bigint
         FROM generate_series(date_trunc('hour', now() - interval '7 days'), date_trunc('hour', now() - interval '1 hour'), interval '1 hour') h
         CROSS JOIN (VALUES ('new-checkout'), ('max-cart-items'), ('pricing-page-layout')) AS f(key)
         CROSS JOIN LATERAL (SELECT jsonb_array_elements(variations) ->> 'id' AS id FROM flags WHERE project_id = $2 AND key = f.key) v`,
        [envIds.production, project.id],
      );
      await sql.query(
        `INSERT INTO flag_last_seen (env_id, flag_key, last_evaluated_at) VALUES
         ($1, 'new-checkout', now() - interval '1 hour'), ($1, 'max-cart-items', now() - interval '1 hour'), ($1, 'pricing-page-layout', now() - interval '1 hour'),
         ($1, 'dark-mode', now() - interval '45 days')`,
        [envIds.production],
      );
      await sql.query(
        `INSERT INTO context_attributes (env_id, kind, name) SELECT $1, k, n FROM (VALUES ('user','plan'),('user','country'),('user','email'),('user','appVersion'),('organization','tier')) AS t(k, n)`,
        [envIds.production],
      );
    }
    return experiment.id;
  });
  return {
    skipped: false,
    users: users.map(({ email, password, role }) => ({ email, password, role })),
    project: 'web-shop',
    keys,
    experimentId,
  };
}
