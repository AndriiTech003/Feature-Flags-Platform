export interface Migration {
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    name: '001_core',
    sql: `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text,
  name text NOT NULL,
  github_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE org_members (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'writer', 'reader')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#64748b',
  require_approval boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);

CREATE TABLE sdk_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  env_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('server', 'client')),
  name text,
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  expires_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sdk_keys_env ON sdk_keys (env_id);

CREATE TABLE flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text,
  kind text NOT NULL CHECK (kind IN ('boolean', 'string', 'number', 'json')),
  variations jsonb NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  temporary boolean NOT NULL DEFAULT true,
  salt text NOT NULL,
  prerequisites jsonb NOT NULL DEFAULT '[]',
  client_side_available boolean NOT NULL DEFAULT false,
  maintainer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);

CREATE TABLE flag_configs (
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  env_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  "on" boolean NOT NULL DEFAULT false,
  off_variation text,
  targets jsonb NOT NULL DEFAULT '[]',
  rules jsonb NOT NULL DEFAULT '[]',
  fallthrough jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (flag_id, env_id)
);
CREATE INDEX flag_configs_env ON flag_configs (env_id);

CREATE TABLE segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  env_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text,
  context_kind text NOT NULL DEFAULT 'user',
  included text[] NOT NULL DEFAULT '{}',
  excluded text[] NOT NULL DEFAULT '{}',
  rules jsonb NOT NULL DEFAULT '[]',
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (env_id, key)
);

CREATE TABLE change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  env_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  instructions jsonb NOT NULL,
  comment text,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'failed')),
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  review_comment text,
  base_version int NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  applied_at timestamptz
);
CREATE INDEX change_requests_env ON change_requests (env_id, status);

CREATE TABLE scheduled_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  env_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  instructions jsonb NOT NULL,
  execute_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'executed', 'failed', 'cancelled')),
  comment text,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz
);
CREATE INDEX scheduled_changes_due ON scheduled_changes (execute_at) WHERE status = 'pending';

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  env_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name text,
  action text NOT NULL,
  resource text NOT NULL,
  before jsonb,
  after jsonb,
  instructions jsonb,
  descriptions text[] NOT NULL DEFAULT '{}',
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_project ON audit_log (project_id, created_at DESC);

CREATE TABLE metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('conversion', 'numeric')),
  unit text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);

CREATE TABLE experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  hypothesis text,
  metric_ids uuid[] NOT NULL,
  control_variation_id text,
  minimum_sample_size int,
  status text NOT NULL CHECK (status IN ('draft', 'running', 'stopped')),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);
CREATE UNIQUE INDEX experiments_one_running ON experiments (flag_id, env_id) WHERE status = 'running';

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text,
  events text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id bigserial PRIMARY KEY,
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status_code int,
  ok boolean NOT NULL,
  attempt int NOT NULL,
  error text,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at DESC);
`,
  },
  {
    name: '002_events',
    sql: `
CREATE TABLE events (
  env_id uuid NOT NULL,
  kind text NOT NULL,
  flag_key text,
  variation_id text,
  context_key text NOT NULL,
  event_key text,
  value double precision,
  in_experiment boolean NOT NULL DEFAULT false,
  ts timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (ts);

CREATE INDEX events_exposure ON events (env_id, flag_key, ts) WHERE kind = 'exposure';
CREATE INDEX events_custom ON events (env_id, event_key, context_key, ts) WHERE kind = 'custom';

CREATE TABLE events_default PARTITION OF events DEFAULT;

CREATE OR REPLACE FUNCTION ensure_event_partitions(start_day date, days int) RETURNS int AS $$
DECLARE
  d date;
  created int := 0;
  part text;
BEGIN
  FOR i IN 0..days - 1 LOOP
    d := start_day + i;
    part := 'events_' || to_char(d, 'YYYYMMDD');
    IF to_regclass(part) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)', part, d::timestamptz, (d + 1)::timestamptz);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION drop_old_event_partitions(keep_days int) RETURNS int AS $$
DECLARE
  r record;
  dropped int := 0;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'events' AND c.relname ~ '^events_[0-9]{8}$'
      AND to_date(substring(c.relname from 8), 'YYYYMMDD') < current_date - keep_days
  LOOP
    EXECUTE format('DROP TABLE %I', r.relname);
    dropped := dropped + 1;
  END LOOP;
  RETURN dropped;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE flag_eval_counts (
  env_id uuid NOT NULL,
  flag_key text NOT NULL,
  variation_id text NOT NULL,
  hour timestamptz NOT NULL,
  count bigint NOT NULL,
  PRIMARY KEY (env_id, flag_key, hour, variation_id)
);

CREATE TABLE flag_last_seen (
  env_id uuid NOT NULL,
  flag_key text NOT NULL,
  last_evaluated_at timestamptz NOT NULL,
  PRIMARY KEY (env_id, flag_key)
);

CREATE TABLE context_attributes (
  env_id uuid NOT NULL,
  kind text NOT NULL,
  name text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env_id, kind, name)
);

CREATE TABLE sdk_diagnostics (
  id bigserial PRIMARY KEY,
  env_id uuid NOT NULL,
  sdk_name text NOT NULL,
  sdk_version text NOT NULL,
  instance_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sdk_diagnostics_env ON sdk_diagnostics (env_id, received_at DESC);
`,
  },
  {
    name: '003_change_outbox',
    sql: `
CREATE TABLE change_outbox (
  id bigserial PRIMARY KEY,
  topic text NOT NULL CHECK (topic IN ('changes', 'sdk-keys')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  last_error text
);
`,
  },
];
