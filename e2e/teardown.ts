import pg from 'pg';

export default async function teardown() {
  const database = `ffp_test_e2e_${process.env.E2E_ID}`;
  const client = new pg.Client({
    connectionString: `${process.env.E2E_PG_URL ?? 'postgres://127.0.0.1:5432'}/postgres`,
  });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}
