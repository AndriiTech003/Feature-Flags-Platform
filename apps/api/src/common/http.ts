import { conflict } from './errors';

export function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
  if (!match) throw conflict('If-Match must contain a version number');
  return Number(match[1]);
}

export function actorOf(user: { id: string; name: string }) {
  return { id: user.id, name: user.name };
}
