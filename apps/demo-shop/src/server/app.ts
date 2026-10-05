import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { init, type FlagsClient } from '@ashamrai/flags-node';
import { renderCheckout, renderPage } from './page';

export interface ShopConfig {
  port: number;
  host: string;
  relayUrl: string;
  publicRelayUrl: string;
  serverKey: string;
  clientKey: string;
}

export function loadShopConfig(env: NodeJS.ProcessEnv = process.env): ShopConfig {
  const relayUrl = env.RELAY_URL ?? 'http://127.0.0.1:4210';
  return {
    port: Number(env.SHOP_PORT ?? env.PORT ?? 4230),
    host: env.SHOP_HOST ?? '127.0.0.1',
    relayUrl,
    publicRelayUrl: env.PUBLIC_RELAY_URL ?? relayUrl,
    serverKey: env.FLAGS_SERVER_KEY ?? 'srv-demo-production',
    clientKey: env.FLAGS_CLIENT_KEY ?? 'cli-demo-production',
  };
}

function cookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

export function createShop(
  config: ShopConfig,
  flags: FlagsClient = init({ sdkKey: config.serverKey, baseUrl: config.relayUrl }),
): { app: Express; flags: FlagsClient } {
  const app = express();
  app.use(express.json());
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { index: false }));
  app.use(express.static(fileURLToPath(new URL('../../public', import.meta.url)), { index: false }));

  const visitor = (req: express.Request, res: express.Response) => {
    const jar = cookies(req.headers.cookie);
    let key = typeof req.query.user === 'string' ? req.query.user : jar.visitor;
    if (!key) key = `visitor-${randomBytes(4).toString('hex')}`;
    const plan = typeof req.query.plan === 'string' ? req.query.plan : (jar.plan ?? 'free');
    res.cookie('visitor', key, { sameSite: 'lax' });
    res.cookie('plan', plan, { sameSite: 'lax' });
    return { kind: 'user', key, plan, country: 'DE' };
  };

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', flags: flags.status() });
  });

  app.get('/', (req, res) => {
    const context = visitor(req, res);
    const state = flags.allFlagsState(context, { clientSideOnly: true, withReasons: true });
    const checkout = flags.boolVariation('new-checkout', context, false) ? 'new' : 'classic';
    res.type('html').send(
      renderPage({
        context,
        flags: state.flags,
        relayUrl: config.publicRelayUrl,
        clientKey: config.clientKey,
        checkout,
      }),
    );
  });

  app.get('/checkout', (req, res) => {
    const context = visitor(req, res);
    const detail = flags.boolVariationDetail('new-checkout', context, false);
    res.type('html').send(renderCheckout(detail.value ? 'new' : 'classic', context, detail.reason.kind));
  });

  app.get('/api/checkout', (req, res) => {
    const context = visitor(req, res);
    const detail = flags.boolVariationDetail('new-checkout', context, false);
    res.json({ checkout: detail.value ? 'new' : 'classic', reason: detail.reason });
  });

  app.post('/api/purchase', (req, res) => {
    const context = visitor(req, res);
    const total = Number((req.body as { total?: unknown }).total ?? 0);
    flags.track('purchase', context, { value: Number.isFinite(total) ? total : 0 });
    res.json({ ok: true });
  });

  return { app, flags };
}
