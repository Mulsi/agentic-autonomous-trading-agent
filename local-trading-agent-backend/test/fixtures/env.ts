// Fixture values only. Tests pass these explicitly and never read a real .env.

/**
 * Settings never load `ANTHROPIC_API_KEY` (D9). The parent environment may
 * still hold one (§9), so tests use this sentinel to prove it is dropped and
 * never logged.
 */
export const FIXTURE_API_KEY = 'fixture-anthropic-key-sentinel-7f3a';
export const FIXTURE_DB_PASSWORD = 'fixture-db-password-sentinel-91bc';
export const FIXTURE_DATABASE_URL = `postgresql://trader:${FIXTURE_DB_PASSWORD}@localhost:5432/trader`;

export const fixtureEnv = {
  DATABASE_URL: FIXTURE_DATABASE_URL,
  TRADER_MODE: 'paper',
} as const;

/**
 * Values that make `new URL` throw, each with `FIXTURE_DB_PASSWORD` as the
 * password. Node's `ERR_INVALID_URL` carries the whole input, so these prove
 * that no parse error leaks the password.
 */
export const UNPARSEABLE_DATABASE_URLS = [
  [
    'a port out of range',
    `postgresql://trader:${FIXTURE_DB_PASSWORD}@localhost:99999/trader`,
  ],
  [
    'an unclosed IPv6 bracket',
    `postgresql://trader:${FIXTURE_DB_PASSWORD}@[::1/trader`,
  ],
  [
    'a space in the host',
    `postgresql://trader:${FIXTURE_DB_PASSWORD}@bad host/trader`,
  ],
] as const;

/**
 * Sets the two variables on `process.env` and unsets `ANTHROPIC_API_KEY`, which
 * the shell running the tests may hold. Pair with `vi.unstubAllEnvs()`.
 */
export function stubFixtureEnv(): void {
  for (const [key, value] of Object.entries(fixtureEnv)) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv('ANTHROPIC_API_KEY', undefined);
}
