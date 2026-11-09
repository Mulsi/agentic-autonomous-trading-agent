import {
  assertTestDatabaseName,
  createTestDatabase,
  databaseOf,
  dropTestDatabase,
  newTestDatabaseName,
  runDbMigrate,
  TEST_DB_PREFIX,
  UnsafeDatabaseError,
  withTestDatabase,
  type Queryable,
} from '../../fixtures/db.js';

/** Records queries instead of running them. */
function stubAdmin(): Queryable & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    query: (text: string) => {
      sql.push(text);
      return Promise.resolve();
    },
  };
}

// Port 1 has no Postgres, so even a broken guard could not reach a database.
const unreachable = (database: string): string =>
  `postgresql://trader:unused@127.0.0.1:1/${database}`;

const UNSAFE = [
  'trader',
  'postgres',
  'template1',
  TEST_DB_PREFIX,
  'TRADER_TEST_abc',
  'trader_testabc',
  'my_trader_test_abc',
  'trader_test_abc"; DROP DATABASE trader; --',
];

describe('the DB test guard', () => {
  it('accepts the generated test names', () => {
    const name = newTestDatabaseName();

    expect(name.startsWith(TEST_DB_PREFIX)).toBe(true);
    expect(assertTestDatabaseName(name)).toBe(name);
    expect(newTestDatabaseName()).not.toBe(name);
  });

  it.each(UNSAFE)('rejects the name %s', (name) => {
    expect(() => assertTestDatabaseName(name)).toThrow(UnsafeDatabaseError);
  });

  it.each(['trader', 'postgres'])(
    'refuses to create %s and sends no query',
    async (name) => {
      const admin = stubAdmin();

      await expect(createTestDatabase(admin, name)).rejects.toThrow(
        UnsafeDatabaseError,
      );
      expect(admin.sql).toEqual([]);
    },
  );

  it.each(['trader', 'postgres'])(
    'refuses to drop %s and sends no query',
    async (name) => {
      const admin = stubAdmin();

      await expect(dropTestDatabase(admin, name)).rejects.toThrow(
        UnsafeDatabaseError,
      );
      expect(admin.sql).toEqual([]);
    },
  );

  it.each(['trader', 'postgres'])(
    'refuses to migrate %s before starting a process',
    async (name) => {
      await expect(runDbMigrate(unreachable(name))).rejects.toThrow(
        UnsafeDatabaseError,
      );
    },
  );

  it('refuses any URL with a query string', () => {
    const name = newTestDatabaseName();

    expect(() => databaseOf(`${unreachable(name)}?database=trader`)).toThrow(
      UnsafeDatabaseError,
    );
    expect(() =>
      databaseOf(`${unreachable(name)}?options=-c%20search_path%3Dx`),
    ).toThrow(UnsafeDatabaseError);
    expect(() => databaseOf(`${unreachable(name)}?host=elsewhere`)).toThrow(
      UnsafeDatabaseError,
    );
    expect(databaseOf(unreachable(name))).toBe(name);
  });

  it('creates and drops quoted test databases', async () => {
    const admin = stubAdmin();
    const name = newTestDatabaseName();

    await createTestDatabase(admin, name);
    await dropTestDatabase(admin, name);

    expect(admin.sql).toEqual([
      `CREATE DATABASE "${name}"`,
      `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
    ]);
  });

  it('drops the database when the body throws, and rethrows', async () => {
    const admin = stubAdmin();
    let seen = '';

    await expect(
      withTestDatabase(admin, (name) => {
        seen = name;
        return Promise.reject(new Error('assertion failed'));
      }),
    ).rejects.toThrow('assertion failed');
    expect(admin.sql).toEqual([
      `CREATE DATABASE "${seen}"`,
      `DROP DATABASE IF EXISTS "${seen}" WITH (FORCE)`,
    ]);
  });
});
