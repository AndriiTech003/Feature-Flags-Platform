import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const api = await createApp(config);
console.log(`api listening on ${api.url} (worker ${config.workerEnabled ? 'on' : 'off'})`);
const shutdown = async () => {
  await api.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
