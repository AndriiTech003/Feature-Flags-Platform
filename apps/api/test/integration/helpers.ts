import { inject } from 'vitest';
import { createApp, type RunningApi } from '../../src/app';
import { loadConfig, type AppConfig } from '../../src/config';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({}),
    port: 0,
    databaseUrl: inject('databaseUrl'),
    redisUrl: inject('redisUrl'),
    redisPrefix: inject('redisPrefix'),
    jwtSecret: 'test-secret',
    workerEnabled: false,
    ...overrides,
  };
}

export async function startApi(overrides: Partial<AppConfig> = {}): Promise<RunningApi> {
  return createApp(testConfig(overrides), { migrate: false });
}

export class ApiClient {
  token: string | null = null;

  constructor(readonly baseUrl: string) {}

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : undefined) as T,
      headers: response.headers,
    };
  }

  get<T = any>(path: string) {
    return this.request<T>('GET', path);
  }

  post<T = any>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body ?? {});
  }

  patch<T = any>(path: string, body: unknown, headers: Record<string, string> = {}) {
    return this.request<T>('PATCH', path, body, headers);
  }

  async signup(email: string, name = 'Tester'): Promise<{ id: string }> {
    const result = await this.post('/auth/signup', { email, password: 'password123', name });
    if (result.status !== 201)
      throw new Error(`signup failed ${result.status} ${JSON.stringify(result.body)}`);
    this.token = result.body.token;
    return result.body.user;
  }
}

export function uniqueKey(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}
