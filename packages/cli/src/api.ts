import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FlagSummary } from './codegen';

export interface Credentials {
  api: string;
  token: string;
}

export function credentialsPath(): string {
  return process.env.FLAGS_CREDENTIALS ?? join(homedir(), '.config', 'ashamrai-flags', 'credentials.json');
}

export async function loadCredentials(): Promise<Credentials | null> {
  if (process.env.FLAGS_TOKEN)
    return { api: process.env.FLAGS_API_URL ?? 'http://127.0.0.1:4200', token: process.env.FLAGS_TOKEN };
  try {
    return JSON.parse(await readFile(credentialsPath(), 'utf8')) as Credentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(credentials: Credentials): Promise<string> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  return path;
}

export async function login(api: string, email: string, password: string): Promise<Credentials> {
  const response = await fetch(`${api.replace(/\/+$/, '')}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  const body = (await response.json()) as { token: string };
  return { api: api.replace(/\/+$/, ''), token: body.token };
}

export async function fetchFlags(credentials: Credentials, project: string): Promise<FlagSummary[]> {
  const response = await fetch(
    `${credentials.api}/projects/${encodeURIComponent(project)}/flags?archived=all`,
    {
      headers: { authorization: `Bearer ${credentials.token}` },
    },
  );
  if (!response.ok) throw new Error(`could not load flags for ${project}: ${response.status}`);
  return ((await response.json()) as { items: FlagSummary[] }).items;
}
