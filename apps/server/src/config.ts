/**
 * Environment config — parsed with the same zod discipline as the wire.
 * Fail-closed: a missing DATABASE_URL refuses to boot; a missing KIA_ADMIN_KEY
 * disables admin endpoints instead of opening them.
 */

import { z } from 'zod';
import type { LlmConfig } from '@dropagentx/llm';
import { loadGatewayConfigsSafe, loadGatewayOptions } from '@dropagentx/ai-gateway';

/** dotenv-style files leave empties behind — an empty string means "unset". */
const emptyAsUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  KIA_ADMIN_KEY: z.preprocess(emptyAsUndefined, z.string().min(16).optional()),
  TELEGRAM_BOT_TOKEN: z.preprocess(emptyAsUndefined, z.string().min(16).optional()),
  V3_DEV_AUTH: z.preprocess(emptyAsUndefined, z.string().optional()),
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
  /** OpenAI-compatible LLM (ADR-006) — undefined = AI cycle disabled. */
  readonly llm?: LlmConfig;
  /** Phase 5 gateway — the ordered provider chain (primary first). */
  readonly aiProviders?: readonly { readonly name: string; readonly config: LlmConfig }[];
  /** Per-user daily AI token cap (default 120,000). */
  readonly aiDailyTokenCap: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment — ${details}`);
  }
  const { KIA_ADMIN_KEY, TELEGRAM_BOT_TOKEN, V3_DEV_AUTH, PORT, RATE_LIMIT_PER_MIN } = parsed.data;
  const devAuth = V3_DEV_AUTH === '1' && !TELEGRAM_BOT_TOKEN;
  // Fail-closed (ADR-006 + ADR-008): an EMPTY LLM env means AI disabled
  // (legitimate deployment — /ai/* answers 503); a PARTIAL configuration
  // refuses to boot, all-or-nothing, per provider.
  const gateway = loadGatewayConfigsSafe(env);
  if (!gateway.ok) {
    throw new Error(`Invalid environment — ${gateway.message}`);
  }
  const aiOptions = loadGatewayOptions(env);
  const primary = gateway.providers[0];
  return {
    adminKey: KIA_ADMIN_KEY,
    botToken: TELEGRAM_BOT_TOKEN,
    devAuth,
    port: PORT,
    rateLimitPerMin: RATE_LIMIT_PER_MIN,
    ...(primary !== undefined ? { llm: primary.config } : {}),
    ...(gateway.providers.length > 0 ? { aiProviders: gateway.providers } : {}),
    aiDailyTokenCap: aiOptions.dailyTokenCap ?? 120_000,
  };
}
