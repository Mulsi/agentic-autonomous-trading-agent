import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  BootConsoleLogger,
  bootSecrets,
  printBootFailure,
  recordBootSecrets,
} from '../../../src/config/boot-output.js';
import { ConfigModule } from '../../../src/config/config.module.js';
import { secretValues } from '../../../src/config/secrets.js';
import { parseSettings } from '../../../src/config/settings.js';
import {
  FIXTURE_DATABASE_URL,
  FIXTURE_DB_PASSWORD,
  fixtureEnv,
  stubFixtureEnv,
} from '../../fixtures/env.js';
import { REDACTED } from '../../fixtures/logs.js';
import { readAppFile } from '../../fixtures/repo.js';

const S = FIXTURE_DB_PASSWORD;

/** Captures what is written to stdout and stderr while `body` runs. */
async function captured(
  body: () => unknown,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const out = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
  const err = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
  try {
    await body();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return { stdout, stderr };
}

/** An error shaped like the driver's, with the password in several places. */
function leakingError(): Error {
  return Object.assign(
    new Error(`password authentication failed for user "${S}"`, {
      cause: new Error(`while connecting to ${FIXTURE_DATABASE_URL}`),
    }),
    { code: '28P01', detail: `user ${S}` },
  );
}

const savedExitCode = process.exitCode;

beforeEach(() => {
  recordBootSecrets(secretValues(parseSettings(fixtureEnv)));
});

afterEach(() => {
  recordBootSecrets([]);
  process.exitCode = savedExitCode;
  vi.unstubAllEnvs();
});

describe('printBootFailure (the printer for the rejected bootstrap)', () => {
  it('writes the error to stderr with [REDACTED] for every secret form', async () => {
    const { stdout, stderr } = await captured(() =>
      printBootFailure(leakingError()),
    );

    expect(stdout).toBe('');
    expect(stderr).toContain('password authentication failed');
    expect(stderr).toContain('28P01');
    expect(stderr).toContain(`for user "${REDACTED}"`);
    expect(stderr).not.toContain(S);
    expect(stderr).not.toContain(FIXTURE_DATABASE_URL);
  });

  it('control: without recorded secrets the same text holds the password', async () => {
    recordBootSecrets([]);

    const { stderr } = await captured(() => printBootFailure(leakingError()));

    expect(stderr).toContain(S);
  });

  it('makes the process exit 1 and swallows nothing', async () => {
    process.exitCode = 0;

    const { stderr } = await captured(() => printBootFailure(new Error('x')));

    expect(process.exitCode).toBe(1);
    expect(stderr).toMatch(/Error: x/);
  });
});

describe("BootConsoleLogger (Nest's output before useLogger)", () => {
  it('scrubs an error message and its stack on stderr', async () => {
    const logger = new BootConsoleLogger();

    const { stderr } = await captured(() => logger.error(leakingError()));

    expect(stderr).toContain(REDACTED);
    expect(stderr).not.toContain(S);
  });

  it('scrubs a message with a separate stack argument', async () => {
    const logger = new BootConsoleLogger();

    const { stderr } = await captured(() =>
      logger.error(`failed: ${FIXTURE_DATABASE_URL}`, `Error: ${S}\n    at x`),
    );

    expect(stderr).toContain(`failed: ${REDACTED}`);
    expect(stderr).not.toContain(S);
  });

  it('scrubs plain log lines on stdout, buffered ones included', async () => {
    Logger.overrideLogger(new BootConsoleLogger());
    Logger.attachBuffer();
    new Logger('Probe').log(`buffered ${S}`);

    const { stdout } = await captured(() => Logger.flush());

    expect(stdout).toContain(`buffered ${REDACTED}`);
    expect(stdout).not.toContain(S);
    Logger.overrideLogger(false);
  });

  it('prints without colour codes', async () => {
    const { stdout } = await captured(() =>
      new BootConsoleLogger().log('plain'),
    );

    expect(stdout).toContain('plain');
    // eslint-disable-next-line no-control-regex
    expect(stdout).not.toMatch(/\u001b\[/);
  });
});

describe('a failed Nest boot prints no password on either path', () => {
  @Module({
    imports: [ConfigModule],
    providers: [
      {
        provide: 'FAILS',
        inject: [],
        useFactory: () => Promise.reject(leakingError()),
      },
    ],
  })
  class FailingModule {}

  it('scrubs the ExceptionHandler line, the flushed boot lines and the rethrown error', async () => {
    stubFixtureEnv();
    recordBootSecrets([]);
    let rejection: unknown;

    const output = await captured(async () => {
      rejection = await NestFactory.createApplicationContext(FailingModule, {
        abortOnError: false,
        bufferLogs: true,
        logger: new BootConsoleLogger(),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      printBootFailure(rejection);
    });
    Logger.overrideLogger(false);

    // Recorded by ConfigModule's single parse, not by the test.
    expect(bootSecrets()).toEqual(secretValues(parseSettings(fixtureEnv)));
    expect(rejection).toBeInstanceOf(Error);
    expect(String((rejection as Error).message)).toContain(S);
    expect(output.stderr).toMatch(/ExceptionHandler/);
    expect(output.stderr).toContain(`for user "${REDACTED}"`);
    expect(output.stdout + output.stderr).not.toContain(S);
    expect(output.stdout + output.stderr).not.toContain(FIXTURE_DATABASE_URL);
  });
});

describe('ConfigModule records the secret values from its one parse', () => {
  it('records secretValues(settings) when the settings parse', async () => {
    stubFixtureEnv();
    recordBootSecrets([]);

    const app = await NestFactory.createApplicationContext(ConfigModule, {
      logger: false,
    });
    await app.close();

    expect(bootSecrets()).toEqual(secretValues(parseSettings(fixtureEnv)));
  });

  it('records nothing when the settings are refused', async () => {
    stubFixtureEnv();
    vi.stubEnv('TRADER_MODE', 'testnet');
    recordBootSecrets([]);

    await expect(
      NestFactory.createApplicationContext(ConfigModule, {
        abortOnError: false,
        logger: false,
      }),
    ).rejects.toThrow('TRADER_MODE');
    expect(bootSecrets()).toEqual([]);
  });
});

describe('src/main.ts wires both printers', () => {
  const main = readAppFile('src/main.ts');

  it('passes BootConsoleLogger as the logger', () => {
    expect(main).toMatch(/logger:\s*new BootConsoleLogger\(\)/);
  });

  it('prints a rejected bootstrap through printBootFailure', () => {
    expect(main).toMatch(
      /await runWithCorrelation\(bootstrap\)\.catch\(printBootFailure\);/,
    );
  });

  it('src/config/boot-output.ts never reads the environment', () => {
    expect(readAppFile('src/config/boot-output.ts')).not.toContain(
      'process.env',
    );
  });
});
