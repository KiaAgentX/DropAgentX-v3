/**
 * Environment config — parsed with the same zod discipline as the wire.
 * Fail-closed: a missing DATABASE_URL refuses to boot; a missing KIA_ADMIN_KEY
 * disables admin endpoints instead of opening them.
 */

import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  KIA_ADMIN_KEY: z.string().min(16).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(16).optional(),
  V3_DEV_AUTH: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(240),
});

export interface Config {
  readonly adminKey?: string;
  readonly botToken?: string;
  /** Dev-only header auth — impossible when a real bot token exists. */
  readonly devAuth: boolean;
  readonly port: number;
  readonly rateLimitPerMin: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment — ${details}`);
  }
  const { KIA_ADMIN_KEY, TELEGRAM_BOT_TOKEN, V3_DEV_AUTH, PORT, RATE_LIMIT_PER_MIN } = parsed.data;
  const devAuth = V3_DEV_AUTH === '1' && !TELEGRAM_BOT_TOKEN;
  return {
    adminKey: KIA_ADMIN_KEY,
    botToken: TELEGRAM_BOT_TOKEN,
    devAuth,
    port: PORT,
    rateLimitPerMin: RATE_LIMIT_PER_MIN,
  };
}
