import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LoggerModule } from 'nestjs-pino';
import { AppModule } from '../../../src/app.module.js';
import { ConfigModule } from '../../../src/config/config.module.js';
import { DbModule } from '../../../src/db/db.module.js';
import * as schemaModule from '../../../src/db/schema.js';
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
    expect(schema).toMatch(/^\/\/ .*milestone.*\n?.*§7/m);
  });

  it('declares exactly one table, the identity marker', () => {
    expect(schema.match(/\bpgTable\(/g)).toHaveLength(1);
    expect(schema).toMatch(/pgTable\(\s*'database_identity'/);
    expect(Object.keys(schemaModule)).toEqual(['databaseIdentity']);
  });

  it.each([
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

  it('imports only drizzle-orm and drizzle-orm/pg-core', () => {
    const imports = [...schema.matchAll(/from\s+'([^']+)'/g)].map(
      (match) => match[1],
    );

    expect(imports.sort()).toEqual(['drizzle-orm', 'drizzle-orm/pg-core']);
    expect(schema).not.toMatch(/\brequire\(/);
  });
});

describe('src/db/migrations', () => {
  const journal = z
    .object({
      dialect: z.literal('postgresql'),
      entries: z.array(z.object({ idx: z.number(), tag: z.string() })),
    })
    .parse(JSON.parse(readAppFile(`${MIGRATIONS}/meta/_journal.json`)));
  const sqlFiles = readdirSync(join(appRoot, MIGRATIONS))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const sql = new Map(
    sqlFiles.map((name) => [name, readAppFile(`${MIGRATIONS}/${name}`)]),
  );
  const allSql = [...sql.values()].join('\n');
  /** Every match of `pattern` across all files, as [file, capture]. */
  const across = (pattern: RegExp): [string, string][] =>
    [...sql].flatMap(([name, text]) =>
      [...text.matchAll(pattern)].map((match): [string, string] => [
        name,
        match[1] ?? '',
      ]),
    );

  it('has one journal entry per .sql file, in order, each with a snapshot', () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
    expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(
      sqlFiles,
    );
    for (const [index, name] of sqlFiles.entries()) {
      expect(name.startsWith(String(index).padStart(4, '0') + '_')).toBe(true);
      const snapshot = `meta/${name.slice(0, 4)}_snapshot.json`;
      expect(existsSync(join(appRoot, MIGRATIONS, snapshot)), snapshot).toBe(
        true,
      );
    }
  });

  it('keeps 0000_init.sql as the comment drizzle-kit wrote', () => {
    expect(sql.get('0000_init.sql')).toBe(
      '-- Custom SQL migration file, put your code below! --',
    );
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
  ])('0000_init.sql has no %s', (keyword) => {
    expect(sql.get('0000_init.sql')).not.toMatch(
      new RegExp(`\\b${keyword}\\b`, 'i'),
    );
  });

  it('creates only the marker table', () => {
    expect(across(/\bCREATE\s+TABLE\s+"?(\w+)"?/gi)).toEqual([
      ['0001_database_identity.sql', 'database_identity'],
    ]);
    expect(allSql.match(/\bCREATE\s+TABLE\b/gi)).toHaveLength(1);
  });

  it('names only research_reader in CREATE ROLE and ALTER ROLE', () => {
    const roles = across(/\b(?:CREATE|ALTER)\s+ROLE\s+"?(\w+)"?/gi);

    expect(roles.length).toBeGreaterThan(0);
    expect(new Set(roles.map(([, role]) => role))).toEqual(
      new Set(['research_reader']),
    );
    expect(allSql.match(/\b(?:CREATE|ALTER)\s+ROLE\b/gi)).toHaveLength(
      roles.length,
    );
    expect(allSql).not.toMatch(/\b(?:CREATE|ALTER)\s+(USER|GROUP)\b/i);
  });

  it('grants only to research_reader', () => {
    const grants = across(/\bGRANT\b[^;']*?\bTO\s+"?(\w+)"?/gi);

    expect(grants.length).toBe(allSql.match(/\bGRANT\b/gi)?.length);
    expect(new Set(grants.map(([, role]) => role))).toEqual(
      new Set(['research_reader']),
    );
  });

  it('grants research_reader nothing beyond CONNECT, USAGE and SELECT', () => {
    const privileges = across(/\bGRANT\s+([A-Z, ]+?)\s+ON\b/gi).map(
      ([, list]) => list.trim().toUpperCase(),
    );

    expect(new Set(privileges)).toEqual(
      new Set(['CONNECT', 'USAGE', 'SELECT']),
    );
  });

  it('inserts only into the marker table', () => {
    expect(across(/\bINSERT\s+INTO\s+"?(\w+)"?/gi)).toEqual([
      ['0002_database_identity_marker.sql', 'database_identity'],
    ]);
    expect(allSql.match(/\bINSERT\b/gi)).toHaveLength(1);
  });

  it('generates the marker with gen_random_uuid()', () => {
    expect(sql.get('0002_database_identity_marker.sql')).toMatch(
      /INSERT INTO "database_identity" \("marker"\) VALUES \(gen_random_uuid\(\)\);/,
    );
  });

  it.each(['DROP', 'TRUNCATE', 'DELETE', 'UPDATE'])(
    'no migration contains %s',
    (keyword) => {
      expect(allSql).not.toMatch(new RegExp(`\\b${keyword}\\b`, 'i'));
    },
  );
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

describe('only src/db/client.ts connects', () => {
  const CLIENT = 'src/db/client.ts';

  it.each([
    /from\s+['"]pg['"]/,
    /require\(\s*['"]pg['"]\s*\)/,
    /import\(\s*['"]pg['"]\s*\)/,
    /drizzle-orm\/node-postgres/,
    /new\s+Pool\(/,
    /new\s+Client\(/,
    /\bdrizzle\(/,
  ])('no non-spec source under src/ but client.ts matches %s', (pattern) => {
    const offenders = nonSpecSources()
      .filter(({ path, text }) => path !== CLIENT && pattern.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('client.ts imports pg and the node-postgres driver, and builds the pool', () => {
    const client = readAppFile(CLIENT);

    expect(client).toMatch(/from\s+'pg'/);
    expect(client).toMatch(/from\s+'drizzle-orm\/node-postgres'/);
    expect(client).toMatch(/new\s+Pool\(/);
    expect(client).toMatch(/\bdrizzle\(/);
  });

  it('no non-spec source under src/ contains setTypeParser', () => {
    const offenders = nonSpecSources()
      .filter(({ text }) => text.includes('setTypeParser'))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('new URL( still appears only in src/config/secrets.ts', () => {
    const files = nonSpecSources()
      .filter(({ text }) => text.includes('new URL('))
      .map(({ path }) => path);

    expect(files).toEqual(['src/config/secrets.ts']);
  });

  it('process.env still appears only in src/config/config.module.ts', () => {
    const files = nonSpecSources()
      .filter(({ text }) => text.includes('process.env'))
      .map(({ path }) => path);

    expect(files).toEqual(['src/config/config.module.ts']);
  });

  it('AppModule imports ConfigModule, LoggerModule and DbModule', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    const modules = imports.map((entry) =>
      typeof entry === 'object' && entry !== null && 'module' in entry
        ? entry.module
        : entry,
    );

    expect(modules).toEqual([ConfigModule, LoggerModule, DbModule]);
  });
});

describe('the app never writes the marker (S0e)', () => {
  const sources = nonSpecSources().filter(
    ({ path }) => !path.startsWith(`${MIGRATIONS}/`),
  );

  it.each([
    /drizzle-orm\/[\w-]+\/migrator/,
    /drizzle-orm\/migrator/,
    /\bmigrate\(/,
  ])('no non-spec source outside the migrations matches %s', (pattern) => {
    const offenders = sources
      .filter(({ text }) => pattern.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it.each(['.insert(', '.update(', '.delete('])(
    'no non-spec source outside the migrations contains %s',
    (needle) => {
      const offenders = sources
        .filter(({ text }) => text.includes(needle))
        .map(({ path }) => path);

      expect(offenders).toEqual([]);
    },
  );

  it.each([
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'CREATE',
    'ALTER',
    'DROP',
    'GRANT',
  ])(
    'no non-spec source outside the migrations contains the word %s',
    (word) => {
      const pattern = new RegExp(`\\b${word}\\b`);
      const offenders = sources
        .filter(({ text }) => pattern.test(text))
        .map(({ path }) => path);

      expect(offenders).toEqual([]);
    },
  );
});
