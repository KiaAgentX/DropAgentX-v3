/**
 * DropAgentX v3 bot — process entrypoint.
 * Polling in development, webhook for Railway (phase 6 wires the single service).
 * Also sweeps the HITL queue on an interval so expired approvals never linger.
 */

import { createV3Client } from '@dropagentx/contracts';
import { webhookCallback } from 'grammy';
import { loadBotConfig, type BotConfig } from './config.js';
import { Orchestrator } from './core/orchestrator.js';
import { createTelegramBot } from './telegram/bot.js';

export interface RunningBot {
  readonly orchestrator: Orchestrator;
  readonly client: ReturnType<typeof createV3Client>;
  sweepTimer: ReturnType<typeof setInterval> | null;
  /**
   * Standard-Web fetch handler for the webhook mode (grammY 'std/http') —
   * the single-service entry mounts it on its own HTTP framework.
   */
  readonly handleWebhook?: (request: Request) => Promise<Response>;
  readonly webhookSecret?: string;
  stop(): Promise<void>;
}

export function buildBot(config: BotConfig): RunningBot {
  const client = createV3Client({
    baseUrl: config.serverBaseUrl,
    headers: { 'x-kia-key': config.adminKey },
  });
  const orchestrator = new Orchestrator({
    v3: client,
    hitlTtlHours: config.hitlTtlHours,
    escrowTtlHours: config.escrowTtlHours,
  });

  const botToken = config.botToken;
  if (botToken === undefined) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to run the bot process (fail-closed).');
  }
  const bot = createTelegramBot(
    { botToken, ...(config.adminChatId !== undefined ? { adminChatId: config.adminChatId } : {}) },
    orchestrator,
  );

  // Webhook mode: expose a transport-agnostic handler so the single-service
  // entry (Railway) can mount it on Fastify without a second port.
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const handleWebhook =
    config.mode === 'webhook'
      ? webhookCallback(bot, 'std/http', 'throw', undefined, webhookSecret)
      : undefined;

  const state: RunningBot = {
    orchestrator,
    client,
    sweepTimer: null,
    ...(handleWebhook !== undefined ? { handleWebhook, ...(webhookSecret !== undefined ? { webhookSecret } : {}) } : {}),
    async stop(): Promise<void> {
      if (state.sweepTimer !== null) clearInterval(state.sweepTimer);
      state.sweepTimer = null;
      await bot.stop();
    },
  };

  // TTL sweep — the queue never grows stale, even without traffic.
  state.sweepTimer = setInterval(() => {
    void client.sweepHitl().then(
      (res) => {
        if (res.ok && res.value.expired > 0) {
          console.log(`[hitl] sweep expired ${res.value.expired} stale request(s)`);
        }
      },
      () => undefined,
    );
  }, 60_000);

  void (async () => {
    if (config.mode === 'webhook' && config.webhookUrl !== undefined) {
      await bot.init();
      await bot.api.setWebhook(config.webhookUrl);
      console.log(`[bot] webhook armed → ${config.webhookUrl}`);
    } else {
      console.log('[bot] starting long-polling…');
      await bot.start({
        drop_pending_updates: true,
        onStart: () => console.log('[bot] polling — connected to Telegram'),
      });
    }
  })().catch((err) => {
    console.error('[bot] startup failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });

  return state;
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  buildBot(loadBotConfig());
}
