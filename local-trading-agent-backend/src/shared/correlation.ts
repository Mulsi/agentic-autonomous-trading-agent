import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const scope = new AsyncLocalStorage<string>();

/** Runs `fn` in a correlation scope that follows it across every `await`. */
export function runWithCorrelation<T>(
  fn: () => T,
  correlationId: string = randomUUID(),
): T {
  return scope.run(correlationId, fn);
}

export function currentCorrelationId(): string | undefined {
  return scope.getStore();
}
