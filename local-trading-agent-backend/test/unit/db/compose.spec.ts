import { parseEnv } from 'node:util';
import {
  isYamlMap,
  parseMakefile,
  parseYaml,
  type YamlMap,
  type YamlValue,
} from '../../fixtures/parsers.js';
import { readRepoFile } from '../../fixtures/repo.js';

const composeText = readRepoFile('docker-compose.yml');
const compose = parseYaml(composeText);

function asMap(value: YamlValue | undefined, what: string): YamlMap {
  if (!isYamlMap(value)) throw new Error(`${what} is not a map`);
  return value;
}

function asStrings(value: YamlValue | undefined, what: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${what} is not a list of strings`);
  }
  return value as string[];
}

const services = asMap(compose.services, 'services');
const [serviceName] = Object.keys(services);
const service = asMap(services[serviceName ?? ''], 'the service');

describe('docker-compose.yml', () => {
  it('defines exactly one service', () => {
    expect(Object.keys(services)).toHaveLength(1);
  });

  // `16`, or `16.` / `16-` followed by a minor version or a variant, then a
  // mandatory image index digest, so every checkout runs the same bytes.
  const PINNED_IMAGE =
    /^postgres:16(?:[.-][A-Za-z0-9][A-Za-z0-9.-]*)?@sha256:[0-9a-f]{64}$/;
  const HEX = '0123456789abcdef'.repeat(4);
  const DIGEST = `sha256:${HEX}`;

  it('runs postgres tagged on major version 16', () => {
    expect(service.image).toMatch(PINNED_IMAGE);
  });

  it('pins the image by digest', () => {
    expect(service.image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it.each([`postgres:16@${DIGEST}`, `postgres:16.15@${DIGEST}`])(
    'the image check accepts %s',
    (image) => {
      expect(image).toMatch(PINNED_IMAGE);
    },
  );

  it.each([
    'postgres',
    'postgres:latest',
    'postgres:17',
    'postgres:160',
    'postgres:16',
    'postgres:16.15',
    `postgres:17.6@${DIGEST}`,
    `postgres:16.15@sha256:${HEX.toUpperCase()}`,
    `postgres:16.15@sha256:${HEX.slice(0, -1)}`,
    `postgres:16.15@sha512:${HEX}`,
    `postgres@${DIGEST}`,
  ])('the image check rejects %s', (image) => {
    expect(image).not.toMatch(PINNED_IMAGE);
  });

  it('publishes its port on 127.0.0.1 only', () => {
    const ports = asStrings(service.ports, 'ports');

    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) {
      // HOST_IP:HOST_PORT:CONTAINER_PORT. A mapping without a host IP binds
      // every interface, and 0.0.0.0 or :: would too.
      expect(port).toMatch(/^127\.0\.0\.1:\d+:5432(?:\/tcp)?$/);
    }
  });

  it('has no other way to reach the network', () => {
    expect(service).not.toHaveProperty('network_mode');
    expect(service).not.toHaveProperty('expose');
    expect(service).not.toHaveProperty('networks');
  });

  it('keeps the data directory in a declared named volume', () => {
    const declared = Object.keys(asMap(compose.volumes, 'volumes'));
    const mounts = asStrings(service.volumes, 'service volumes');
    const data = mounts.find((mount) =>
      mount.endsWith(':/var/lib/postgresql/data'),
    );
    const source = data?.split(':')[0] ?? '';

    expect(data).toBeDefined();
    expect(source).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
    expect(declared).toContain(source);
  });

  it('has a pg_isready healthcheck', () => {
    const healthcheck = asMap(service.healthcheck, 'healthcheck');
    const test = healthcheck.test;
    const command = Array.isArray(test)
      ? asStrings(test, 'healthcheck test').join(' ')
      : test;

    expect(command).toContain('pg_isready');
  });

  it('runs the server in UTC', () => {
    expect(service.command).toMatch(/(^|\s)timezone=UTC(\s|$)/);
  });

  it('interpolates nothing and loads no env_file', () => {
    // `${` is the documented form; a bare `$` also interpolates, so none at all.
    expect(composeText).not.toContain('${');
    expect(composeText).not.toContain('$');
    expect(composeText).not.toMatch(/^\s*env_file\s*:/m);
  });

  it('sets only Postgres variables', () => {
    const environment = asMap(service.environment, 'environment');

    for (const key of Object.keys(environment)) {
      expect(key).toMatch(/^POSTGRES_/);
    }
  });
});

describe('the compose credentials', () => {
  const environment = asMap(service.environment, 'environment');
  const [hostPort] = asStrings(service.ports, 'ports').map(
    (port) => port.split(':')[1],
  );
  const expected = {
    user: environment.POSTGRES_USER,
    password: environment.POSTGRES_PASSWORD,
    database: environment.POSTGRES_DB,
    port: hostPort,
  };

  function partsOf(url: string): Record<string, string> {
    const parsed = new URL(url);
    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.slice(1)),
      port: parsed.port,
      host: parsed.hostname,
    };
  }

  it('are all set in the compose file', () => {
    for (const value of Object.values(expected)) {
      expect(value).toMatch(/^\S+$/);
    }
  });

  it('match the DATABASE_URL in .env.example', () => {
    const { DATABASE_URL } = parseEnv(readRepoFile('.env.example'));

    expect(partsOf(DATABASE_URL ?? '')).toEqual({
      ...expected,
      host: '127.0.0.1',
    });
  });

  it('match the URL that make db-up passes to pnpm db:migrate', () => {
    const { variables, recipes } = parseMakefile(readRepoFile('Makefile'));

    expect(partsOf(variables.DB_URL ?? '')).toEqual({
      ...expected,
      host: '127.0.0.1',
    });
    expect(recipes['db-up']).toContain(
      `DATABASE_URL='${variables.DB_URL}' pnpm db:migrate`,
    );
  });
});

// S0g: during S0f a pull of the digest-pinned image hung in Docker's credential
// helper. `--pull missing` does not help, because compose still pulls a pinned
// image whose local tag differs, so the recipe looks for the exact reference
// itself and passes `--pull never` only when Docker already has it.
describe('make db-up never pulls an image that is already local (S0g)', () => {
  const makefileText = readRepoFile('Makefile');
  const recipe = parseMakefile(makefileText).recipes['db-up'] ?? '';
  const READ =
    'docker compose --env-file /dev/null --file docker-compose.yml config --images';
  const NAME = '[A-Za-z_][A-Za-z0-9_]*';

  function escaped(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }

  function count(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  const readAt = recipe.indexOf(READ);
  const inspectAt = recipe.indexOf('docker image inspect');
  const segments = recipe.split(';').map((segment) => segment.trim());
  const upSegments = segments.filter((segment) =>
    /\bdocker compose\b.*\sup(\s|$)/.test(segment),
  );
  const upAt = upSegments[0] === undefined ? -1 : recipe.indexOf(upSegments[0]);

  /** The variable the read is assigned to, as `name=$$(read)`, quoted or not. */
  const variable =
    new RegExp(`(?:^|[\\s;])(${NAME})="?\\$\\$\\(${escaped(READ)}\\)`).exec(
      recipe,
    )?.[1] ?? '';

  /** The `if docker image inspect` on that variable, and its two branches. */
  const ifAt = recipe.indexOf(`if docker image inspect "$$${variable}"`);
  const thenAt = recipe.indexOf('then', ifAt);
  const elseAt = recipe.indexOf('else', thenAt);
  const fiAt = recipe.indexOf('fi;', elseAt);
  const thenBranch = recipe.slice(thenAt + 'then'.length, elseAt);
  const elseBranch = recipe.slice(elseAt + 'else'.length, fiAt);
  const array =
    new RegExp(`^\\s*(${NAME})=\\(--pull never\\)\\s*;\\s*$`).exec(
      thenBranch,
    )?.[1] ?? '';

  it('reads the image reference from compose exactly once', () => {
    expect(count(recipe, READ)).toBe(1);
  });

  it('assigns the read to a shell variable through a command substitution', () => {
    expect(variable).not.toBe('');
  });

  it('reads the image before docker image inspect and before up', () => {
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(inspectAt).toBeGreaterThan(readAt);
    expect(upAt).toBeGreaterThan(inspectAt);
  });

  it('stops with a db-up: message on stderr when the read fails', () => {
    const afterRead = recipe.slice(readAt + READ.length);

    expect(afterRead).toMatch(
      /^\)"?\s*\|\|\s*\{\s*echo\s+"db-up: [^"]*"\s*>&2\s*;\s*exit 1\s*;\s*\}\s*;/,
    );
  });

  it('stops with a db-up: message on stderr when the read is empty or not one word', () => {
    const guard = recipe.slice(readAt + READ.length, ifAt);

    expect(guard).toContain(`[ -z "$$${variable}" ]`);
    expect(guard).toContain(`[[ "$$${variable}" =~ [[:space:]] ]]`);
    expect(guard).toMatch(
      /then\s+echo\s+"db-up: [^"]*"\s*>&2\s*;\s*exit 1\s*;\s*fi\s*;\s*$/,
    );
  });

  it('has one if docker image inspect on that variable, quoted, output to /dev/null', () => {
    expect(count(recipe, 'docker image inspect')).toBe(1);
    expect(recipe).toMatch(
      new RegExp(
        `if docker image inspect "\\$\\$${variable}" >/dev/null 2>&1\\s*;\\s*then\\s`,
      ),
    );
  });

  it('passes --pull never only in the then branch of that if', () => {
    const neverAt = recipe.indexOf('--pull never');

    expect(count(recipe, '--pull never')).toBe(1);
    expect(ifAt).toBe(inspectAt - 'if '.length);
    expect(neverAt).toBeGreaterThan(thenAt);
    expect(neverAt).toBeLessThan(elseAt);
    expect(array).not.toBe('');
  });

  it('leaves the pull array empty in the else branch', () => {
    expect(elseBranch).not.toContain('--pull');
    expect(elseBranch).toMatch(new RegExp(`^\\s*${array}=\\(\\)\\s*;\\s*$`));
  });

  it('starts Postgres with one up command, with the flags it had before and the pull array', () => {
    expect(upSegments).toHaveLength(1);
    const up = upSegments[0] ?? '';

    for (const flag of [
      '--env-file /dev/null',
      '--file docker-compose.yml',
      '--detach',
      '--wait-timeout 120',
      `"$\${${array}[@]}"`,
    ]) {
      expect(up).toContain(flag);
    }
    expect(up).toMatch(/\s--wait\s/);
    expect(up).not.toContain('--pull');
  });

  it('never pulls explicitly, and passes no pull policy but never', () => {
    expect(recipe).not.toMatch(/docker\s+pull/);
    expect(recipe).not.toMatch(/compose\b[^;]*\spull\b/);
    expect(
      [...recipe.matchAll(/--pull[\s=]+([^\s);]+)/g)].map((match) => match[1]),
    ).toEqual(['never']);
  });

  it('passes --env-file /dev/null on every compose command', () => {
    const commands = [...recipe.matchAll(/docker compose\b[^;)]*/g)].map(
      (match) => match[0],
    );

    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toMatch(/^docker compose --env-file \/dev\/null /);
    }
  });

  it('says in the comment above db-up why a local image is never pulled', () => {
    const lines = makefileText.split('\n');
    const ruleAt = lines.findIndex((line) => line.startsWith('db-up:'));
    const comment: string[] = [];
    for (let at = ruleAt - 1; at >= 0 && lines[at]?.startsWith('#'); at -= 1) {
      comment.unshift(lines[at] ?? '');
    }
    const text = comment.join('\n');

    expect(ruleAt).toBeGreaterThan(0);
    expect(text).toContain('--pull never');
    expect(text).toMatch(/credential/i);
    expect(text).toContain('--pull missing');
  });
});
