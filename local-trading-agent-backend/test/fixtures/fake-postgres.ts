// A loopback stand-in for Postgres that gets a client through the startup and
// then misbehaves on its first query, or answers it with something a real
// marker table never holds. It speaks just enough of the protocol:
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
 * never answers, as a lock held on the table would. `error-on-query` answers
 * with an ErrorResponse carrying `sqlstate` and `message`. `row-on-query`
 * answers with one column named `marker` of type `oid` and one DataRow holding
 * `value` as text, or NULL when `value` is null.
 */
export type FakePostgresMode =
  | 'reset-on-query'
  | 'silent-on-query'
  | { kind: 'error-on-query'; sqlstate: string; message: string }
  | { kind: 'row-on-query'; oid: number; value: string | null };

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
const PARSE_COMPLETE = Buffer.from([0x31, 0, 0, 0, 4]); // '1'
const BIND_COMPLETE = Buffer.from([0x32, 0, 0, 0, 4]); // '2'

/** A backend message: its type byte, then a length that counts itself. */
function message(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function cstring(text: string): Buffer {
  return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
}

/** ErrorResponse: severity, code and message fields, then a terminator. */
function errorResponse(sqlstate: string, text: string): Buffer {
  return message(
    'E',
    Buffer.concat([
      Buffer.from('S'),
      cstring('ERROR'),
      Buffer.from('V'),
      cstring('ERROR'),
      Buffer.from('C'),
      cstring(sqlstate),
      Buffer.from('M'),
      cstring(text),
      Buffer.from([0]),
    ]),
  );
}

/** RowDescription with one text-format column `marker` of type `oid`. */
function rowDescription(oid: number): Buffer {
  const field = Buffer.alloc(18);
  field.writeInt32BE(0, 0); // table OID
  field.writeInt16BE(0, 4); // column number
  field.writeInt32BE(oid, 6); // type OID
  field.writeInt16BE(-1, 10); // type size
  field.writeInt32BE(-1, 12); // type modifier
  field.writeInt16BE(0, 16); // text format
  const count = Buffer.alloc(2);
  count.writeInt16BE(1, 0);
  return message('T', Buffer.concat([count, cstring('marker'), field]));
}

/** DataRow with one column: the value as text, or NULL. */
function dataRow(value: string | null): Buffer {
  const count = Buffer.alloc(2);
  count.writeInt16BE(1, 0);
  const length = Buffer.alloc(4);
  if (value === null) {
    length.writeInt32BE(-1, 0);
    return message('D', Buffer.concat([count, length]));
  }
  const bytes = Buffer.from(value, 'utf8');
  length.writeInt32BE(bytes.length, 0);
  return message('D', Buffer.concat([count, length, bytes]));
}

/**
 * The answer to the first query. `extended` is true when the client sent
 * Parse (`P`), as pg does for a query with parameters, rather than Query (`Q`).
 */
function answer(mode: FakePostgresMode, extended: boolean): Buffer | undefined {
  if (typeof mode === 'string') return undefined;
  const prefix = extended ? [PARSE_COMPLETE, BIND_COMPLETE] : [];
  if (mode.kind === 'error-on-query') {
    return Buffer.concat([
      errorResponse(mode.sqlstate, mode.message),
      READY_FOR_QUERY,
    ]);
  }
  return Buffer.concat([
    ...prefix,
    rowDescription(mode.oid),
    dataRow(mode.value),
    message('C', cstring('SELECT 1')),
    READY_FOR_QUERY,
  ]);
}

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

    const onQuery = (first: Buffer): void => {
      if (queried) return;
      queried = true;
      queries += 1;
      if (mode === 'reset-on-query') {
        socket.resetAndDestroy();
        return;
      }
      const reply = answer(mode, first[0] === 0x50); // 'P'
      if (reply !== undefined) socket.write(reply);
    };

    socket.on('data', (chunk: Buffer) => {
      if (started) {
        onQuery(chunk);
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
      if (rest.length > 0) onQuery(rest);
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
