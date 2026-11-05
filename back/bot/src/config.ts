/**
 * Bot environment config — fail-closed with the same zod discipline.
 * The bot is a trusted service: it needs the server URL and the admin key
 * (all v3 money routes are admin-gated; user authorization is enforced by the
 * orchestrator via account ownership, see core/orchestrator.ts).
 */

import { z } from 'zod';

/** dotenv-style files leave empties behind — an empty string means "unset". */
const emptyAsUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const envSchema = z.object({
  SERVER_BASE_URL: z.string().url('SERVER_BASE_URL must be a URL, e.g. http://localhost:8787/api/v1'),
  KIA_ADMIN_KEY: z.preprocess(emptyAsUndefined, z.string().min(16, 'KIA_ADMIN_KEY must be at least 16 chars')),
  TELEGRAM_BOT_TOKEN: z.preprocess(emptyAsUndefined, z.string().min(16).optional()),
  TELEGRAM_ADMIN_CHAT_ID: z.preprocess(emptyAsUndefined, z.string().regex(/^\d+$/).optional()),
  BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
  BOT_WEBHOOK_URL: z.preprocess(emptyAsUndefined, z.string().url().optional()),
  PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  HITL_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  ESCROW_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
});

export interface BotConfig {
  readonly serverBaseUrl: string;
  readonly adminKey: string;
  readonly botToken?: string;
  /** Telegram chat that receives HITL requests and may decide them. */
  readonly adminChatId?: string;
  readonly mode: 'polling' | 'webhook';
  readonly webhookUrl?: string;
  readonly port: number;
  readonly hitlTtlHours: number;
  readonly escrowTtlHours: number;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid bot environment — ${details}`);
  }
  const { SERVER_BASE_URL, KIA_ADMIN_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, BOT_MODE, BOT_WEBHOOK_URL, PORT, HITL_TTL_HOURS, ESCROW_TTL_HOURS } = parsed.data;
  if (BOT_MODE === 'webhook' && BOT_WEBHOOK_URL === undefined) {
    throw new Error('Invalid bot environment — BOT_WEBHOOK_URL is required when BOT_MODE=webhook');
  }
  return {
    serverBaseUrl: SERVER_BASE_URL,
    adminKey: KIA_ADMIN_KEY,
    ...(TELEGRAM_BOT_TOKEN !== undefined ? { botToken: TELEGRAM_BOT_TOKEN } : {}),
    ...(TELEGRAM_ADMIN_CHAT_ID !== undefined ? { adminChatId: TELEGRAM_ADMIN_CHAT_ID } : {}),
    mode: BOT_MODE,
    ...(BOT_WEBHOOK_URL !== undefined ? { webhookUrl: BOT_WEBHOOK_URL } : {}),
    port: PORT,
    hitlTtlHours: HITL_TTL_HOURS,
    escrowTtlHours: ESCROW_TTL_HOURS,
  };
}
