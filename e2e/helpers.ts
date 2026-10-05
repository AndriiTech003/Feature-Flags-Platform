import { expect, type Page } from '@playwright/test';

export const API = 'http://127.0.0.1:4250';
export const SHOP = 'http://127.0.0.1:4253';

export async function login(page: Page, email = 'demo@demo.dev', password = 'demo1234') {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/projects\/web-shop\/flags/);
}

export async function apiToken(email = 'demo@demo.dev', password = 'demo1234'): Promise<string> {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return ((await response.json()) as { token: string }).token;
}

export async function apiCall(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}
