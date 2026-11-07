import { z } from 'zod';

export const settingsSchema = z.object({
  // Opaque on purpose: the key's format belongs to Anthropic, so only blank fails.
  ANTHROPIC_API_KEY: z.string().refine((key) => key.trim().length > 0),
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
