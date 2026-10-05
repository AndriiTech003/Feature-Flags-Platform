import type { EventBatch } from '@ashamrai/flags-contracts';
import type { Ruleset } from '@ashamrai/flags-evaluator';

export interface KeyInfo {
  envId: string;
  kind: 'server' | 'client';
}

export interface RulesetSnapshot {
  envId: string;
  envKey: string;
  version: number;
  ruleset: Ruleset;
}

export interface IngestResult {
  exposures: number;
  custom: number;
  summaries: number;
  diagnostics: number;
}

export interface RelaySource {
  resolveKey(key: string): Promise<KeyInfo | null>;
  loadRuleset(envId: string): Promise<RulesetSnapshot | null>;
  currentVersions(envIds: string[]): Promise<Map<string, number>>;
  ingest(envId: string, batch: EventBatch): Promise<IngestResult>;
  recordAttributes(envId: string, attributes: Array<{ kind: string; name: string }>): Promise<void>;
  invalidateKeys(): void;
  close(): Promise<void>;
}

export class MemorySource implements RelaySource {
  readonly keys = new Map<string, KeyInfo>();
  readonly snapshots = new Map<string, RulesetSnapshot>();
  readonly ingested: Array<{ envId: string; batch: EventBatch }> = [];
  readonly attributes: Array<{ envId: string; kind: string; name: string }> = [];

  async resolveKey(key: string) {
    return this.keys.get(key) ?? null;
  }

  async loadRuleset(envId: string) {
    const snapshot = this.snapshots.get(envId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async currentVersions(envIds: string[]) {
    const out = new Map<string, number>();
    for (const id of envIds) {
      const snapshot = this.snapshots.get(id);
      if (snapshot) out.set(id, snapshot.version);
    }
    return out;
  }

  async ingest(envId: string, batch: EventBatch) {
    this.ingested.push({ envId, batch });
    const count = (kind: string) => batch.events.filter((e) => e.kind === kind).length;
    return {
      exposures: count('exposure'),
      custom: count('custom'),
      summaries: count('summary'),
      diagnostics: count('diagnostic'),
    };
  }

  async recordAttributes(envId: string, attributes: Array<{ kind: string; name: string }>) {
    for (const a of attributes) this.attributes.push({ envId, ...a });
  }

  invalidateKeys() {
    return undefined;
  }

  async close() {
    return undefined;
  }
}
