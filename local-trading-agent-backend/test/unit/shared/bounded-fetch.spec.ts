import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { BINANCE_VISION_ORIGIN } from '../../../src/market-data/binance-vision.js';
import {
  isSpotDataUrl,
  visionHttpGet,
} from '../../../src/market-data/vision-http.js';
import { boundedGet } from '../../../src/shared/bounded-fetch.js';
import { nonSpecSources } from '../../fixtures/repo.js';

// S1b criterion 11, against a loopback server built here. Nothing leaves the
// machine.

const MAX = 1000;

interface Seen {
  method: string | undefined;
  url: string | undefined;
  /** True when the connection closed before the response finished. */
  closedEarly: Promise<boolean>;
}

let server: Server;
let base: string;
const seen: Seen[] = [];

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  mark: { closed: Promise<void> },
) => void;

const handlers = new Map<string, Handler>();

beforeAll(async () => {
  server = createServer((request, response) => {
    const closed = new Promise<void>((resolve) => {
      response.on('close', () => resolve());
    });
    let resolveEarly: (value: boolean) => void = () => undefined;
    const closedEarly = new Promise<boolean>((resolve) => {
      resolveEarly = resolve;
    });
    seen.push({ method: request.method, url: request.url, closedEarly });
    const handler = handlers.get(request.url ?? '');
    if (handler === undefined) {
      response.writeHead(500).end();
      resolveEarly(false);
      return;
    }
    response.on('close', () => resolveEarly(!response.writableFinished));
    handler(request, response, { closed });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  handlers.set('/exact', (_, response) => {
    response.writeHead(200, { 'content-length': String(MAX) });
    response.end(Buffer.alloc(MAX, 7));
  });
  handlers.set('/declared-too-large', (_, response, { closed }) => {
    response.writeHead(200, { 'content-length': String(MAX + 1) });
    response.flushHeaders();
    // The body would follow only if the client were still listening.
    const timer = setTimeout(() => response.end(Buffer.alloc(MAX + 1)), 2000);
    void closed.then(() => clearTimeout(timer));
  });
  handlers.set('/chunked-too-large', (_, response, { closed }) => {
    response.writeHead(200);
    let sent = 0;
    const timer = setInterval(() => {
      response.write(Buffer.alloc(300, 1));
      sent += 300;
      if (sent > 20 * MAX) {
        clearInterval(timer);
        response.end();
      }
    }, 5);
    void closed.then(() => clearInterval(timer));
  });
  handlers.set('/redirect-301', (_, response) => {
    response.writeHead(301, { location: '/target' }).end();
  });
  handlers.set('/redirect-302', (_, response) => {
    response.writeHead(302, { location: '/target' }).end();
  });
  handlers.set('/target', (_, response) => {
    response.writeHead(200).end('target');
  });
  handlers.set('/silent', () => undefined);
  handlers.set('/missing', (_, response) => {
    response.writeHead(404).end('not found body');
  });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

describe('boundedGet (criterion 11)', () => {
  it('returns a body of exactly maxBytes', async () => {
    const result = await boundedGet(`${base}/exact`, {
      maxBytes: MAX,
      timeoutMs: 5000,
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      body: new Uint8Array(Buffer.alloc(MAX, 7)),
    });
  });

  it('refuses a Content-Length of maxBytes + 1 before the body is sent', async () => {
    const result = await boundedGet(`${base}/declared-too-large`, {
      maxBytes: MAX,
      timeoutMs: 5000,
    });

    expect(result).toEqual({ ok: false, reason: 'too_large' });
    expect(await seen[0]?.closedEarly).toBe(true);
  });

  it('stops reading a chunked body that passes maxBytes', async () => {
    const result = await boundedGet(`${base}/chunked-too-large`, {
      maxBytes: MAX,
      timeoutMs: 5000,
    });

    expect(result).toEqual({ ok: false, reason: 'too_large' });
    // The server was still sending when the client hung up.
    expect(await seen[0]?.closedEarly).toBe(true);
  });

  it.each(['/redirect-301', '/redirect-302'])(
    'gives redirect for %s and never requests the target',
    async (path) => {
      const result = await boundedGet(`${base}${path}`, {
        maxBytes: MAX,
        timeoutMs: 5000,
      });

      expect(result).toEqual({ ok: false, reason: 'redirect' });
      expect(seen.map((request) => request.url)).toEqual([path]);
    },
  );

  it('gives timeout for a server that never answers, within timeoutMs plus a margin', async () => {
    const started = performance.now();
    const result = await boundedGet(`${base}/silent`, {
      maxBytes: MAX,
      timeoutMs: 300,
    });
    const elapsed = performance.now() - started;

    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(300 + 1500);
  });

  it('returns a 404 with an empty body', async () => {
    const result = await boundedGet(`${base}/missing`, {
      maxBytes: MAX,
      timeoutMs: 5000,
    });

    expect(result).toEqual({ ok: true, status: 404, body: new Uint8Array(0) });
  });

  it('gives network when nothing listens', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    expect(
      await boundedGet(`http://127.0.0.1:${port}/`, {
        maxBytes: MAX,
        timeoutMs: 5000,
      }),
    ).toEqual({ ok: false, reason: 'network' });
  });

  it('sends only GET requests', async () => {
    for (const path of ['/exact', '/missing', '/redirect-302']) {
      await boundedGet(`${base}${path}`, { maxBytes: MAX, timeoutMs: 5000 });
    }

    expect(seen.length).toBe(3);
    expect(seen.every((request) => request.method === 'GET')).toBe(true);
  });

  it('refuses bad limits as a programmer error', async () => {
    await expect(
      boundedGet(`${base}/exact`, { maxBytes: -1, timeoutMs: 5000 }),
    ).rejects.toThrow(RangeError);
    await expect(
      boundedGet(`${base}/exact`, { maxBytes: MAX, timeoutMs: 0 }),
    ).rejects.toThrow(RangeError);
    expect(seen).toEqual([]);
  });
});

describe('fetch( stays in bounded-fetch.ts (criterion 11)', () => {
  it('no other non-spec source under src/ contains fetch(', () => {
    const files = nonSpecSources()
      .filter(({ text }) => text.includes('fetch('))
      .map(({ path }) => path);

    expect(files).toEqual(['src/shared/bounded-fetch.ts']);
  });
});

describe('the production HttpGet (criterion 11)', () => {
  const limits = { maxBytes: MAX, timeoutMs: 5000 };

  it.each([
    'http://127.0.0.1:1/data/spot/daily/x.zip',
    `${BINANCE_VISION_ORIGIN}/data/futures/um/daily/x.zip`,
    `${BINANCE_VISION_ORIGIN}/data/spot`,
    `${BINANCE_VISION_ORIGIN}/data/spot/../futures/x.zip`,
    `${BINANCE_VISION_ORIGIN}/data/spot/daily/%2e%2e/x.zip`,
    `${BINANCE_VISION_ORIGIN}/data/spot/daily/x.zip?redirect=1`,
    `${BINANCE_VISION_ORIGIN}/data/spot/daily/x.zip#frag`,
    `${BINANCE_VISION_ORIGIN}/data/spot//x.zip`,
    `${BINANCE_VISION_ORIGIN}.evil.example/data/spot/x.zip`,
    `${BINANCE_VISION_ORIGIN}@evil.example/data/spot/x.zip`,
  ])('refuses %s without calling fetch', async (url) => {
    const get = vi.fn(boundedGet);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(visionHttpGet(get).get(url, limits)).rejects.toThrow(
        RangeError,
      );
      expect(get).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(isSpotDataUrl(url)).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('passes a spot bulk-data URL to boundedGet', async () => {
    const url = `${BINANCE_VISION_ORIGIN}/data/spot/daily/klines/BTCUSDT/15m/BTCUSDT-15m-2026-10-01.zip`;
    const get = vi.fn(() =>
      Promise.resolve({ ok: false as const, reason: 'network' as const }),
    );

    expect(await visionHttpGet(get).get(url, limits)).toEqual({
      ok: false,
      reason: 'network',
    });
    expect(get).toHaveBeenCalledWith(url, limits);
  });
});
