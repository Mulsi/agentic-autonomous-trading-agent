// Small, strict readers for the committed config files the tests check. Each
// one accepts only the plain subset those files use and throws on anything
// else, so an unexpected edit fails a test instead of being misread.

export type YamlValue = string | null | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

interface Line {
  number: number;
  indent: number;
  text: string;
}

/**
 * Block-style YAML: nested maps with plain or simply quoted keys, lists of
 * scalars, plain or quoted scalars and full-line comments. Flow collections, anchors, aliases, block scalars, tags,
 * merge keys, tabs and maps inside lists all throw.
 */
export function parseYaml(source: string): YamlMap {
  const lines: Line[] = [];
  source.split('\n').forEach((raw, index) => {
    const number = index + 1;
    if (raw.trim() === '' || raw.trim().startsWith('#')) return;
    if (/^\s*\t/.test(raw)) throw new Error(`yaml line ${number}: tab indent`);
    const text = raw.trimEnd();
    const indent = text.length - text.trimStart().length;
    lines.push({ number, indent, text: text.trimStart() });
  });

  let next = 0;
  const peek = (): Line | undefined => lines[next];

  const parseBlock = (indent: number): YamlMap | YamlValue[] =>
    peek()?.text.startsWith('- ') ? parseList(indent) : parseMap(indent);

  const parseMap = (indent: number): YamlMap => {
    const map: YamlMap = {};
    for (let line = peek(); line && line.indent >= indent; line = peek()) {
      if (line.indent !== indent || line.text.startsWith('- ')) {
        throw new Error(`yaml line ${line.number}: unexpected indent`);
      }
      // A plain key, or a quoted one with no quote or backslash inside it.
      const match =
        /^(?:([A-Za-z0-9_.-]+)|'([^'\\]+)'|"([^"\\]+)"):(?: (.*))?$/.exec(
          line.text,
        );
      const key = match?.[1] ?? match?.[2] ?? match?.[3];
      if (key === undefined) {
        throw new Error(`yaml line ${line.number}: not a key`);
      }
      if (key in map) throw new Error(`yaml line ${line.number}: duplicate`);
      next += 1;
      const rest = match?.[4]?.trim() ?? '';
      if (rest !== '') {
        map[key] = parseScalar(rest, line.number);
      } else {
        const child = peek();
        map[key] =
          child && child.indent > indent ? parseBlock(child.indent) : null;
      }
    }
    return map;
  };

  const parseList = (indent: number): YamlValue[] => {
    const list: YamlValue[] = [];
    for (let line = peek(); line && line.indent >= indent; line = peek()) {
      if (line.indent !== indent || !line.text.startsWith('- ')) {
        throw new Error(`yaml line ${line.number}: unexpected list item`);
      }
      const item = line.text.slice(2).trim();
      if (/^[A-Za-z0-9_.-]+:( |$)/.test(item)) {
        throw new Error(`yaml line ${line.number}: map inside a list`);
      }
      list.push(parseScalar(item, line.number));
      next += 1;
    }
    return list;
  };

  const first = peek();
  const root = first ? parseMap(first.indent) : {};
  const leftover = peek();
  if (first?.indent !== 0 || leftover) {
    throw new Error(`yaml line ${(leftover ?? first)?.number}: bad structure`);
  }
  return root;
}

function parseScalar(raw: string, number: number): string {
  if (/^[[{&*|>!%@`]/.test(raw) || raw.startsWith('<<')) {
    throw new Error(`yaml line ${number}: unsupported value ${raw}`);
  }
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0];
    if (raw.length < 2 || !raw.endsWith(quote ?? '') || raw.includes('\\')) {
      throw new Error(`yaml line ${number}: unsupported quoting`);
    }
    return raw.slice(1, -1);
  }
  if (raw.includes(' #')) {
    throw new Error(`yaml line ${number}: inline comment`);
  }
  return raw;
}

export function isYamlMap(value: YamlValue | undefined): value is YamlMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One TOML table as `key -> raw value text`. Only single-line `key = value`
 * pairs are allowed inside it.
 */
export function readTomlTable(
  source: string,
  table: string,
): Record<string, string> | undefined {
  let inTable = false;
  let found = false;
  const pairs: Record<string, string> = {};
  for (const [index, raw] of source.split('\n').entries()) {
    const text = raw.trim();
    if (text === '' || text.startsWith('#')) continue;
    if (text.startsWith('[')) {
      inTable = text === `[${table}]`;
      found ||= inTable;
      continue;
    }
    if (!inTable) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(text);
    if (!match?.[1] || match[2] === undefined) {
      throw new Error(`toml line ${index + 1}: not a single-line pair`);
    }
    if (/^[[{]/.test(match[2]) && !/^(\[.*\]|\{.*\})$/.test(match[2])) {
      throw new Error(`toml line ${index + 1}: multi-line value`);
    }
    pairs[match[1]] = match[2];
  }
  return found ? pairs : undefined;
}

export interface Makefile {
  /** `NAME := value` assignments. */
  variables: Record<string, string>;
  /** Recipe text per target, with `$(NAME)` references expanded. */
  recipes: Record<string, string>;
}

/** Simple assignments and rules only; continuation lines are joined. */
export function parseMakefile(source: string): Makefile {
  const variables: Record<string, string> = {};
  const raw: Record<string, string[]> = {};
  let current: string[] = [];
  const lines = source.replace(/\\\n/g, ' ').split('\n');
  for (const line of lines) {
    if (line.startsWith('\t')) {
      current.push(line.slice(1));
      continue;
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const assignment = /^([A-Z_]+)\s*:=\s*(.*)$/.exec(line);
    if (assignment?.[1] && assignment[2] !== undefined) {
      variables[assignment[1]] = assignment[2].trim();
      current = [];
      continue;
    }
    const rule = /^([^:=]+):(?!=)(.*)$/.exec(line);
    if (!rule?.[1]) throw new Error(`Makefile: unsupported line ${line}`);
    current = [];
    for (const target of rule[1].trim().split(/\s+/)) {
      if (target.startsWith('.')) continue;
      raw[target] = current;
    }
  }
  const expand = (text: string): string =>
    text.replace(/\$\(([A-Z_]+)\)/g, (whole, name: string) => {
      const value = variables[name];
      if (value === undefined) throw new Error(`Makefile: no ${name}`);
      return value;
    });
  const recipes = Object.fromEntries(
    Object.entries(raw).map(([target, body]) => [
      target,
      expand(body.join('\n')),
    ]),
  );
  return { variables, recipes };
}
