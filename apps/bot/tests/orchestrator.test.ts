/**
 * Phase-3 acceptance suite — the bot orchestrator over a REAL v3 server (HTTP).
 * Covers the ROADMAP Phase-3 gates: /balance, /buy, /orders on the v3 database;
 * retries move money at most once; HITL ≥ 50,000 Đ via the queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createV3Client, type ApiClientResult, type V3Client } from '@dropagentx/contracts';
import { buildApp, type BuiltApp } from '../../server/src/index.js';
import { resetRateLimiter } from '../../server/src/guards.js';
import { Orchestrator, type BotActor, type BotOutcome } from '../src/core/orchestrator.js';

const ADMIN_KEY = 'v3-test-admin-key-0123456789abcdef';

/** Fail the test loudly on any error result — assertions stay readable. */
async function must<T>(p: Promise<ApiClientResult<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

/** Register the account (the ledger refuses unknown accounts) then mint seed money. */
async function seed(accountId: string, amount: number): Promise<void> {
  const created = await client.createAccount({ id: accountId });
  if (!created.ok && created.error.code !== 'DUPLICATE_ACCOUNT') {
    throw new Error(`seed failed: ${created.error.code}: ${created.error.message}`);
  }
  await must(client.mint({ accountId, amount, memo: 'test seed' }));
}

let built: BuiltApp;
let client: V3Client;
let orch: Orchestrator;

const ali: BotActor = { telegramId: '1001', username: 'ali', chatId: '1001', isAdmin: false };
const reza: BotActor = { telegramId: '2002', username: 'reza', chatId: '2002', isAdmin: false };
const owner: BotActor = { telegramId: '9999', chatId: '9999', isAdmin: true };

beforeAll(async () => {
  built = await buildApp({
    adminKey: ADMIN_KEY,
    botToken: undefined,
    devAuth: false,
    port: 8787,
    rateLimitPerMin: 100_000,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no ephemeral port');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  client = createV3Client({ baseUrl, headers: { 'x-kia-key': ADMIN_KEY } });
  orch = new Orchestrator({ v3: client, hitlTtlHours: 24, escrowTtlHours: 72 });
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
});

async function run(actor: BotActor, text: string, commandId: string): Promise<BotOutcome> {
  return orch.handle(actor, { text, commandId });
}

describe('phase 3 — orchestrator over the v3 server', () => {
  it('/start opens the wallet (auto-account) and /balance reads it', async () => {
    const start = await run(ali, '/start', 's1');
    expect(start.reply.text).toContain('user:tg:1001');
    expect(start.reply.text).toContain('Đ');

    const balance = await run(ali, '/balance', 's2');
    expect(balance.reply.text).toContain('user:tg:1001');
    // Persian locale uses Persian digits — assert the Đ unit is present.
    expect(balance.reply.text.endsWith('Đ')).toBe(true);
    expect((await must(client.balance('user:tg:1001'))).balance).toBe(0);
  });

  it('admin /mints and /balance reflects it; /economy is balanced', async () => {
    const mint = await run(owner, '/mint user:tg:1001 5000', 'm1');
    expect(mint.reply.text).toContain('user:tg:1001');
    expect((await must(client.balance('user:tg:1001'))).balance).toBe(5000);

    const economy = await run(ali, '/economy', 'e1');
    expect(economy.reply.text).toContain('Σ');
    expect(economy.reply.text).toContain('✓');
  });

  it('/buy happy path: escrow CREATED + FUNDED on the v3 ledger (acceptance: /buy works)', async () => {
    await seed('user:tg:1001', 1_000);
    const res = await run(ali, '/buy 100 2002 used laptop', 'b1');
    expect(res.reply.text).toContain('esc:buy:1001:b1');
    expect(res.reply.text).toContain('FUNDED');

    // Money moved exactly as the charter says: buyer −100, escrow +100.
    expect((await must(client.balance('user:tg:1001'))).balance).toBe(900);
    expect((await must(client.balance('user:tg:2002'))).balance).toBe(0);
    expect((await must(client.balance('escrow:esc:buy:1001:b1'))).balance).toBe(100);
    const escrow = await must(client.getEscrow('esc:buy:1001:b1'));
    expect(escrow.buyerId).toBe('user:tg:1001');
    expect(escrow.sellerId).toBe('user:tg:2002');
    expect(escrow.productRef).toBe('used laptop');
    expect(escrow.expiresAt).not.toBeNull(); // TTL armed (Article 9 auto-refund path)
  });

  it('a retried /buy (same message id) never funds twice', async () => {
    await seed('user:tg:1001', 1_000);
    const first = await run(ali, '/buy 100 2002', 'retry1');
    expect(first.reply.text).toContain('FUNDED');

    // Telegram delivers the same update again (webhook retry / network flake).
    const replay = await run(ali, '/buy 100 2002', 'retry1');
    expect(replay.reply.text).toContain('FUNDED'); // honest replay reply

    expect((await must(client.balance('user:tg:1001'))).balance).toBe(900);
    expect((await must(client.balance('escrow:esc:buy:1001:retry1'))).balance).toBe(100);
    const txs = await built.prisma.tx.count({ where: { memo: { contains: 'fund escrow' } } });
    expect(txs).toBe(1);
  });

  it('/orders lists my escrows as buyer and as seller (acceptance: /orders works)', async () => {
    await seed('user:tg:1001', 300);
    await run(ali, '/buy 100 2002 keyboard', 'o1');

    const asBuyer = await run(ali, '/orders', 'o2');
    expect(asBuyer.reply.text).toContain('esc:buy:1001:o1');
    expect(asBuyer.reply.text).toContain('FUNDED');

    const asSeller = await run(reza, '/orders', 'o3');
    expect(asSeller.reply.text).toContain('esc:buy:1001:o1');
  });

  it('deliver is seller-only, release is buyer-only (fail-closed authorization)', async () => {
    await seed('user:tg:1001', 300);
    await run(ali, '/buy 100 2002 mouse', 'd1');
    const escrowId = 'esc:buy:1001:d1';

    const stranger = await run({ telegramId: '3003', chatId: '3003', isAdmin: false }, `/deliver ${escrowId}`, 'd2');
    expect(stranger.reply.text).toContain('متعلق به شما نیست');

    const buyerTry = await run(ali, `/deliver ${escrowId}`, 'd3');
    expect(buyerTry.reply.text).toContain('متعلق به شما نیست');

    const sellerOk = await run(reza, `/deliver ${escrowId}`, 'd4');
    expect(sellerOk.reply.text).toContain('تحویل');
    expect((await must(client.getEscrow(escrowId))).status).toBe('DELIVERED');

    const sellerRelease = await run(reza, `/release ${escrowId}`, 'd5');
    expect(sellerRelease.reply.text).toContain('متعلق به شما نیست');
  });

  it('small /release settles directly: seller 90 + treasury 10 (exact 10%)', async () => {
    await seed('user:tg:1001', 300);
    await run(ali, '/buy 100 2002 cable', 'r1');
    await run(reza, '/deliver esc:buy:1001:r1', 'r2');
    const res = await run(ali, '/release esc:buy:1001:r1', 'r3');
    expect(res.reply.text).toContain('۹۰'); // 90 Đ net, Persian digits
    expect(res.reply.text).toContain('۱۰'); // 10 Đ tax

    expect((await must(client.balance('user:tg:2002'))).balance).toBe(90);
    expect((await must(client.balance('user:tg:1001'))).balance).toBe(200);
    const treasury = await must(client.economy());
    expect(treasury.treasuryBalance).toBe(10);
    expect(treasury.balanced).toBe(true);
  });

  it('big /release goes through the HITL queue: admin notified, /pending lists it', async () => {
    await seed('user:tg:1001', 60_000);
    await run(ali, '/buy 60000 2002 car', 'h1');
    await run(reza, '/deliver esc:buy:1001:h1', 'h2');
    const res = await run(ali, '/release esc:buy:1001:h1', 'h3');

    expect(res.reply.text).toContain('hitl:release:esc:buy:1001:h1:h3');
    // The admin gets a notification with approve/reject buttons.
    expect(res.notifyAdmin).toBeDefined();
    expect(res.notifyAdmin?.keyboard?.[0]?.[0]?.callbackData).toBe('hitl:approve:hitl:release:esc:buy:1001:h1:h3');

    const queue = await run(owner, '/pending', 'h4');
    expect(queue.reply.text).toContain('hitl:release:esc:buy:1001:h1:h3');
    expect((await must(client.getEscrow('esc:buy:1001:h1'))).status).toBe('DELIVERED');
    expect((await must(client.balance('user:tg:2002'))).balance).toBe(0); // nothing settled yet
  });

  it('admin /approve settles: seller 54,000 + treasury 6,000; replay is a no-op; requester notified', async () => {
    await seed('user:tg:1001', 60_000);
    await run(ali, '/buy 60000 2002 car', 'a1');
    await run(reza, '/deliver esc:buy:1001:a1', 'a2');
    const filed = await run(ali, '/release esc:buy:1001:a1', 'a3');
    const hitlId = 'hitl:release:esc:buy:1001:a1:a3';

    const approved = await run(owner, `/approve ${hitlId}`, 'a4');
    expect(approved.reply.text).toContain('۵۴٬۰۰۰');
    expect(approved.reply.text).toContain('۶٬۰۰۰');
    expect(approved.notifyRequester?.telegramId).toBe('1001');

    expect((await must(client.getEscrow('esc:buy:1001:a1'))).status).toBe('RELEASED');
    expect((await must(client.balance('user:tg:2002'))).balance).toBe(54_000);

    // Double-click on the button — the wire returns the original settlement.
    const again = await run(owner, `/approve ${hitlId}`, 'a5');
    expect((await must(client.balance('user:tg:2002'))).balance).toBe(54_000);
    void again;

    // Inline-keyboard callback path mirrors the command path.
    await seed('user:tg:1001', 60_000); // buyer wallet is empty after the first settlement
    await run(ali, '/buy 60000 2002 car', 'a6'); // different message → different escrow
    await run(reza, '/deliver esc:buy:1001:a6', 'a7');
    await run(ali, '/release esc:buy:1001:a6', 'a8');
    const viaCallback = await orch.handleCallback(owner, 'hitl:approve:hitl:release:esc:buy:1001:a6:a8');
    expect(viaCallback.reply.text).toContain('۵۴٬۰۰۰');
    expect((await must(client.getEscrow('esc:buy:1001:a6'))).status).toBe('RELEASED');
  });

  it('/reject keeps the escrow locked and notifies the requester', async () => {
    await seed('user:tg:1001', 60_000);
    await run(ali, '/buy 60000 2002 car', 'j1');
    await run(reza, '/deliver esc:buy:1001:j1', 'j2');
    await run(ali, '/release esc:buy:1001:j1', 'j3');
    const hitlId = 'hitl:release:esc:buy:1001:j1:j3';

    const rejected = await run(owner, `/reject ${hitlId}`, 'j4');
    expect(rejected.reply.text).toContain(hitlId);
    expect(rejected.notifyRequester?.telegramId).toBe('1001');

    expect((await must(client.getEscrow('esc:buy:1001:j1'))).status).toBe('DELIVERED');
    expect((await must(client.balance('escrow:esc:buy:1001:j1'))).balance).toBe(60_000);
    const late = await run(owner, `/approve ${hitlId}`, 'j5');
    expect(late.reply.text).toContain('قبلا');
  });

  it('non-admins cannot touch the queue or mint', async () => {
    const pending = await run(ali, '/pending', 'n1');
    expect(pending.reply.text).toContain('ادمین');
    const mint = await run(ali, '/mint user:tg:1001 999', 'n2');
    expect(mint.reply.text).toContain('ادمین');
    const approve = await orch.handleCallback(ali, 'hitl:approve:x1');
    expect(approve.reply.text).toContain('ادمین');
  });

  it('/buy without funds fails honestly and the escrow waits in CREATED', async () => {
    const res = await run(ali, '/buy 100 2002 hope', 'f1');
    expect(res.reply.text).toContain('esc:buy:1001:f1');
    expect(res.reply.text).toContain('/fund');
    expect((await must(client.getEscrow('esc:buy:1001:f1'))).status).toBe('CREATED');
    // The ledger refused the overdraft — nothing leaked.
    expect((await must(client.balance('escrow:esc:buy:1001:f1'))).balance).toBe(0);
  });

  it('/fund completes a previously-unfunded escrow; /cancel only works before funding', async () => {
    await seed('user:tg:1001', 100);
    const first = await run(ali, '/buy 100 2002 pen', 'c1'); // buyer has exactly 100 → funded!
    expect(first.reply.text).toContain('FUNDED');

    // A second escrow fails to fund (balance is 0 now) then gets funded later.
    const second = await run(ali, '/buy 50 2002 pen2', 'c2');
    expect(second.reply.text).toContain('/fund');
    expect((await must(client.getEscrow('esc:buy:1001:c2'))).status).toBe('CREATED');

    await seed('user:tg:1001', 50);
    const funded = await run(ali, '/fund esc:buy:1001:c2', 'c3');
    expect(funded.reply.text).toContain('تامین');
    expect((await must(client.getEscrow('esc:buy:1001:c2'))).status).toBe('FUNDED');

    // Cancel after funding must be refused by the state machine.
    const lateCancel = await run(ali, '/cancel esc:buy:1001:c2', 'c4');
    expect(lateCancel.reply.text).toContain('نمی‌دهد');
  });

  it('/cancel before funding removes the escrow with zero money movement', async () => {
    const res = await run(ali, '/buy 100 2002 wish', 'x1'); // no funds → CREATED
    expect(res.reply.text).toContain('/fund');
    const cancelled = await run(ali, '/cancel esc:buy:1001:x1', 'x2');
    expect(cancelled.reply.text).toContain('لغو');
    expect((await must(client.getEscrow('esc:buy:1001:x1'))).status).toBe('CANCELLED');
  });

  it('/dispute freezes a funded escrow; arbitration refund returns every dinar', async () => {
    await seed('user:tg:1001', 200);
    await run(ali, '/buy 100 2002 watch', 'q1');
    const disputed = await run(ali, '/dispute esc:buy:1001:q1 not as described', 'q2');
    expect(disputed.reply.text).toContain('اختلاف');
    expect((await must(client.getEscrow('esc:buy:1001:q1'))).status).toBe('DISPUTED');

    const refunded = await client.refundEscrow('esc:buy:1001:q1', { idempotencyKey: 'arbitration:q1' });
    expect(refunded.ok).toBe(true);
    expect((await must(client.balance('user:tg:1001'))).balance).toBe(200);
    expect((await must(client.balance('user:tg:2002'))).balance).toBe(0); // no tax on refunds
    expect((await must(client.economy())).balanced).toBe(true);
  });

  it('/lang switches the locale; unknown commands are refused politely', async () => {
    const nonsense = await run(ali, '/frobnicate', 'l3');
    expect(nonsense.reply.text).toContain('ناشناخته');
    const badAmount = await run(ali, '/buy 1.5 2002', 'l4');
    expect(badAmount.reply.text).toContain('/buy');

    await run(ali, '/lang en', 'l1');
    const balance = await run(ali, '/balance', 'l2');
    expect(balance.reply.text).toContain('Balance of user:tg:1001');
  });

  it('the whole day sums to zero — the sacred invariant survives the bot', async () => {
    await seed('user:tg:1001', 500);
    await run(ali, '/buy 100 2002 a', 'z1');
    await run(reza, '/deliver esc:buy:1001:z1', 'z2');
    await run(ali, '/release esc:buy:1001:z1', 'z3');
    await run(ali, '/buy 100 2002 b', 'z4');
    await run(ali, '/cancel esc:buy:1001:z4', 'z5');
    const economy = await must(client.economy());
    expect(economy.trialBalanceSum).toBe(0);
    expect(economy.balanced).toBe(true);
  });
});
