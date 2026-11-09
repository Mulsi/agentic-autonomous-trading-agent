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

  it('runs postgres tagged on major version 16', () => {
    // `16`, or `16.` / `16-` followed by a minor version or a variant.
    expect(service.image).toMatch(
      /^postgres:16(?:[.-][A-Za-z0-9][A-Za-z0-9.-]*)?(?:@sha256:[0-9a-f]{64})?$/,
    );
  });

  it.each(['postgres', 'postgres:latest', 'postgres:17', 'postgres:160'])(
    'the image check rejects %s',
    (image) => {
      expect(image).not.toMatch(
        /^postgres:16(?:[.-][A-Za-z0-9][A-Za-z0-9.-]*)?(?:@sha256:[0-9a-f]{64})?$/,
      );
    },
  );

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
