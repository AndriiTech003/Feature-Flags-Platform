import { loadConfig } from '../config';
import { Db } from './db';
import { createDatabase, migrate, withDatabase } from './migrate';

const config = loadConfig();
const name = new URL(config.databaseUrl).pathname.slice(1);
await createDatabase(withDatabase(config.databaseUrl, 'postgres'), name);
const db = new Db(config.databaseUrl, 2);
const applied = await migrate(db);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
await db.close();
