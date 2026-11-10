// A reader for the parts of pnpm-lock.yaml (lockfile v9) that the dependency
// checks need. It reads the committed text only and throws on a line it does
// not expect, so a format change fails a test instead of being misread.
import { readAppFile } from './repo.js';

export interface LockedPackage {
  /** The key as written, without quotes: `name@version`, plus peer suffixes in `snapshots`. */
  key: string;
  name: string;
  /** The version without peer suffixes. */
  version: string;
}

export interface Snapshot extends LockedPackage {
  /** `dependencies` and `optionalDependencies`, name to version without peer suffixes. */
  dependencies: Record<string, string>;
}

export function readLockfile(): string {
  return readAppFile('pnpm-lock.yaml');
}

/** The lines of one top-level section, without its heading. */
export function lockfileSection(name: string, lock = readLockfile()): string[] {
  const lines = lock.split('\n');
  const start = lines.indexOf(`${name}:`);
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return body;
}

function unquote(text: string): string {
  return /^'.*'$/.test(text) ? text.slice(1, -1) : text;
}

function withoutPeers(version: string): string {
  return version.replace(/\(.*$/, '');
}

function splitKey(key: string): LockedPackage {
  const at = key.indexOf('@', 1);
  if (at === -1) throw new Error(`pnpm-lock.yaml: no version in ${key}`);
  return {
    key,
    name: key.slice(0, at),
    version: withoutPeers(key.slice(at + 1)),
  };
}

/** The entry keys of a section, one per line indented by two spaces. */
function entryKeys(lines: readonly string[]): string[] {
  return lines
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => {
      const match = /^ {2}(.+?):(?: \{\})?$/.exec(line);
      if (!match?.[1]) throw new Error(`pnpm-lock.yaml: not a key: ${line}`);
      return unquote(match[1]);
    });
}

/** Every entry under `packages:`. */
export function lockedPackages(lock = readLockfile()): LockedPackage[] {
  return entryKeys(lockfileSection('packages', lock)).map(splitKey);
}

/** Every entry under `snapshots:`, with its resolved dependencies. */
export function lockedSnapshots(lock = readLockfile()): Snapshot[] {
  const snapshots: Snapshot[] = [];
  let current: Snapshot | undefined;
  let inDependencies = false;
  for (const line of lockfileSection('snapshots', lock)) {
    if (line.trim() === '') continue;
    if (/^ {2}\S/.test(line)) {
      const [key = ''] = entryKeys([line]);
      current = { ...splitKey(key), dependencies: {} };
      snapshots.push(current);
      inDependencies = false;
    } else if (/^ {4}\S/.test(line)) {
      inDependencies = /^ {4}(dependencies|optionalDependencies):$/.test(line);
    } else if (/^ {6}\S/.test(line) && inDependencies && current) {
      const match = /^ {6}(.+?): (\S+)$/.exec(line);
      if (!match?.[1] || !match[2]) {
        throw new Error(`pnpm-lock.yaml: not a dependency: ${line}`);
      }
      current.dependencies[unquote(match[1])] = withoutPeers(match[2]);
    }
  }
  return snapshots;
}

/** The top-level `overrides:` block, selector to range. */
export function lockedOverrides(lock = readLockfile()): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const line of lockfileSection('overrides', lock)) {
    if (line.trim() === '') continue;
    const match = /^ {2}(.+?): (\S+)$/.exec(line);
    if (!match?.[1] || !match[2]) {
      throw new Error(`pnpm-lock.yaml: not an override: ${line}`);
    }
    overrides[unquote(match[1])] = unquote(match[2]);
  }
  return overrides;
}

/** The version pnpm-lock.yaml records for a direct dependency of the app. */
export function lockedVersion(
  name: string,
  lock = readLockfile(),
): string | undefined {
  const lines = lockfileSection('importers', lock);
  const quoted = name.startsWith('@') ? `'${name}'` : name;
  const at = lines.indexOf(`      ${quoted}:`);
  const version = at === -1 ? undefined : lines[at + 2];
  const match = /^ {8}version: (\S+)$/.exec(version ?? '');
  return match?.[1] === undefined ? undefined : withoutPeers(match[1]);
}

/** `[major, minor, patch]` of a plain `x.y.z` version. */
export function versionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not a plain x.y.z version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative, zero or positive, like a sort comparator. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i += 1) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
