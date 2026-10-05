import { createStore, type EvaluationStore } from '@ashamrai/flags-evaluator';
import type { FlagWithConfig, Ruleset, Segment } from './types';

export interface PatchMessage {
  kind: 'flag' | 'segment';
  key: string;
  version: number;
  data: FlagWithConfig | Segment | null;
}

export class DataStore {
  private ruleset: Ruleset = { version: 0, flags: {}, segments: {} };
  private evaluationStore: EvaluationStore = createStore(this.ruleset);
  initialized = false;

  get version(): number {
    return this.ruleset.version;
  }

  get store(): EvaluationStore {
    return this.evaluationStore;
  }

  flags(): FlagWithConfig[] {
    return Object.values(this.ruleset.flags);
  }

  snapshot(): Ruleset {
    return this.ruleset;
  }

  replace(ruleset: Ruleset): string[] {
    const previous = this.ruleset;
    const next: Ruleset = {
      env: ruleset.env,
      version: Number(ruleset.version) || 0,
      flags: { ...(ruleset.flags ?? {}) },
      segments: { ...(ruleset.segments ?? {}) },
    };
    this.ruleset = next;
    this.evaluationStore = createStore(next);
    this.initialized = true;
    const changed: string[] = [];
    const keys = new Set([...Object.keys(previous.flags), ...Object.keys(next.flags)]);
    for (const key of keys) {
      if (JSON.stringify(previous.flags[key]) !== JSON.stringify(next.flags[key])) changed.push(key);
    }
    return changed;
  }

  applyPatch(patch: PatchMessage): boolean {
    if (patch.version < this.ruleset.version) return false;
    const next: Ruleset = {
      ...this.ruleset,
      flags: { ...this.ruleset.flags },
      segments: { ...this.ruleset.segments },
      version: patch.version,
    };
    if (patch.kind === 'flag') {
      const existing = next.flags[patch.key];
      const incoming = patch.data as FlagWithConfig | null;
      if (
        existing &&
        incoming &&
        incoming.config &&
        existing.config &&
        incoming.config.version < existing.config.version
      )
        return false;
      if (incoming) next.flags[patch.key] = incoming;
      else delete next.flags[patch.key];
    } else {
      const incoming = patch.data as Segment | null;
      if (incoming) next.segments[patch.key] = incoming;
      else delete next.segments[patch.key];
    }
    this.ruleset = next;
    this.evaluationStore = createStore(next);
    return true;
  }
}
