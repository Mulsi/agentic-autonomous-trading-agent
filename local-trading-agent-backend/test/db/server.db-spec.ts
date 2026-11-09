import { Client } from 'pg';
import { composeUrl } from '../fixtures/db.js';

// Runs against the compose Postgres from `make db-up`. It only reads settings
// through the `postgres` maintenance database and changes nothing.

let admin: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
});

async function show(setting: string): Promise<string> {
  const result = await admin.query<Record<string, string>>(`SHOW ${setting}`);
  const value = Object.values(result.rows[0] ?? {})[0];
  if (value === undefined) throw new Error(`SHOW ${setting} returned nothing`);
  return value;
}

describe('the compose Postgres server', () => {
  it('runs major version 16', async () => {
    const version = Number(await show('server_version_num'));

    expect(version).toBeGreaterThanOrEqual(160000);
    expect(version).toBeLessThan(170000);
  });

  it('uses UTC', async () => {
    expect(['UTC', 'Etc/UTC']).toContain(await show('timezone'));
    expect(['UTC', 'Etc/UTC']).toContain(await show('log_timezone'));
  });
});
