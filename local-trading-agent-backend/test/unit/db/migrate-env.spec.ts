import {
  cpSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../../fixtures/db.js';
import { appRoot, readPackageJson } from '../../fixtures/repo.js';

// drizzle-kit bundles dotenv and loads `.env` from its working directory when
// it starts. These tests build a throwaway copy of the app's drizzle setup in
// a temp folder, with a fixture `.env` that points at a local TCP listener,
// and count the connections. No real `.env` is read or written, and no
// Postgres is needed.
//
// The `db:migrate` command line runs through `sh -c` with node_modules/.bin on
// PATH, as `pnpm run` does. pnpm itself is not used: it would verify the
// install first, which a temp copy cannot pass.

const LIMIT_MS = 40_000;

let dir: string;
let server: Server;
let serverUrl: string;
let connections = 0;

beforeAll(async () => {
  server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  serverUrl = `postgresql://fixture:fixture@127.0.0.1:${port}/trader_test_dotenv`;

  dir = mkdtempSync(join(tmpdir(), 'drizzle-env-'));
  for (const file of ['package.json', 'drizzle.config.ts']) {
    cpSync(join(appRoot, file), join(dir, file));
  }
  cpSync(join(appRoot, 'src/db'), join(dir, 'src/db'), { recursive: true });
  symlinkSync(join(appRoot, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, '.env'), `DATABASE_URL=${serverUrl}\n`);
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  connections = 0;
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${join(dir, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? '',
    ...extra,
  };
}

function runScript(extra: Record<string, string> = {}) {
  const command = readPackageJson().scripts['db:migrate'] ?? '';
  return runCommand('/bin/sh', ['-c', command], dir, env(extra));
}

describe('db:migrate with a .env in its working directory', () => {
  it(
    'ignores the file: fails for the unset variable and connects nowhere',
    async () => {
      const result = await runScript();

      expect(result.timedOut).toBe(false);
      expect(result.code).not.toBe(0);
      expect(connections).toBe(0);
    },
    LIMIT_MS,
  );

  it(
    'control: the same command connects when DATABASE_URL is in the env',
    async () => {
      const result = await runScript({ DATABASE_URL: serverUrl });

      expect(result.code).not.toBe(0);
      expect(connections).toBeGreaterThan(0);
    },
    LIMIT_MS,
  );

  it(
    'control: bare drizzle-kit migrate does load the file and connects',
    async () => {
      const result = await runCommand(
        '/bin/sh',
        ['-c', 'drizzle-kit migrate'],
        dir,
        env(),
      );

      expect(result.code).not.toBe(0);
      expect(connections).toBeGreaterThan(0);
    },
    LIMIT_MS,
  );
});
