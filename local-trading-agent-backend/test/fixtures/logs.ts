// Checks for captured log output. "Clean" is the value-scrub contract: every
// line is JSON, and no secret appears in the raw text or in any parsed string.

export const REDACTED = '[REDACTED]';

/** A destination stream that keeps every line pino writes. */
export function captureStream(): {
  stream: { write(line: string): void };
  lines: string[];
} {
  const lines: string[] = [];
  return {
    stream: {
      write(line: string) {
        lines.push(line);
      },
    },
    lines,
  };
}

/** Every string inside a parsed JSON value, keys included. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => [
      key,
      ...stringsIn(inner),
    ]);
  }
  return [];
}

/**
 * Parses each line, asserts that none of `secrets` appears in its raw text or
 * in any string of the parsed JSON, and returns the parsed lines.
 */
export function expectClean(
  lines: readonly string[],
  secrets: readonly string[],
): Record<string, unknown>[] {
  expect(lines.length).toBeGreaterThan(0);
  return lines.map((raw) => {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const secret of secrets) {
      expect(raw).not.toContain(secret);
      for (const text of stringsIn(parsed)) {
        expect(text).not.toContain(secret);
      }
    }
    return parsed;
  });
}
