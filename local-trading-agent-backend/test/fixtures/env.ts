// Fixture values only. Tests pass these explicitly and never read a real .env.
export const FIXTURE_API_KEY = 'fixture-anthropic-key-sentinel-7f3a';
export const FIXTURE_DB_PASSWORD = 'fixture-db-password-sentinel-91bc';
export const FIXTURE_DATABASE_URL = `postgresql://trader:${FIXTURE_DB_PASSWORD}@localhost:5432/trader`;

export const fixtureEnv = {
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  DATABASE_URL: FIXTURE_DATABASE_URL,
  TRADER_MODE: 'paper',
} as const;

/** Sets the three variables on `process.env`. Pair with `vi.unstubAllEnvs()`. */
export function stubFixtureEnv(): void {
  for (const [key, value] of Object.entries(fixtureEnv)) {
    vi.stubEnv(key, value);
  }
}
