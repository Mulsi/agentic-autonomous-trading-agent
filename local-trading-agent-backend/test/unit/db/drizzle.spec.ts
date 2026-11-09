import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AppModule } from '../../../src/app.module.js';
import { ConfigModule } from '../../../src/config/config.module.js';
import { LoggerModule } from 'nestjs-pino';
import {
  appRoot,
  nonSpecSources,
  readAppFile,
  readPackageJson,
} from '../../fixtures/repo.js';

const MIGRATIONS = 'src/db/migrations';

/** The version pnpm-lock.yaml records for a direct dependency. */
function lockedVersion(name: string): string | undefined {
  const lock = readAppFile('pnpm-lock.yaml');
  const importers = lock.split(/^packages:$/m)[0] ?? '';
  const quoted = name.startsWith('@') ? `'${name}'` : name;
  const match = new RegExp(
    `^ {6}${quoted.replace(/[/.]/g, '\\$&')}:\\n {8}specifier: .*\\n {8}version: (\\S+)$`,
    'm',
  ).exec(importers);
  return match?.[1]?.replace(/\(.*$/, '');
}

describe('database dependencies', () => {
  const { dependencies, devDependencies } = readPackageJson();
  const stable = /^\d+\.\d+\.\d+$/;

  it.each([
    ['drizzle-orm', dependencies],
    ['pg', dependencies],
    ['drizzle-kit', devDependencies],
    ['@types/pg', devDependencies],
  ])(
    'lists %s with a stable range and a stable locked version',
    (name, section) => {
      const range = section[name];

      expect(range).toMatch(/^[\^~]?\d+\.\d+\.\d+$/);
      expect(lockedVersion(name)).toMatch(stable);
    },
  );

  it('keeps drizzle-kit out of the runtime dependencies', () => {
    expect(dependencies).not.toHaveProperty('drizzle-kit');
  });

  it('has no dotenv', () => {
    expect({ ...dependencies, ...devDependencies }).not.toHaveProperty(
      'dotenv',
    );
  });
});

describe('drizzle.config.ts', () => {
  const config = readAppFile('drizzle.config.ts');

  it('uses postgresql, the schema file and the migrations folder', () => {
    expect(config).toMatch(/dialect: 'postgresql'/);
    expect(config).toMatch(/schema: '\.\/src\/db\/schema\.ts'/);
    expect(config).toMatch(/out: '\.\/src\/db\/migrations'/);
  });

  it('reads the URL from process.env.DATABASE_URL and nowhere else', () => {
    expect(config).toContain('process.env.DATABASE_URL');
    expect(config.match(/process\.env/g)).toHaveLength(1);
  });

  it.each(['dotenv', 'loadEnvFile', 'env-file', '.env', 'readFile', 'import('])(
    'has no %s',
    (needle) => {
      const withoutTheVariable = config.replaceAll('process.env', '');

      expect(withoutTheVariable).not.toContain(needle);
    },
  );
});

describe('src/db/schema.ts', () => {
  const schema = readAppFile('src/db/schema.ts');

  it('exists and says tables arrive with their milestone', () => {
    expect(schema).toMatch(/^\/\/ .*milestone.*§7/m);
  });

  it.each([
    'pgTable',
    'pgEnum',
    'pgSchema',
    'pgView',
    'pgMaterializedView',
    'pgSequence',
    'pgRole',
    'pgPolicy',
  ])('declares no %s', (needle) => {
    expect(schema).not.toContain(needle);
  });

  it('imports nothing', () => {
    expect(schema).not.toMatch(/\bimport\b|\brequire\(/);
  });
});

describe('src/db/migrations', () => {
  const journal = z
    .object({
      dialect: z.literal('postgresql'),
      entries: z.array(z.object({ idx: z.number(), tag: z.string() })),
    })
    .parse(JSON.parse(readAppFile(`${MIGRATIONS}/meta/_journal.json`)));
  const sqlFiles = readdirSync(join(appRoot, MIGRATIONS)).filter((name) =>
    name.endsWith('.sql'),
  );

  it('holds exactly one .sql file', () => {
    expect(sqlFiles).toHaveLength(1);
  });

  it('has one journal entry naming that file, with a snapshot', () => {
    const [entry] = journal.entries;

    expect(journal.entries).toHaveLength(1);
    expect(`${entry?.tag}.sql`).toBe(sqlFiles[0]);
    expect(
      existsSync(join(appRoot, MIGRATIONS, 'meta/0000_snapshot.json')),
    ).toBe(true);
  });

  it('has an empty snapshot', () => {
    const snapshot = JSON.parse(
      readAppFile(`${MIGRATIONS}/meta/0000_snapshot.json`),
    ) as Record<string, unknown>;

    for (const key of ['tables', 'enums', 'schemas', 'views', 'sequences']) {
      expect(snapshot[key]).toEqual({});
    }
  });

  it.each([
    'CREATE',
    'ALTER',
    'DROP',
    'INSERT',
    'UPDATE',
    'DELETE',
    'GRANT',
    'TRUNCATE',
  ])('the migration has no %s', (keyword) => {
    const sql = readAppFile(`${MIGRATIONS}/${sqlFiles[0]}`);

    expect(sql).not.toMatch(new RegExp(`\\b${keyword}\\b`, 'i'));
  });
});

describe('database scripts', () => {
  const { scripts } = readPackageJson();
  const dbScripts = Object.entries(scripts).filter(
    ([name]) => name.startsWith('db:') || name === 'test:db',
  );

  it('has db:generate, db:migrate and test:db', () => {
    expect(scripts['db:generate']).toMatch(/\bdrizzle-kit generate$/);
    expect(scripts['db:migrate']).toMatch(/\bdrizzle-kit migrate$/);
    expect(scripts['test:db']).toBe(
      'vitest run --config ./vitest.config.db.ts',
    );
  });

  it('never uses drizzle-kit push', () => {
    for (const command of Object.values(scripts)) {
      expect(command).not.toMatch(/drizzle-kit\s+push/);
    }
  });

  it('no db:* or test:db script references .env', () => {
    for (const [, command] of dbScripts) {
      expect(command).not.toMatch(/\.env|env-file|loadEnvFile/);
    }
  });

  it('stops drizzle-kit from loading a .env file', () => {
    // drizzle-kit bundles dotenv and loads `.env` from its working directory at
    // startup. Pointing dotenv at /dev/null turns that off.
    expect(scripts['db:generate']).toMatch(/^DOTENV_CONFIG_PATH=\/dev\/null /);
    expect(scripts['db:migrate']).toMatch(/^DOTENV_CONFIG_PATH=\/dev\/null /);
  });
});

describe('the app stays unconnected', () => {
  it.each([
    /from\s+['"]pg['"]/,
    /require\(\s*['"]pg['"]\s*\)/,
    /import\(\s*['"]pg['"]\s*\)/,
    /drizzle-orm\/node-postgres/,
    /new\s+Pool\(/,
    /new\s+Client\(/,
    /\bdrizzle\(/,
  ])('no non-spec source under src/ matches %s', (pattern) => {
    const offenders = nonSpecSources()
      .filter(({ text }) => pattern.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('AppModule imports only ConfigModule and LoggerModule', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    const modules = imports.map((entry) =>
      typeof entry === 'object' && entry !== null && 'module' in entry
        ? entry.module
        : entry,
    );

    expect(modules).toEqual([ConfigModule, LoggerModule]);
  });
});
