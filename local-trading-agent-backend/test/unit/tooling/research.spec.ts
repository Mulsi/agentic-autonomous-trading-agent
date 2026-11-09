import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseMakefile, readTomlTable } from '../../fixtures/parsers.js';
import {
  appRoot,
  listRepoFiles,
  readAppFile,
  readPackageJson,
  readRepoFile,
  repoRoot,
} from '../../fixtures/repo.js';

const PYTHON_FILES = [
  /\.py$/,
  /\.ipynb$/,
  /^pyproject\.toml$/,
  /^uv\.lock$/,
  /^requirements.*\.txt$/,
  /^\.python-version$/,
];

/** Paths git tracks under a repo-relative folder. */
function tracked(folder: string): string[] {
  return execFileSync('git', ['ls-files', '--', folder], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('research/ skeleton', () => {
  const pyproject = readRepoFile('research/pyproject.toml');
  const project = readTomlTable(pyproject, 'project');

  it('has a [project] table', () => {
    expect(project).toBeDefined();
  });

  it('admits only Python 3.12', () => {
    // A closed set of spellings, each meaning >=3.12,<3.13 and nothing more.
    expect(['"==3.12.*"', '">=3.12,<3.13"', '"~=3.12.0"']).toContain(
      project?.['requires-python'],
    );
  });

  it('has no dependencies yet', () => {
    expect([undefined, '[]']).toContain(project?.dependencies);
    expect(pyproject).not.toMatch(/^\[(project\.)?optional-dependencies\]/m);
    expect(pyproject).not.toMatch(/^\[dependency-groups\]/m);
  });

  it('pins 3.12 in .python-version', () => {
    expect(readRepoFile('research/.python-version').trim()).toBe('3.12');
  });

  it('has a uv.lock', () => {
    expect(existsSync(join(repoRoot, 'research/uv.lock'))).toBe(true);
  });

  it.each(['research/notebooks', 'research/reports'])(
    '%s holds a tracked placeholder',
    (folder) => {
      expect(tracked(folder).length).toBeGreaterThan(0);
    },
  );

  it('ignores .venv, __pycache__ and .ipynb_checkpoints', () => {
    const ignore = readRepoFile('research/.gitignore')
      .split('\n')
      .map((line) => line.trim());

    expect(ignore).toEqual(
      expect.arrayContaining(['.venv/', '__pycache__/', '.ipynb_checkpoints/']),
    );
  });
});

describe('research/README.md', () => {
  const readme = readRepoFile('research/README.md');

  it.each([
    ['offline only', /offline only/i],
    ['reads from Postgres', /reads from Postgres/i],
    [
      'never writes to trading tables',
      /never writes to (the )?trading tables/i,
    ],
    ['never in the live decision path', /never in the live decision path/i],
    [
      'outputs affect trading only after the TypeScript replay reproduces them',
      /only after the TypeScript replay reproduces/i,
    ],
  ])('states: %s', (_, pattern) => {
    expect(readme).toMatch(pattern);
  });

  it('cites D13', () => {
    expect(readme).toContain('D13');
  });
});

describe('Python stays inside research/', () => {
  it('has no Python files anywhere else', () => {
    const offenders = listRepoFiles(['node_modules', '.git', '.worktrees'])
      .filter((path) => !path.startsWith('research/'))
      .filter((path) => PYTHON_FILES.some((re) => re.test(basename(path))));

    expect(offenders).toEqual([]);
  });

  it('the check catches each kind of file', () => {
    const samples = [
      'a.py',
      'b.ipynb',
      'pyproject.toml',
      'uv.lock',
      'requirements-dev.txt',
      '.python-version',
    ];

    for (const sample of samples) {
      expect(PYTHON_FILES.some((re) => re.test(sample))).toBe(true);
    }
  });
});

describe('the TypeScript toolchain ignores research/', () => {
  const mentions = /research|\buv\b|python/i;

  it('no package.json script mentions research, uv or python', () => {
    for (const command of Object.values(readPackageJson().scripts)) {
      expect(command).not.toMatch(mentions);
    }
  });

  it.each(['test', 'lint', 'typecheck', 'db-up'])(
    'the Makefile %s recipe does not mention them',
    (target) => {
      const { recipes } = parseMakefile(readRepoFile('Makefile'));

      expect(recipes[target]).toBeDefined();
      expect(recipes[target]).not.toMatch(mentions);
    },
  );

  it('no tsconfig, ESLint or vitest config refers to research', () => {
    const configs = readdirSync(appRoot).filter((name) =>
      /^(tsconfig.*\.json|eslint\.config\.mjs|vitest\.config.*\.ts)$/.test(
        name,
      ),
    );

    expect(configs).toEqual(
      expect.arrayContaining([
        'tsconfig.json',
        'eslint.config.mjs',
        'vitest.config.ts',
        'vitest.config.e2e.ts',
        'vitest.config.db.ts',
      ]),
    );
    for (const name of configs) {
      expect(readAppFile(name)).not.toMatch(/research/i);
    }
  });
});
