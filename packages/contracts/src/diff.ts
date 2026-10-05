export interface DiffEntry {
  path: string;
  op: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonDiff(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before === undefined) return [{ path: path || '/', op: 'added', after }];
  if (after === undefined) return [{ path: path || '/', op: 'removed', before }];
  if (isObject(before) && isObject(after)) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
    return keys.flatMap((key) => jsonDiff(before[key], after[key], `${path}/${key}`));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const byId = (items: unknown[]) =>
      items.every((item) => isObject(item) && typeof item.id === 'string')
        ? new Map(items.map((item) => [(item as { id: string }).id, item]))
        : null;
    const a = byId(before);
    const b = byId(after);
    if (a && b) {
      const out: DiffEntry[] = [];
      for (const [id, item] of a) out.push(...jsonDiff(item, b.get(id), `${path}[id=${id}]`));
      for (const [id, item] of b)
        if (!a.has(id)) out.push({ path: `${path}[id=${id}]`, op: 'added', after: item });
      const orderBefore = before.map((x) => (x as { id: string }).id).filter((id) => b.has(id));
      const orderAfter = after.map((x) => (x as { id: string }).id).filter((id) => a.has(id));
      if (orderBefore.join() !== orderAfter.join()) {
        out.push({ path: `${path}#order`, op: 'changed', before: orderBefore, after: orderAfter });
      }
      return out;
    }
    const out: DiffEntry[] = [];
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i++) out.push(...jsonDiff(before[i], after[i], `${path}[${i}]`));
    return out;
  }
  return [{ path: path || '/', op: 'changed', before, after }];
}
