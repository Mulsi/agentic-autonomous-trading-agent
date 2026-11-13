import { z } from 'zod';

// The app holds no Anthropic credential (D9). Any variable not named here,
// including an Anthropic key in the parent environment, is dropped unread.
export const settingsSchema = z.object({
  // No query string and no fragment. The client takes only scheme, userinfo,
  // host, port and path, so a parameter such as `?sslmode=require` would be
  // dropped silently; it is refused instead. A raw `?` or `#` always starts a
  // query or a fragment in the URL parser, so the check is on the characters.
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/, hostname: /./ })
    .refine((url) => !/[?#]/.test(url)),
  TRADER_MODE: z.literal('paper'),
  // The identity marker this database is expected to carry (src/db/identity.ts).
  // Optional and not a secret. Unset, empty and whitespace-only all mean "not
  // configured"; any other string is kept as written and compared exactly, so
  // this key adds no way for the boot to fail.
  DATABASE_IDENTITY: z
    .string()
    .transform((value) => (value.trim() === '' ? undefined : value))
    .optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

const SETTINGS_KEYS = settingsSchema.keyof().options;

/**
 * Carries key names only. Never attach the input or the zod error to it: this
 * error reaches stderr, and both of those hold the secrets.
 */
export class SettingsError extends Error {
  override readonly name = 'SettingsError';

  constructor(readonly invalidKeys: readonly string[]) {
    super(`Invalid settings: ${invalidKeys.join(', ')}`);
  }
}

export function parseSettings(
  env: Record<string, string | undefined>,
): Settings {
  const result = settingsSchema.safeParse(env);
  if (result.success) return result.data;

  const invalid = new Set(result.error.issues.map((issue) => issue.path[0]));
  throw new SettingsError(SETTINGS_KEYS.filter((key) => invalid.has(key)));
}
