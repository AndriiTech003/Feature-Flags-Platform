import { loadConfig } from './config';
import { Db } from './db/db';
import { createDatabase, migrate, withDatabase } from './db/migrate';
import { seed } from './seed-lib';

const config = loadConfig();
const reset = process.argv.includes('--reset');
const history = !process.argv.includes('--no-history');
const name = new URL(config.databaseUrl).pathname.slice(1);
await createDatabase(withDatabase(config.databaseUrl, 'postgres'), name);
const db = new Db(config.databaseUrl, 2);
await migrate(db);
const result = await seed(db, { reset, history });
await db.close();
if (result.skipped) {
  console.log('project web-shop already exists; run with --reset to recreate demo data');
} else {
  console.log('seeded project web-shop');
}
console.log(JSON.stringify(result, null, 2));
