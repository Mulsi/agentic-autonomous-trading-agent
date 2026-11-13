// A loopback stand-in for Postgres that gets a client through the startup and
// then misbehaves on its first query. It speaks just enough of the protocol:
// it answers an SSLRequest with `N`, and a startup message with
// AuthenticationOk and ReadyForQuery. No password is asked for.
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';

/**
 * `reset-on-query` resets the connection (TCP RST) when the first query
 * arrives, as a killed container would. `silent-on-query` accepts the query and
 * never answers, as a lock held on the table would.
 */
export type FakePostgresMode = 'reset-on-query' | 'silent-on-query';

export interface FakePostgres {
  port: number;
  /** A URL for it. The password is never checked. */
  url: string;
  connections: () => number;
  /** Connections that got as far as sending a query. */
  queries: () => number;
  close: () => Promise<void>;
}

const SSL_REQUEST = 80877103;
const AUTHENTICATION_OK = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]); // 'R'
const READY_FOR_QUERY = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]); // 'Z', idle

export async function fakePostgres(
  mode: FakePostgresMode,
): Promise<FakePostgres> {
  let connections = 0;
  let queries = 0;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));

    let pending = Buffer.alloc(0);
    let started = false;
    let queried = false;

    const onQuery = (): void => {
      if (queried) return;
      queried = true;
      queries += 1;
      if (mode === 'reset-on-query') socket.resetAndDestroy();
    };

    socket.on('data', (chunk: Buffer) => {
      if (started) {
        onQuery();
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 8) return;
      const length = pending.readInt32BE(0);
      if (pending.length < length) return;
      const code = pending.readInt32BE(4);
      const rest = pending.subarray(length);
      pending = Buffer.alloc(0);
      if (code === SSL_REQUEST) {
        socket.write('N');
        return;
      }
      started = true;
      socket.write(Buffer.concat([AUTHENTICATION_OK, READY_FOR_QUERY]));
      if (rest.length > 0) onQuery();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `postgresql://trader:unused@127.0.0.1:${port}/trader`,
    connections: () => connections,
    queries: () => queries,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
