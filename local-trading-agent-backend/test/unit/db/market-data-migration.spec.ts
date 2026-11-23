import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INTERVAL_MS } from '../../../src/market-data/normalizer.js';
import { STORED_QUARANTINE_REASONS } from '../../../src/market-data/quarantine-reasons.js';
import { appRoot, nonSpecSources, readAppFile } from '../../fixtures/repo.js';

// S1b criteria 28 and 29: server-filled times are timestamptz(3), and the CHECK
// lists in the migration match the code.

const MIGRATIONS = 'src/db/migrations';
const sqlFiles = readdirSync(join(appRoot, MIGRATIONS))
  .filter((name) => name.endsWith('.sql'))
  .sort();
/** Migrations after 0003, where the timestamptz(3) rule applies. */
const later = sqlFiles.filter((name) => Number(name.slice(0, 4)) > 3);
const MARKET_DATA = readAppFile(`${MIGRATIONS}/0004_market_data.sql`);

/** The quoted values of an `in (...)` list in a named CHECK constraint. */
function checkList(sql: string, constraint: string): string[] {
  const match = new RegExp(
    `CONSTRAINT "${constraint}" CHECK \\([^()]* in \\(([^)]*)\\)\\)`,
  ).exec(sql);
  if (match === null) throw new Error(`no check ${constraint}`);
  return [...(match[1] ?? '').matchAll(/'([^']*)'/g)].map(
    (value) => value[1] as string,
  );
}

describe('server-filled time is timestamptz(3) (criterion 28)', () => {
  it('has migrations after 0003 to check', () => {
    expect(later).toContain('0004_market_data.sql');
  });

  it.each(later)(
    '%s uses now() only as DEFAULT now() on a timestamp(0-3) with time zone column',
    (name) => {
      const sql = readAppFile(`${MIGRATIONS}/${name}`);
      const all = sql.match(/now\(\)/gi) ?? [];
      const allowed =
        sql.match(
          /^\t"\w+" timestamp ?\([0-3]\) with time zone DEFAULT now\(\)(?: NOT NULL)?,?$/gm,
        ) ?? [];

      expect(all.length).toBeGreaterThan(0);
      expect(allowed).toHaveLength(all.length);
      expect(sql).not.toMatch(/\b(?:TRIGGER|FUNCTION|PROCEDURE)\b/i);
    },
  );

  it('the market-data migration fills exactly three times on the server', () => {
    expect(MARKET_DATA.match(/DEFAULT now\(\)/g)).toHaveLength(3);
    for (const column of ['created_at', 'ingested_at', 'quarantined_at']) {
      expect(MARKET_DATA).toContain(
        `"${column}" timestamp (3) with time zone DEFAULT now() NOT NULL`,
      );
    }
  });

  it('a rule-breaking migration text would fail the check', () => {
    const bad = '\t"t" timestamp with time zone DEFAULT now() NOT NULL,';
    expect(
      bad.match(
        /^\t"\w+" timestamp ?\([0-3]\) with time zone DEFAULT now\(\)/m,
      ),
    ).toBeNull();
  });

  it('no non-spec source under src/ outside the migrations contains now()', () => {
    const offenders = nonSpecSources()
      .filter(
        ({ path, text }) =>
          !path.startsWith(`${MIGRATIONS}/`) && text.includes('now()'),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});

describe('the CHECK lists match the code (criterion 29)', () => {
  it('lists every stored quarantine reason, in order', () => {
    expect(checkList(MARKET_DATA, 'market_data_quarantine_reason')).toEqual([
      ...STORED_QUARANTINE_REASONS,
    ]);
  });

  it('the reasons are the validator reasons plus stored_conflict', () => {
    expect(STORED_QUARANTINE_REASONS).toContain('stored_conflict');
    expect(STORED_QUARANTINE_REASONS).toContain('outlier');
    expect(STORED_QUARANTINE_REASONS).toContain('malformed_row');
    expect(new Set(STORED_QUARANTINE_REASONS).size).toBe(
      STORED_QUARANTINE_REASONS.length,
    );
  });

  it('lists every KlineInterval as a timeframe', () => {
    expect(checkList(MARKET_DATA, 'candles_timeframe')).toEqual(
      Object.keys(INTERVAL_MS),
    );
  });
});
