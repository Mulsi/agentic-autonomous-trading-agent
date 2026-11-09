import { z } from 'zod';

// The app holds no Anthropic credential (D9). Any variable not named here,
// including an Anthropic key in the parent environment, is dropped unread.
export const settingsSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, hostname: /./ }),
  TRADER_MODE: z.literal('paper'),
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
