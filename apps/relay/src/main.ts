import { createRelay } from './app';
import { loadRelayConfig } from './config';

const config = loadRelayConfig();
const relay = await createRelay(config);
console.log(`relay listening on ${relay.url}`);
const shutdown = async () => {
  await relay.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
