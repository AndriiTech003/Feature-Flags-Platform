import type { FlagState } from '@ashamrai/flags-node';
import { PLANS, PRODUCTS } from './catalog';

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export interface PageInput {
  context: Record<string, unknown>;
  flags: Record<string, FlagState>;
  relayUrl: string;
  clientKey: string;
  checkout: 'new' | 'classic';
}

export function renderPage(input: PageInput): string {
  const banner =
    typeof input.flags['banner-text']?.value === 'string'
      ? (input.flags['banner-text'].value as string)
      : 'Welcome to the Demo Shop';
  const config = {
    relayUrl: input.relayUrl,
    clientKey: input.clientKey,
    context: input.context,
    bootstrap: { flags: input.flags },
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Demo Shop</title>
<link rel="stylesheet" href="/styles.css" />
</head>
<body>
<header class="top">
  <div class="brand"><span class="logo">DS</span> Demo Shop</div>
  <div class="user">
    <span data-testid="visitor">${escape(String(input.context.key))}</span>
    <select id="plan" data-testid="plan-select">
      ${PLANS.map((p) => `<option value="${p.id}" ${p.id === input.context.plan ? 'selected' : ''}>${p.name} plan</option>`).join('')}
    </select>
  </div>
</header>
<div class="banner" id="banner" data-testid="banner">${escape(banner)}</div>
<main class="layout">
  <section>
    <h2>Products</h2>
    <div class="products">
      ${PRODUCTS.map((p) => `<article class="product"><div class="badge">${p.badge}</div><h3>${escape(p.name)}</h3><p>$${p.price}</p><button data-add="${p.id}" data-price="${p.price}">Add to cart</button></article>`).join('')}
    </div>
    <h2>Pricing</h2>
    <div id="pricing" class="pricing" data-testid="pricing"></div>
  </section>
  <aside>
    <div class="cart">
      <h2>Cart <span id="cart-count">0</span> / <span id="cart-limit" data-testid="cart-limit">?</span></h2>
      <ul id="cart-items"></ul>
      <p id="cart-message" class="muted"></p>
      <div class="checkout" data-testid="checkout-mode" id="checkout-mode" data-server="${input.checkout}">${input.checkout === 'new' ? 'One-page checkout' : 'Classic 3-step checkout'}</div>
      <button id="buy" data-testid="buy">Buy</button>
      <a href="/checkout" data-testid="go-checkout">Go to checkout</a>
    </div>
    <div class="debug" data-testid="debug-panel">
      <h3>Flags debug panel <span id="live" class="pill">connecting…</span></h3>
      <div class="muted">Context</div>
      <pre id="ctx" data-testid="debug-context"></pre>
      <table><thead><tr><th>Flag</th><th>Value</th><th>Reason</th></tr></thead><tbody id="flags"></tbody></table>
      <div class="muted" id="updated"></div>
    </div>
  </aside>
</main>
<script>window.__SHOP__ = ${JSON.stringify(config).replace(/</g, '\\u003c')};</script>
<script src="/build/app.global.js"></script>
</body>
</html>`;
}

export function renderCheckout(
  mode: 'new' | 'classic',
  context: Record<string, unknown>,
  reason: string,
): string {
  const steps =
    mode === 'new'
      ? `<section class="cart"><h2>One-page checkout</h2><p class="muted">Address, delivery and payment on a single page.</p>
         <label>Email <input value="${escape(String(context.key))}@example.com" /></label>
         <label>Card <input placeholder="4242 4242 4242 4242" /></label>
         <button data-testid="pay">Pay now</button></section>`
      : `<section class="cart"><h2>Checkout · step 1 of 3</h2><p class="muted">Shipping address → delivery options → payment.</p>
         <label>Street <input /></label><button data-testid="next-step">Continue to delivery</button></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Checkout · Demo Shop</title><link rel="stylesheet" href="/styles.css" /></head>
<body><header class="top"><div class="brand"><span class="logo">DS</span> Demo Shop</div><a href="/">Back to shop</a></header>
<main class="layout" data-testid="checkout-page" data-mode="${mode}">${steps}
<aside class="debug"><h3>new-checkout</h3><pre>${escape(JSON.stringify({ value: mode === 'new', reason }, null, 2))}</pre></aside></main></body></html>`;
}
