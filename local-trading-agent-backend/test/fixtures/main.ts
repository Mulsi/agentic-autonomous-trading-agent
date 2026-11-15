// Runs the built app (or node with other arguments) as a child process, for
// the e2e suites. The env is always explicit, so nothing real can leak in.
import { spawn } from 'node:child_process';
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { appRoot } from './repo.js';

export const EXIT_LIMIT_MS = 10_000;

export interface MainResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export function runMain(env: Record<string, string>): Promise<MainResult> {
  return runNode(['dist/main.js'], env);
}

/** Runs node in the app folder with an explicit env. */
export function runNode(
  args: string[],
  env: Record<string, string>,
): Promise<MainResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: appRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, EXIT_LIMIT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

export function stdoutLines(result: MainResult): string[] {
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

/** The stdout lines that parse as JSON objects, in order. */
export function jsonLines(result: MainResult): Record<string, unknown>[] {
  return stdoutLines(result).flatMap((raw) => {
    try {
      return [JSON.parse(raw) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/** A loopback TCP listener that counts connections. */
export interface CountingListener {
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

/**
 * `close-at-once` destroys each socket as it arrives. `silent` accepts and
 * never answers, as a hung server would.
 */
export async function countingListener(
  mode: 'close-at-once' | 'silent',
): Promise<CountingListener> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections += 1;
    if (mode === 'close-at-once') {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A loopback port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
