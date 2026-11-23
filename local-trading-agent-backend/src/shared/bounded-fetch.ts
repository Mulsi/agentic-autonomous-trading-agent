// The one place under src/ that calls the built-in fetch (D2). A GET with a
// byte cap, a timeout over the whole exchange, and no redirects. The body is
// untrusted data: it is counted as it arrives and never decoded here.

export interface BoundedGetLimits {
  /** The largest body accepted, in bytes. */
  readonly maxBytes: number;
  /** The whole request, body included, gives up after this long. */
  readonly timeoutMs: number;
}

export type BoundedGetFailure =
  'timeout' | 'too_large' | 'redirect' | 'network';

export type BoundedGetResult =
  | { readonly ok: true; readonly status: number; readonly body: Uint8Array }
  | { readonly ok: false; readonly reason: BoundedGetFailure };

const EMPTY = new Uint8Array(0);

/** undici's message when `redirect: 'error'` meets a 3xx response. */
function isRedirect(error: unknown): boolean {
  const cause =
    typeof error === 'object' && error !== null && 'cause' in error
      ? error.cause
      : undefined;
  return cause instanceof Error && /\bredirect\b/i.test(cause.message);
}

function failure(error: unknown, timeout: AbortSignal): BoundedGetResult {
  if (timeout.aborted) return { ok: false, reason: 'timeout' };
  if (isRedirect(error)) return { ok: false, reason: 'redirect' };
  return { ok: false, reason: 'network' };
}

/**
 * GETs `url`. A 2xx answer comes back with its body; any other status comes
 * back with an empty body and never throws. A declared or counted body over
 * `maxBytes` aborts the request as soon as it is known.
 */
export async function boundedGet(
  url: string,
  { maxBytes, timeoutMs }: BoundedGetLimits,
): Promise<BoundedGetResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a safe integer >= 0');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a safe integer > 0');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  const signal = AbortSignal.any([timeout, controller.signal]);

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', redirect: 'error', signal });
  } catch (error) {
    return failure(error, timeout);
  }

  if (response.status < 200 || response.status > 299) {
    controller.abort();
    return { ok: true, status: response.status, body: EMPTY };
  }

  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    /^[0-9]+$/.test(declared) &&
    Number(declared) > maxBytes
  ) {
    // Closes the connection before the body is read.
    controller.abort();
    return { ok: false, reason: 'too_large' };
  }

  if (response.body === null) {
    return { ok: true, status: response.status, body: EMPTY };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    return failure(error, timeout);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, status: response.status, body };
}
