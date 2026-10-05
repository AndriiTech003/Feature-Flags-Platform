import { expect, test } from '@playwright/test';
import { apiCall, apiToken, login, SHOP } from './helpers';

test('create flag → enable 50% → playground result → demo-shop reflects the change without reload', async ({
  page,
  context,
}) => {
  const flagKey = `e2e-flag-${Date.now().toString(36)}`;
  const visitor = 'e2e-visitor-1';

  const shop = await context.newPage();
  await shop.goto(`${SHOP}/?user=${visitor}&plan=free`);
  await expect(shop.getByTestId('debug-panel')).toBeVisible();
  await expect(shop.locator('#live')).toHaveText('live');
  await shop.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });
  await expect(shop.getByTestId(`debug-flag-${flagKey}`)).toHaveCount(0);

  await login(page);
  await page.getByTestId('new-flag').click();
  await page.getByTestId('flag-name').fill('E2E checkout');
  await page.getByTestId('flag-key').fill(flagKey);
  await page.getByTestId('create-flag-submit').click();
  await expect(page).toHaveURL(new RegExp(`/flags/${flagKey}`));
  await expect(page.getByTestId('flag-title')).toContainText('E2E checkout');

  await page.getByTestId('fallthrough-mode').selectOption('__rollout');
  await page.getByTestId('fallthrough-percent-input').fill('50');
  await expect(page.getByTestId('fallthrough-first-percent')).toHaveText('50%');
  await expect(page.getByTestId('pending-count')).toHaveText('1 pending change');
  await page.getByTestId('review-changes').click();
  await expect(page.getByTestId('pending-descriptions')).toContainText(
    'default rule now serves rollout On 50% / Off 50%',
  );
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('pending-bar')).toHaveCount(0);

  await page.getByTestId('kill-switch-production').click();
  await page.getByTestId('confirm-toggle').click();
  await expect(page.getByTestId('kill-switch-production')).toContainText('Targeting is ON');

  await page.getByTestId('tab-playground').click();
  await page
    .getByTestId('playground-context')
    .fill(JSON.stringify({ kind: 'user', key: visitor, plan: 'free', country: 'DE' }));
  await page.getByTestId('playground-run').click();
  await expect(page.getByTestId('playground-reason')).toHaveText('FALLTHROUGH');
  await expect(page.getByTestId('playground-explanation')).toContainText('rollout On 50% / Off 50%');
  const playgroundValue = (await page.getByTestId('playground-value').textContent())!.trim();
  expect(['true', 'false']).toContain(playgroundValue);

  await expect(shop.getByTestId(`debug-value-${flagKey}`)).toHaveText(playgroundValue, { timeout: 5000 });
  await expect(shop.getByTestId(`debug-reason-${flagKey}`)).toHaveText('FALLTHROUGH');
  expect(await shop.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

  const token = await apiToken();
  const audit = await apiCall(token, 'GET', `/projects/web-shop/audit-log?resource=${flagKey}`);
  expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(
    expect.arrayContaining(['flag.created', 'flag.config.updated']),
  );
});

test('a change in the dashboard reaches the demo-shop in under a second, and plan switch shows RULE_MATCH', async ({
  page,
}) => {
  const token = await apiToken();
  const config = await apiCall(token, 'GET', '/projects/web-shop/flags/new-checkout/envs/production');
  await page.goto(`${SHOP}/?user=e2e-visitor-2&plan=free`);
  await expect(page.locator('#live')).toHaveText('live');
  const started = Date.now();
  await apiCall(
    token,
    'PATCH',
    '/projects/web-shop/flags/new-checkout/envs/production',
    [{ kind: 'updateFallthrough', serve: { variation: 'on' } }],
    { 'if-match': `"${config.body.version}"` },
  );
  await expect(page.getByTestId('debug-value-new-checkout')).toHaveText('true', { timeout: 3000 });
  expect(Date.now() - started).toBeLessThan(1000);
  await expect(page.getByTestId('checkout-mode')).toHaveText('One-page checkout');
  await page.getByTestId('plan-select').selectOption('pro');
  await expect(page.getByTestId('debug-reason-new-checkout')).toHaveText('RULE_MATCH #1');
});

test('change request: protected environment needs a second person to approve', async ({ page, browser }) => {
  const token = await apiToken();
  await apiCall(token, 'PATCH', '/projects/web-shop/environments/staging', { requireApproval: true });
  await login(page);
  await page.goto('/projects/web-shop/flags');
  await page.getByTestId('toggle-max-cart-items-staging').click();
  await page.getByTestId('confirm-toggle').click();
  await page.goto('/projects/web-shop/change-requests');
  await expect(page.getByTestId('cr-detail')).toContainText('max-cart-items in staging');
  await expect(page.getByTestId('cr-approve')).toBeDisabled();

  const reviewerContext = await browser.newContext();
  const reviewer = await reviewerContext.newPage();
  await login(reviewer, 'reviewer@demo.dev', 'demo1234');
  await reviewer.goto('/projects/web-shop/change-requests');
  await reviewer.getByText('max-cart-items').first().click();
  await reviewer.getByTestId('cr-approve').click();
  await expect(reviewer.getByTestId('cr-detail')).toContainText('approved');
  await reviewer.getByTestId('cr-apply').click();
  await expect(reviewer.getByTestId('cr-detail')).toContainText('applied');
  const config = await apiCall(token, 'GET', '/projects/web-shop/flags/max-cart-items/envs/staging');
  expect(config.body.on).toBe(false);
  await apiCall(token, 'PATCH', '/projects/web-shop/environments/staging', { requireApproval: false });
  await reviewerContext.close();
});

test('“flag was updated by X” banner appears when someone else changes the open flag', async ({ page }) => {
  await login(page);
  await page.goto('/projects/web-shop/flags/pricing-page-layout?env=development');
  await expect(page.getByTestId('flag-title')).toContainText('Pricing page layout');
  await expect(page.getByTestId('current-user')).toHaveText('Dana Admin');
  await page.waitForTimeout(500);
  const reviewerToken = await apiToken('reviewer@demo.dev');
  await apiCall(reviewerToken, 'PATCH', '/projects/web-shop/flags/pricing-page-layout/envs/development', [
    { kind: 'updateFallthrough', serve: { variation: 'grid' } },
  ]);
  await expect(page.getByTestId('updated-banner')).toContainText('Riley Reviewer');
});

test('experiment results page shows SRM status and the sample size calculator', async ({ page }) => {
  await login(page);
  await page.goto('/projects/web-shop/experiments/banner-copy');
  await expect(page.getByTestId('experiment-title')).toContainText('Banner copy test');
  await expect(page.getByTestId('srm-status')).toBeVisible();
  await expect(page.getByTestId('metric-purchase')).toContainText('two-proportion z-test');
  await expect(page.getByTestId('ss-result')).toContainText('users per variation');
});

test('dashboard loads route and chart chunks lazily', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname);
  });
  await page.goto('/login');
  await page.getByTestId('login-email').fill('demo@demo.dev');
  await page.getByTestId('login-password').fill('demo1234');
  await page.getByTestId('login-submit').click();
  await page.mouse.move(1, 1);
  await expect(page.getByTestId('flag-row-new-checkout')).toBeVisible();
  const initial = [...scripts];
  expect(initial.some((p) => /\/assets\/vendor-react-[\w-]+\.js$/.test(p))).toBe(true);
  expect(initial.some((p) => /\/assets\/flags-list-[\w-]+\.js$/.test(p))).toBe(true);
  expect(initial.some((p) => p.includes('vendor-charts'))).toBe(false);
  expect(initial.some((p) => p.includes('flag-detail'))).toBe(false);
  await page.getByTestId('flag-row-new-checkout').getByRole('link').first().click();
  await expect(page.getByTestId('flag-title')).toBeVisible();
  expect(scripts.some((p) => /\/assets\/flag-detail-[\w-]+\.js$/.test(p))).toBe(true);
  expect(scripts.some((p) => /\/assets\/vendor-charts-[\w-]+\.js$/.test(p))).toBe(true);
});
