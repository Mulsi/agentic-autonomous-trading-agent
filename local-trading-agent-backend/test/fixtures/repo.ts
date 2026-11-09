import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const appRoot = resolve(import.meta.dirname, '../..');
export const repoRoot = resolve(appRoot, '..');

export function readAppFile(path: string): string {
  return readFileSync(join(appRoot, path), 'utf8');
}

export function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

interface PackageJson {
  engines?: Record<string, string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export function readPackageJson(): PackageJson {
  return JSON.parse(readAppFile('package.json')) as PackageJson;
}

/** Every file under an app-relative directory, as app-relative paths. */
export function listAppFiles(dir: string): string[] {
  return readdirSync(join(appRoot, dir), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(appRoot, join(entry.parentPath, entry.name)));
}

/**
 * Every file in the repo, as repo-relative paths. Directories named in `skip`
 * are not entered at any depth. Only names are listed: nothing is read.
 */
export function listRepoFiles(skip: readonly string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.includes(entry.name)) walk(path);
      } else {
        files.push(relative(repoRoot, path));
      }
    }
  };
  walk(repoRoot);
  return files;
}

export function isSpecFile(path: string): boolean {
  return (
    path.endsWith('.spec.ts') ||
    path.endsWith('.e2e-spec.ts') ||
    path.endsWith('.db-spec.ts')
  );
}

/** Non-spec files in `src/`, with their contents. */
export function nonSpecSources(): { path: string; text: string }[] {
  return listAppFiles('src')
    .filter((path) => !isSpecFile(path))
    .map((path) => ({ path, text: readAppFile(path) }));
}
