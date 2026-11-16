import { inspect, types, type InspectOptions } from 'node:util';
import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { scrubSecrets } from './secrets.js';

// Two paths print outside pino when a boot fails, and both can carry a database
// error: Nest's default logger before `useLogger` (the ExceptionHandler line and
// the flushed boot lines), and the printer for the rejected bootstrap in
// main.ts. Both scrub the secret values that ConfigModule recorded when it
// parsed the settings, so nothing reads the environment a second time.
//
// Both turn non-string values into text with `util.inspect`, which quotes a
// string with its own escaping (`\'`, `\x07`) and splits a long one at `\n`
// into `'...\n' +` pieces. None of those match a recorded form, so the string
// values are scrubbed before `inspect` sees them (`scrubbedForInspect`), and
// the text is scrubbed again afterwards.

let recorded: readonly string[] = [];

/** Called once per boot by ConfigModule, with `secretValues(settings)`. */
export function recordBootSecrets(values: readonly string[]): void {
  recorded = [...values];
}

/** The values recorded at boot; empty before the settings parsed. */
export function bootSecrets(): readonly string[] {
  return recorded;
}

/** Deeper than either printer inspects: Nest's depth 5, printBootFailure's 4. */
const MIRROR_DEPTH = 16;

/**
 * A copy of `value` for `inspect`, with every recorded secret replaced in every
 * string value it reaches: own properties (enumerable or not, so `message`,
 * `stack`, `cause` and an AggregateError's `errors` too), array elements, and
 * Map and Set entries. Prototypes stay, so class names print unchanged, and
 * cycles stay cycles. Getters are copied, not called, except an Error's own
 * `stack`, which is read once, as `inspect` reads it, even when it is a
 * user-defined accessor. Built-ins with internal state (Date, RegExp, Buffer,
 * Promise, a Proxy, ...) are passed through as they are. Property names are not
 * scrubbed. With no recorded secrets, or if copying fails, `value` itself comes
 * back. Never throws.
 */
export function scrubbedForInspect(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (secrets.length === 0) return value;
  const copies = new Map<object, unknown>();

  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') return scrubSecrets(item, secrets);
    if (typeof item !== 'object' || item === null) return item;
    if (copies.has(item)) return copies.get(item);
    if (depth > MIRROR_DEPTH || passedThrough(item)) return item;

    if (types.isStringObject(item)) {
      const copy = Object(scrubSecrets(item.valueOf(), secrets)) as object;
      copies.set(item, copy);
      return copy;
    }
    const copy = emptyLike(item);
    copies.set(item, copy);
    if (types.isMap(item)) {
      for (const [key, entry] of item) {
        (copy as Map<unknown, unknown>).set(
          visit(key, depth + 1),
          visit(entry, depth + 1),
        );
      }
    } else if (types.isSet(item)) {
      for (const entry of item) {
        (copy as Set<unknown>).add(visit(entry, depth + 1));
      }
    }
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor === undefined) continue;
      if (isError(item) && key === 'stack') {
        // The one getter called: V8 keeps `stack` behind its own accessor, and
        // a user may define one. Read once, as inspect reads it anyway.
        descriptor.value = visit(Reflect.get(item, 'stack'), depth + 1);
        descriptor.writable = true;
        delete descriptor.get;
        delete descriptor.set;
      } else if ('value' in descriptor) {
        descriptor.value = visit(descriptor.value, depth + 1);
      }
      Object.defineProperty(copy, key, descriptor);
    }
    return copy;
  };

  try {
    return visit(value, 0);
  } catch {
    return value;
  }
}

/** `inspect` of the scrubbed copy, falling back to the value as it is. */
function inspectScrubbed(
  value: unknown,
  secrets: readonly string[],
  options: InspectOptions,
): string {
  const copy = scrubbedForInspect(value, secrets);
  if (copy !== value) {
    try {
      return inspect(copy, options);
    } catch {
      // The text scrub after this still runs on the fallback.
    }
  }
  return inspect(value, options);
}

function isError(item: object): item is Error {
  return types.isNativeError(item) || item instanceof Error;
}

/** Built-ins whose content lives in internal slots that a copy would lose. */
function passedThrough(item: object): boolean {
  return (
    typeof item === 'function' ||
    types.isProxy(item) ||
    types.isDate(item) ||
    types.isRegExp(item) ||
    types.isPromise(item) ||
    types.isArrayBufferView(item) ||
    types.isAnyArrayBuffer(item) ||
    types.isWeakMap(item) ||
    types.isWeakSet(item) ||
    types.isNumberObject(item) ||
    types.isBooleanObject(item) ||
    types.isBigIntObject(item) ||
    types.isSymbolObject(item) ||
    types.isModuleNamespaceObject(item) ||
    types.isExternal(item) ||
    types.isGeneratorObject(item) ||
    types.isMapIterator(item) ||
    types.isSetIterator(item) ||
    types.isArgumentsObject(item) ||
    types.isKeyObject(item) ||
    types.isCryptoKey(item) ||
    item instanceof WeakRef
  );
}

/** An empty object of the same kind and prototype, own properties to follow. */
function emptyLike(item: object): object {
  const prototype = Object.getPrototypeOf(item) as object | null;
  let copy: object;
  if (isError(item)) {
    // A real error, so inspect prints it as one. Its own stack goes: the
    // original's own properties are copied over it.
    copy = new Error();
    delete (copy as { stack?: unknown }).stack;
  } else if (Array.isArray(item)) {
    copy = new Array<unknown>(item.length);
  } else if (types.isMap(item)) {
    copy = new Map();
  } else if (types.isSet(item)) {
    copy = new Set();
  } else {
    return Object.create(prototype) as object;
  }
  Object.setPrototypeOf(copy, prototype);
  return copy;
}

/**
 * Nest's default logger with every printed message and stack scrubbed. Passed
 * as `logger` to `createApplicationContext`, so it prints whatever Nest writes
 * before `useLogger` hands output to pino. Plain text, no colours.
 */
export class BootConsoleLogger extends ConsoleLogger {
  constructor() {
    super({ colors: false });
  }

  protected override stringifyMessage(
    message: unknown,
    logLevel: LogLevel,
  ): string {
    const resolved = this.resolveMessage(message);
    const copy = scrubbedForInspect(resolved, bootSecrets());
    if (copy !== resolved) {
      try {
        return super.stringifyMessage(copy, logLevel);
      } catch {
        // formatMessage still scrubs the text of the fallback.
      }
    }
    return super.stringifyMessage(resolved, logLevel);
  }

  protected override stringifyParams(params: Record<string, unknown>): string {
    const copy = scrubbedForInspect(params, bootSecrets());
    if (copy !== params) {
      try {
        return super.stringifyParams(copy as Record<string, unknown>);
      } catch {
        // formatMessage still scrubs the text of the fallback.
      }
    }
    return super.stringifyParams(params);
  }

  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
    params?: Record<string, unknown>,
  ): string {
    return scrubSecrets(
      super.formatMessage(
        logLevel,
        message,
        pidMessage,
        formattedLogLevel,
        contextMessage,
        timestampDiff,
        params,
      ),
      bootSecrets(),
    );
  }

  protected override printStackTrace(stack: string | undefined): void {
    // Nest calls this with no stack for most lines; it then prints nothing.
    super.printStackTrace(
      typeof stack === 'string' ? scrubSecrets(stack, bootSecrets()) : '',
    );
  }
}

/**
 * Prints a failed boot to stderr, scrubbed, and makes the process exit 1
 * (D11: loud, never swallowed). Replaces Node's printer for an unhandled
 * rejection, which does not scrub.
 */
export function printBootFailure(error: unknown): void {
  process.exitCode = 1;
  const secrets = bootSecrets();
  const text = inspectScrubbed(error, secrets, { depth: 4 });
  process.stderr.write(`${scrubSecrets(text, secrets)}\n`);
}
