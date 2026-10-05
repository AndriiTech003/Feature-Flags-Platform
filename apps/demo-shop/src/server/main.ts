import { createShop, loadShopConfig } from './app';

const config = loadShopConfig();
const { app, flags } = createShop(config);
const status = await flags.waitForInitialization({ timeoutMs: 5000 });
const server = app.listen(config.port, config.host, () => {
  console.log(
    `demo-shop listening on http://${config.host}:${config.port} (flags ${status.initialized ? 'ready' : 'using defaults'})`,
  );
});
const shutdown = async () => {
  server.close();
  await flags.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
