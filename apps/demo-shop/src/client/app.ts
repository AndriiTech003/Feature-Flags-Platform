import { createClient, type FlagValue, type FlagValues } from '@ashamrai/flags-web';

interface ShopConfig {
  relayUrl: string;
  clientKey: string;
  context: { kind: string; key: string; plan: string; [k: string]: unknown };
  bootstrap: { flags: FlagValues };
}

const config = (window as unknown as { __SHOP__: ShopConfig }).__SHOP__;
const client = createClient({
  clientKey: config.clientKey,
  baseUrl: config.relayUrl,
  context: config.context,
  bootstrap: config.bootstrap,
  withReasons: true,
  flushIntervalMs: 2000,
});

const $ = (id: string) => document.getElementById(id)!;
const cart: Array<{ id: string; price: number }> = [];

function reasonText(flag: FlagValue | undefined): string {
  const reason = flag?.reason;
  if (!reason) return '';
  if (reason.kind === 'RULE_MATCH')
    return `RULE_MATCH #${Number(reason.ruleIndex) + 1}${reason.inExperiment ? ' (experiment)' : ''}`;
  if (reason.kind === 'FALLTHROUGH' && reason.inExperiment) return 'FALLTHROUGH (experiment)';
  if (reason.kind === 'ERROR') return `ERROR ${String(reason.errorKind)}`;
  return reason.kind;
}

function render(changed: string[] = []) {
  $('banner').textContent = client.variation('banner-text', 'Welcome to the Demo Shop');
  const limit = client.variation('max-cart-items', 20);
  $('cart-limit').textContent = String(limit);
  $('cart-count').textContent = String(cart.length);
  const checkout = client.variation('new-checkout', false);
  $('checkout-mode').textContent = checkout ? 'One-page checkout' : 'Classic 3-step checkout';
  $('checkout-mode').className = `checkout ${checkout ? 'new' : 'classic'}`;
  $('checkout-mode').setAttribute('data-value', String(checkout));
  const layout = client.variation<{ layout?: string; columns?: number; highlight?: string | null }>(
    'pricing-page-layout',
    { layout: 'list', columns: 1, highlight: null },
  );
  const pricing = $('pricing');
  pricing.className = `pricing ${layout.layout === 'grid' ? 'grid' : 'list'}`;
  pricing.style.setProperty('--columns', String(layout.columns ?? 1));
  pricing.innerHTML = ['Free', 'Pro', 'Team']
    .map(
      (name) =>
        `<div class="plan ${layout.highlight === name.toLowerCase() ? 'highlight' : ''}"><b>${name}</b><span>${name === 'Free' ? '$0' : name === 'Pro' ? '$19' : '$49'}/mo</span></div>`,
    )
    .join('');
  $('ctx').textContent = JSON.stringify(client.getContext(), null, 2);
  const rows = Object.keys(client.allFlags())
    .sort()
    .map((key) => {
      const flag = client.getFlag(key);
      const value = JSON.stringify(flag?.value);
      return `<tr data-testid="debug-flag-${key}" class="${changed.includes(key) ? 'flash' : ''}"><td>${key}</td><td data-testid="debug-value-${key}">${value === undefined ? '' : value.replace(/</g, '&lt;')}</td><td data-testid="debug-reason-${key}">${reasonText(flag)}</td></tr>`;
    });
  $('flags').innerHTML = rows.join('');
}

client.on('change', (changes) => {
  render(Object.keys(changes));
  $('updated').textContent =
    `Updated ${new Date().toLocaleTimeString()} without reload: ${Object.keys(changes).join(', ')}`;
});
client.on('ready', () => {
  $('live').textContent = 'live';
  $('live').className = 'pill live';
});
client.on('error', () => {
  $('live').textContent = 'reconnecting';
  $('live').className = 'pill';
});

document.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((button) => {
  button.addEventListener('click', () => {
    const limit = client.variation('max-cart-items', 20);
    if (cart.length >= limit) {
      $('cart-message').textContent = `Cart limit of ${limit} items reached (remote config).`;
      return;
    }
    cart.push({ id: button.dataset.add!, price: Number(button.dataset.price) });
    const li = document.createElement('li');
    li.textContent = `${button.dataset.add} $${button.dataset.price}`;
    $('cart-items').appendChild(li);
    client.track('add-to-cart', { value: Number(button.dataset.price) });
    render();
  });
});

$('buy').addEventListener('click', async () => {
  const total = cart.reduce((sum, item) => sum + item.price, 0);
  client.track('purchase', { value: total });
  await fetch('/api/purchase', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ total }),
  }).catch(() => undefined);
  cart.length = 0;
  $('cart-items').innerHTML = '';
  $('cart-message').textContent = `Thanks! Purchase of $${total} tracked.`;
  render();
});

($('plan') as HTMLSelectElement).addEventListener('change', async (event) => {
  const plan = (event.target as HTMLSelectElement).value;
  document.cookie = `plan=${plan}; path=/; samesite=lax`;
  await client.identify({ ...client.getContext(), plan });
  render();
});

render();
