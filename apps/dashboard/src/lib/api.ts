declare global {
  interface Window {
    __FFP_CONFIG__?: { apiUrl?: string; relayUrl?: string };
  }
}

export const API_URL: string =
  (typeof window !== 'undefined' && window.__FFP_CONFIG__?.apiUrl) ||
  import.meta.env.VITE_API_URL ||
  'http://127.0.0.1:4200';

const TOKEN_KEY = 'ffp.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { message?: string; error?: string; [key: string]: unknown },
  ) {
    super(body?.message ?? `request failed with ${status}`);
  }
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const token = getToken();
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && path !== '/auth/login') {
    setToken(null);
    if (!location.pathname.startsWith('/login')) location.assign('/login');
  }
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new ApiError(response.status, parsed ?? {});
  return parsed as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const patch = <T>(path: string, body: unknown, headers?: Record<string, string>) =>
  api<T>('PATCH', path, body, headers);
export const del = <T>(path: string) => api<T>('DELETE', path);

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const issues = error.body.issues as Array<{ path: string; message: string }> | undefined;
    if (issues?.length) return `${error.message}: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
