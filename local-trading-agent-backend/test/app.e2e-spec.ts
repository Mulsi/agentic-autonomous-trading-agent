import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import {
  FIXTURE_API_KEY,
  FIXTURE_DB_PASSWORD,
  fixtureEnv,
} from './fixtures/env.js';
import { appRoot } from './fixtures/repo.js';

const EXIT_LIMIT_MS = 10_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface RunResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Spawns the built app. The env is explicit, so nothing real can leak in. */
function runMain(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: appRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, EXIT_LIMIT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr });
    });
  });
}

function stdoutLines(result: RunResult): string[] {
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

beforeAll(() => {
  if (!existsSync(join(appRoot, 'dist/main.js'))) {
    throw new Error('dist/main.js is missing. Run pnpm build first.');
  }
});

describe('node dist/main.js with valid env', () => {
  let result: RunResult;

  beforeAll(async () => {
    result = await runMain(fixtureEnv);
  }, EXIT_LIMIT_MS + 5_000);

  it('exits 0 by itself within the limit', () => {
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  it('writes only JSON lines with level, msg and a UTC time', () => {
    const lines = stdoutLines(result);

    expect(lines.length).toBeGreaterThan(1);
    for (const raw of lines) {
      const line = JSON.parse(raw) as Record<string, unknown>;

      expect(line).toHaveProperty('level');
      expect(line).toHaveProperty('msg');
      expect(line.time).toMatch(ISO_UTC);
    }
  });

  it("routes Nest's own boot lines through pino", () => {
    const contexts = stdoutLines(result).map(
      (raw) => (JSON.parse(raw) as { context?: string }).context,
    );

    expect(contexts).toContain('NestFactory');
    expect(contexts).toContain('InstanceLoader');
  });

  it('logs one startup line with the mode and a UUID correlationId', () => {
    const startup = stdoutLines(result)
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((line) => line.mode !== undefined);

    expect(startup).toHaveLength(1);
    expect(startup[0]?.mode).toBe('paper');
    expect(startup[0]?.correlationId).toMatch(UUID);
  });

  it('writes neither fixture secret', () => {
    const output = result.stdout + result.stderr;

    expect(output).not.toContain(FIXTURE_API_KEY);
    expect(output).not.toContain(FIXTURE_DB_PASSWORD);
  });
});

describe('node dist/main.js and the database', () => {
  // A plain TCP listener stands in for Postgres and counts connections. The
  // app has no database client until after S0c, so it must never dial out.
  let server: Server;
  let connections = 0;
  let result: RunResult;

  beforeAll(async () => {
    server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const url = new URL(fixtureEnv.DATABASE_URL);
    url.hostname = '127.0.0.1';
    url.port = String(port);

    result = await runMain({ ...fixtureEnv, DATABASE_URL: url.toString() });
  }, EXIT_LIMIT_MS + 5_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('boots and exits 0 without connecting', () => {
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(connections).toBe(0);
  });
});

describe('node dist/main.js with invalid env', () => {
  it.each(['live', 'testnet', 'PAPER'])(
    'refuses TRADER_MODE=%s without leaking secrets',
    async (mode) => {
      const result = await runMain({ ...fixtureEnv, TRADER_MODE: mode });

      expect(result.timedOut).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBeNull();
      expect(result.stderr).toContain('TRADER_MODE');
      expect(result.stdout + result.stderr).not.toContain(FIXTURE_API_KEY);
      expect(result.stdout + result.stderr).not.toContain(FIXTURE_DB_PASSWORD);
    },
    EXIT_LIMIT_MS + 5_000,
  );

  it(
    'refuses to start when TRADER_MODE is unset',
    async () => {
      const { ANTHROPIC_API_KEY, DATABASE_URL } = fixtureEnv;

      const result = await runMain({ ANTHROPIC_API_KEY, DATABASE_URL });

      expect(result.code).not.toBe(0);
      expect(result.code).not.toBeNull();
    },
    EXIT_LIMIT_MS + 5_000,
  );
});
