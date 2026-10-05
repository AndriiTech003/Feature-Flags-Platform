export interface ChunkInfo {
  name: string;
  raw: number;
  gzip: number;
  initial: boolean;
}

export interface Budgets {
  chunkRawBytes: number;
  initialGzipBytes: number;
  lazyOnly: string[];
}

export const budgets: Budgets;
export function analyze(dir: string): { chunks: ChunkInfo[]; initialNames: Set<string> };
export function check(
  dir: string,
  limits?: Budgets,
): { chunks: ChunkInfo[]; initialGzip: number; problems: string[] };
