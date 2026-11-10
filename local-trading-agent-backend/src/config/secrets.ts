import { SettingsError, type Settings } from './settings.js';

export const REDACTED = '[REDACTED]';

/**
 * The loaded secret values, in every form a log line can carry them, longest
 * first. Today that is the `DATABASE_URL` password:
 *
 * - the URL as loaded, which is the string `parseSettings` returns
 * - the password as the WHATWG URL parser normalizes it (`url.password`)
 * - the decoded password, unless it does not decode
 * - the JSON-escaped form of each, because pino hooks see serialized lines
 *
 * A URL with no password, or an empty one, yields no values.
 */
export function secretValues(settings: Settings): string[] {
  const url = settings.DATABASE_URL;
  const password = passwordOf(url);
  if (password === '') return [];

  const forms = [url, password];
  const decoded = decodeOrUndefined(password);
  if (decoded !== undefined) forms.push(decoded);

  const values = forms.flatMap((form) => [form, jsonEscaped(form)]);
  return longestFirst(values);
}

/**
 * Replaces every occurrence of every value in `text` with `[REDACTED]`, longest
 * value first, so a URL is replaced whole before its password is. The empty
 * string is never scrubbed.
 */
export function scrubSecrets(text: string, values: readonly string[]): string {
  let scrubbed = text;
  for (const value of longestFirst(values)) {
    scrubbed = scrubbed.split(value).join(REDACTED);
  }
  return scrubbed;
}

/**
 * Node's `ERR_INVALID_URL` carries the whole URL in `input`, and Node's printer
 * for uncaught errors shows it, so that error never leaves `parseUrl`. The
 * error thrown here names the key only and has no `cause`. It is thrown rather
 * than returning no values, because the value may hold a password.
 */
function passwordOf(url: string): string {
  const parsed = parseUrl(url);
  if (parsed === undefined) throw new SettingsError(['DATABASE_URL']);
  return parsed.password;
}

/** The one `new URL` under `src/`. Returns undefined instead of throwing. */
function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function decodeOrUndefined(password: string): string | undefined {
  try {
    return decodeURIComponent(password);
  } catch {
    // Not valid percent-encoding: the raw and normalized forms still cover it.
    return undefined;
  }
}

function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function longestFirst(values: readonly string[]): string[] {
  return [...new Set(values)]
    .filter((value) => value !== '')
    .sort((a, b) => b.length - a.length);
}
