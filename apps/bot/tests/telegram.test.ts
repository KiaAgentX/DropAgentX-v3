/**
 * grammY glue test — a real Update goes through the real Bot into the real
 * orchestrator over the REAL server; outgoing Telegram calls are stubbed with
 * an API transformer (no network). This proves the wiring, not just the core.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createV3Client, type ApiClientResult, type V3Client } from '@dropagentx/contracts';
import { buildApp, type BuiltApp } from '../../server/src/index.js';
import { resetRateLimiter } from '../../server/src/guards.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { createTelegramBot } from '../src/telegram/bot.js';

const ADMIN_KEY = 'v3-test-admin-key-0123456789abcdef';
const BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-TESTS';

/** A static botInfo so the Bot never calls getMe (offline tests). */
const TEST_BOT_INFO = {
  id: 123456,
  is_bot: true,
  first_name: 'DropAgentX',
  username: 'dropagentx_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as unknown as UserFromGetMe;

/** Fail the test loudly on any error result — assertions stay readable. */
async function must<T>(p: Promise<ApiClientResult<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

/** Register the account (the ledger refuses unknown accounts) then mint seed money. */
async function seed(accountId: string, amount: number): Promise<void> {
  await must(client.createAccount({ id: accountId }));
  await must(client.mint({ accountId, amount, memo: 'test seed' }));
}

interface SentCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

let built: BuiltApp;
let client: V3Client;
let sent: SentCall[];
let bot: ReturnType<typeof createTelegramBot>;

beforeAll(async () => {
  built = await buildApp({
    adminKey: ADMIN_KEY,
    botToken: undefined,
    devAuth: false,
    port: 8787,
    rateLimitPerMin: 100_000,
    aiDailyTokenCap: 120_000,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no ephemeral port');
  client = createV3Client({ baseUrl: `http://127.0.0.1:${address.port}/api/v1`, headers: { 'x-kia-key': ADMIN_KEY } });
  const orch = new Orchestrator({ v3: client });
  bot = createTelegramBot({ botToken: BOT_TOKEN, botInfo: TEST_BOT_INFO, adminChatId: '9999' }, orch);

  // Stub every outgoing Telegram API call — capture instead of send.
  sent = [];
  bot.api.config.use((_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
});

afterAll(async () => {
  await built.app.close();
  await built.prisma.$disconnect();
});

beforeEach(async () => {
  resetRateLimiter();
  await built.prisma.auditLog.deleteMany();
  await built.prisma.outboxEvent.deleteMany();
  await built.prisma.hitlRequest.deleteMany();
  await built.prisma.posting.deleteMany();
  await built.prisma.tx.deleteMany();
  await built.prisma.escrow.deleteMany();
  await built.prisma.account.deleteMany();
  await built.store.ensureSystemAccounts();
  sent = [];
});

function messageUpdate(text: string, userId: number, chatId: number, messageId: number): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: userId, is_bot: false, first_name: 'Test', username: `u${userId}` },
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

describe('phase 3 — grammY glue end-to-end', () => {
  it('a /balance update produces an outgoing sendMessage with the balance', async () => {
    await bot.handleUpdate(messageUpdate('/start', 1001, 1001, 1) as Update);
    await bot.handleUpdate(messageUpdate('/balance', 1001, 1001, 2) as Update);

    const balanceMsg = sent.find((c) => c.method === 'sendMessage' && String(c.payload.text).includes('موجودی'));
    expect(balanceMsg).toBeDefined();
    expect(String(balanceMsg?.payload.text)).toContain('user:tg:1001');
    expect(String(balanceMsg?.payload.text).includes('Đ')).toBe(true);
    // The account really exists on the v3 ledger.
    expect((await must(client.balance('user:tg:1001'))).balance).toBe(0);
  });

  it('a /buy update moves money over HTTP exactly once', async () => {
    await seed('user:tg:1001', 500);
    await bot.handleUpdate(messageUpdate('/buy 100 2002 via telegram', 1001, 1001, 10) as Update);

    // commandId is "<chatId>:<messageId>" → the escrow id carries both.
    const escrowId = 'esc:buy:1001:1001:10';
    const escrow = await must(client.getEscrow(escrowId));
    expect(escrow.status).toBe('FUNDED');
    expect(escrow.productRef).toBe('via telegram');
    const okMsg = sent.find((c) => c.method === 'sendMessage' && String(c.payload.text).includes('FUNDED'));
    expect(okMsg).toBeDefined();

    // Same update delivered twice (webhook retry) — no double funding.
    await bot.handleUpdate(messageUpdate('/buy 100 2002 via telegram', 1001, 1001, 10) as Update);
    expect((await must(client.balance('user:tg:1001'))).balance).toBe(400);
    expect((await must(client.balance(`escrow:${escrowId}`))).balance).toBe(100);
  });

  it('HITL: admin chat receives a keyboard notification and a callback press settles', async () => {
    await seed('user:tg:1001', 60_000);
    await bot.handleUpdate(messageUpdate('/buy 60000 2002 gold', 1001, 1001, 20) as Update);
    await bot.handleUpdate(messageUpdate('/deliver esc:buy:1001:1001:20', 2002, 2002, 21) as Update);
    await bot.handleUpdate(messageUpdate('/release esc:buy:1001:1001:20', 1001, 1001, 22) as Update);

    const escrowId = 'esc:buy:1001:1001:20';
    const hitlId = 'hitl:release:esc:buy:1001:1001:20:1001:22';
    const queue = (await must(client.listHitl('PENDING'))).items;
    expect(queue.map((r) => r.id)).toContain(hitlId);

    // The admin presses the inline keyboard button in the admin chat.
    const callbackUpdate: Update = {
      update_id: 30,
      callback_query: {
        id: 'cb1',
        from: { id: 9999, is_bot: false, first_name: 'Owner', username: 'owner' },
        chat_instance: '9999',
        data: `hitl:approve:${hitlId}`,
        message: {
          message_id: 31,
          from: { id: 123456, is_bot: true, first_name: 'DropAgentX' },
          chat: { id: 9999, type: 'private', first_name: 'Owner' },
          date: Math.floor(Date.now() / 1000),
          text: 'hitl notification',
        },
      },
    };
    await bot.handleUpdate(callbackUpdate);

    expect((await must(client.getEscrow(escrowId))).status).toBe('RELEASED');
    expect((await must(client.balance('user:tg:2002'))).balance).toBe(54_000);
    const approvedMsg = sent.find((c) => c.method === 'sendMessage' && String(c.payload.text).includes(hitlId) && String(c.payload.text).includes('✅'));
    expect(approvedMsg).toBeDefined();
    expect((await must(client.economy())).balanced).toBe(true);
  });
});
