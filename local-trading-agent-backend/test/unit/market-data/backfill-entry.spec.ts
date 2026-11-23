import { LoggerModule } from 'nestjs-pino';
import { BackfillModule } from '../../../src/backfill.module.js';
import { ConfigModule } from '../../../src/config/config.module.js';
import { DbModule } from '../../../src/db/db.module.js';
import { MarketDataModule } from '../../../src/market-data/market-data.module.js';
import { readAppFile, readPackageJson } from '../../fixtures/repo.js';

// S1b criterion 31 and the backfill wiring.

function moduleImports(target: object): unknown[] {
  const imports = Reflect.getMetadata('imports', target) as unknown[];
  return imports.map((entry) =>
    typeof entry === 'object' && entry !== null && 'module' in entry
      ? entry.module
      : entry,
  );
}

describe('the backfill script (criterion 31)', () => {
  const { scripts, dependencies, devDependencies } = readPackageJson();

  it('mirrors start:prod and loads ../.env', () => {
    expect(scripts.backfill).toBe('node --env-file=../.env dist/backfill.js');
    expect(scripts['start:prod']).toBe('node --env-file=../.env dist/main.js');
  });

  it('adds no dependency', () => {
    expect(Object.keys(dependencies).sort()).toEqual([
      '@nestjs/common',
      '@nestjs/core',
      'decimal.js',
      'drizzle-orm',
      'nestjs-pino',
      'pg',
      'pino',
      'pino-http',
      'reflect-metadata',
      'rxjs',
      'zod',
    ]);
    expect(Object.keys(devDependencies).sort()).toEqual([
      '@eslint/js',
      '@nestjs/cli',
      '@nestjs/schematics',
      '@nestjs/testing',
      '@types/node',
      '@types/pg',
      '@vitest/coverage-v8',
      'drizzle-kit',
      'eslint',
      'eslint-config-prettier',
      'fast-check',
      'prettier',
      'source-map-support',
      'typescript',
      'typescript-eslint',
      'vite',
      'vitest',
    ]);
  });
});

describe('the backfill wiring', () => {
  it('BackfillModule imports ConfigModule, LoggerModule, DbModule and MarketDataModule', () => {
    expect(moduleImports(BackfillModule)).toEqual([
      ConfigModule,
      LoggerModule,
      DbModule,
      MarketDataModule,
    ]);
  });

  it('builds its logger exactly as AppModule does', () => {
    const logger = (path: string): string => {
      const text = readAppFile(path);
      const start = text.indexOf('LoggerModule.forRootAsync(');
      return text.slice(start, text.indexOf('}),', start));
    };

    expect(logger('src/backfill.module.ts')).toBe(logger('src/app.module.ts'));
  });

  it('backfill.ts runs only as the entry point, and the dry run boots nothing', () => {
    const text = readAppFile('src/backfill.ts');

    expect(text).toContain('if (import.meta.main)');
    expect(text).toContain('runWithCorrelation');
    expect(text).toContain('printBootFailure');
    expect(text).toContain('new BootConsoleLogger()');
    const dryRun = text.slice(
      text.indexOf('if (args.dryRun)'),
      text.indexOf('let context'),
    );
    expect(dryRun).not.toMatch(/openContext|NestFactory|SETTINGS|DATABASE/);
  });
});
