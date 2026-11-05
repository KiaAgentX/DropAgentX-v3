/**
 * Single-service entrypoint (Railway, DNA-v2 pattern) — ONE process runs the
 * Fastify server AND the Telegram bot. The bot talks to the server over
 * loopback HTTP (same trust boundary as any client); the HITL sweep interval
 * rides along. Development uses polling; Railway arms the webhook:
 *
 *   BOT_MODE=webhook  BOT_WEBHOOK_URL=https://<app>.up.railway.app/api/v1/bot/webhook
 *   TELEGRAM_WEBHOOK_SECRET=<random>   (optional but recommended)
 *
 * Run: pnpm -F @dropagentx/server exec tsx scripts/single-service.ts
 */

import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/index.js';

const config = loadConfig();
const built = await buildApp(config);

let stopBot: (() => Promise<void>) | null = null;
if (config.botToken !== undefined) {
  const { buildBot, loadBotConfig } = await import('@dropagentx/bot/main');
  const botConfig = loadBotConfig({
    ...process.env,
    SERVER_BASE_URL: process.env.SERVER_BASE_URL ?? `http://127.0.0.1:${config.port}/api/v1`,
    KIA_ADMIN_KEY: process.env.KIA_ADMIN_KEY ?? config.adminKey ?? '',
  });
  const running = buildBot(botConfig);
  stopBot = () => running.stop();

  if (running.handleWebhook !== undefined) {
    const secret = running.webhookSecret;
    built.app.post('/api/v1/bot/webhook', async (req, reply) => {
      const url = `http://127.0.0.1:${config.port}${req.url}`;
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      const request = new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(typeof req.headers['x-telegram-bot-api-secret-token'] === 'string'
            ? { 'x-telegram-bot-api-secret-token': req.headers['x-telegram-bot-api-secret-token'] }
            : {}),
        },
        body,
      });
      const response = await running.handleWebhook(request);
      const text = await response.text();
      reply.code(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(text);
    });
    console.log('[single] Telegram webhook mounted at /api/v1/bot/webhook');
  } else {
    console.log('[single] bot in polling mode (development)');
  }
}

await built.app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[single] DropAgentX v3 on :${config.port} — docs at /api/v1/docs${stopBot !== null ? ' · bot attached' : ''}`);

const shutdown = async (): Promise<void> => {
  console.log('[single] shutting down…');
  if (stopBot !== null) await stopBot();
  await built.app.close();
  await built.prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
