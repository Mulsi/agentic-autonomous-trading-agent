import {
  parseMakefile,
  parseYaml,
  readTomlTable,
} from '../../fixtures/parsers.js';

// The compose, Makefile and pyproject checks rely on these readers, so they
// must read the plain subset correctly and refuse everything else.

describe('parseYaml', () => {
  it('reads nested maps, lists and quoted scalars', () => {
    const text = [
      '# comment',
      'services:',
      '  db:',
      '    image: postgres:16',
      '    ports:',
      '      - "127.0.0.1:1:2"',
      "      - '3:4'",
      'volumes:',
      '  data:',
    ].join('\n');

    expect(parseYaml(text)).toEqual({
      services: {
        db: { image: 'postgres:16', ports: ['127.0.0.1:1:2', '3:4'] },
      },
      volumes: { data: null },
    });
  });

  it.each([
    ['a flow list', 'ports: ["1:2"]'],
    ['a flow map', 'environment: { A: b }'],
    ['an anchor', 'image: &img postgres:16'],
    ['an alias', 'image: *img'],
    ['a block scalar', 'command: |'],
    ['a tag', 'port: !!str 1'],
    ['a merge key', '<<: x'],
    ['a map inside a list', 'ports:\n  - target: 5432'],
    ['a duplicate key', 'a: 1\na: 2'],
    ['a tab indent', 'a:\n\tb: 1'],
    ['an inline comment', 'a: b # c'],
    ['a stray indent', 'a: 1\n  b: 2'],
  ])('refuses %s', (_, text) => {
    expect(() => parseYaml(text)).toThrow();
  });
});

describe('readTomlTable', () => {
  const text = [
    '# comment',
    '[project]',
    'name = "x"',
    'dependencies = []',
    '',
    '[tool.uv]',
    'package = false',
  ].join('\n');

  it('reads one table', () => {
    expect(readTomlTable(text, 'project')).toEqual({
      name: '"x"',
      dependencies: '[]',
    });
  });

  it('returns undefined for a missing table', () => {
    expect(readTomlTable(text, 'missing')).toBeUndefined();
  });

  it('refuses a multi-line array', () => {
    expect(() =>
      readTomlTable('[project]\ndependencies = [\n  "a",\n]', 'project'),
    ).toThrow();
  });
});

describe('parseMakefile', () => {
  const text = [
    'A := one',
    'B := two',
    '.PHONY: x y',
    '',
    'x y:',
    '\techo $(A) $@',
    '',
    '# comment',
    'z:',
    '\tfirst \\',
    '\tsecond $(B)',
  ].join('\n');

  it('reads variables and expands them into each recipe', () => {
    const { variables, recipes } = parseMakefile(text);

    expect(variables).toEqual({ A: 'one', B: 'two' });
    expect(recipes.x).toBe('echo one $@');
    expect(recipes.y).toBe('echo one $@');
    expect(recipes.z).toMatch(/^first\s+second two$/);
  });

  it('refuses a reference to an unknown variable', () => {
    expect(() => parseMakefile('x:\n\techo $(NOPE)')).toThrow();
  });
});
