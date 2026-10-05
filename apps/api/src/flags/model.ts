import type { FlagConfig, Prerequisite, Variation } from '@ashamrai/flags-contracts';
import { iso } from '../db/db';

export interface FlagRow {
  id: string;
  project_id: string;
  key: string;
  name: string;
  description: string | null;
  kind: 'boolean' | 'string' | 'number' | 'json';
  variations: Variation[];
  tags: string[];
  temporary: boolean;
  salt: string;
  prerequisites: Prerequisite[];
  client_side_available: boolean;
  maintainer_id: string | null;
  archived_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface ConfigRow {
  flag_id: string;
  env_id: string;
  on: boolean;
  off_variation: string | null;
  targets: FlagConfig['targets'];
  rules: FlagConfig['rules'];
  fallthrough: FlagConfig['fallthrough'];
  version: number;
  updated_at: Date;
  updated_by: string | null;
}

export interface FlagDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: FlagRow['kind'];
  variations: Variation[];
  tags: string[];
  temporary: boolean;
  salt: string;
  prerequisites: Prerequisite[];
  clientSideAvailable: boolean;
  maintainerId: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type FlagConfigDto = FlagConfig & { updatedBy: string | null };

export function toFlag(row: FlagRow): FlagDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    kind: row.kind,
    variations: row.variations,
    tags: row.tags,
    temporary: row.temporary,
    salt: row.salt,
    prerequisites: row.prerequisites ?? [],
    clientSideAvailable: row.client_side_available,
    maintainerId: row.maintainer_id,
    archivedAt: iso(row.archived_at),
    version: row.version,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

export function toConfig(
  row: ConfigRow,
  flagKey: string,
  envKey: string,
  experiment: { id: string; key: string } | null = null,
): FlagConfigDto {
  return {
    flagKey,
    env: envKey,
    on: row.on,
    offVariation: row.off_variation,
    targets: row.targets,
    rules: row.rules,
    fallthrough: row.fallthrough,
    version: row.version,
    updatedAt: iso(row.updated_at)!,
    updatedBy: row.updated_by,
    experiment,
  };
}

export function patchable(config: FlagConfigDto) {
  return {
    on: config.on,
    offVariation: config.offVariation,
    targets: config.targets,
    rules: config.rules,
    fallthrough: config.fallthrough,
  };
}
