/**
 * Phase-2 acceptance suite — ledger→escrow→HTTP integration over a real SQLite file.
 * Covers the ROADMAP Phase-2 criteria: OpenAPI served, endpoints born from zod
 * contracts, fail-closed auth, idempotency, HITL gate, mint cap, audit/outbox.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/index.js';
import { makeTestInitData, verifyTelegramInitData } from '../src/auth.js';
import { resetRateLimiter } from '../src/guards.js';

const ADMIN_KEY = 'v3-test-admin-key-0123456789abcdef';
const ADMIN = { 'x-kia-key': ADMIN_KEY, 'content-type': 'application/json' };
const JSON_HDR = { 'content-type': 'application/json' };

let built: BuiltApp;

beforeAll(async () => {
  built = await buildApp({
    adminKey: ADMIN_KEY,
    botToken: undefined,
    devAuth: false,
    port: 8787,
    rateLimitPerMin: 100_000,
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
  await built.prisma.posting.deleteMany();
  await built.prisma.tx.deleteMany();
  await built.prisma.escrow.deleteMany();
  await built.prisma.account.deleteMany();
  await built.store.ensureSystemAccounts();
});

async function newUser(id: string): Promise<void> {
  const res = await built.app.inject({ method: 'POST', url: '/api/v1/accounts', headers: ADMIN, payload: { id } });
  if (res.statusCode !== 201) throw new Error(`create ${id} failed: ${res.statusCode} ${res.body}`);
}

async function mint(accountId: string, amount: number): Promise<void> {
  const res = await built.app.inject({ method: 'POST', url: '/api/v1/wallet/mint', headers: ADMIN, payload: { accountId, amount, memo: 'test genesis' } });
  if (res.statusCode !== 200) throw new Error(`mint failed: ${res.statusCode} ${res.body}`);
}

describe('phase 2 — server over the pure domain', () => {
  it('serves health and a meaningful OpenAPI 3.1 document', async () => {
    const health = await built.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', service: 'dropagentx-v3-server' });

    const doc = await built.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(doc.statusCode).toBe(200);
    const json = doc.json() as { openapi: string; paths: Record<string, unknown> };
    expect(json.openapi).toBe('3.1.0');
    expect(Object.keys(json.paths).length).toBeGreaterThanOrEqual(15);
    expect(json.paths['/escrows/{id}/release']).toBeDefined();
  });

  it('refuses admin actions with missing or wrong keys (fail-closed)', async () => {
    const noKey = await built.app.inject({
      method: 'POST',
      url: '/api/v1/wallet/mint',
      headers: JSON_HDR,
      payload: { accountId: 'user:a', amount: 5 },
    });
    expect(noKey.statusCode).toBe(401);
    expect(noKey.json().error.code).toBe('ADMIN_KEY_REQUIRED');

    const wrongKey = await built.app.inject({
      method: 'POST',
      url: '/api/v1/wallet/mint',
      headers: { 'x-kia-key': 'totally-wrong-key-1234567890', 'content-type': 'application/json' },
      payload: { accountId: 'user:a', amount: 5 },
    });
    expect(wrongKey.statusCode).toBe(401);
    expect(wrongKey.json().error.code).toBe('INVALID_ADMIN_KEY');
  });

  it('registers accounts, mints under the cap, and exposes derived balances', async () => {
    const created = await built.app.inject({ method: 'POST', url: '/api/v1/accounts', headers: ADMIN, payload: { id: 'user:ali', label: 'علی' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'user:ali', kind: 'user', balance: 0 });

    const dup = await built.app.inject({ method: 'POST', url: '/api/v1/accounts', headers: ADMIN, payload: { id: 'user:ali' } });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().error.code).toBe('DUPLICATE_ACCOUNT');

    const reserved = await built.app.inject({ method: 'POST', url: '/api/v1/accounts', headers: ADMIN, payload: { id: 'mint:fake' } });
    expect(reserved.statusCode).toBe(422);
    expect(reserved.json().error.code).toBe('RESERVED_ID');

    const mintRes = await built.app.inject({ method: 'POST', url: '/api/v1/wallet/mint', headers: ADMIN, payload: { accountId: 'user:ali', amount: 500 } });
    expect(mintRes.statusCode).toBe(200);
    expect(mintRes.json()).toMatchObject({ accountId: 'user:ali', balance: 500, replayed: false });

    const balance = await built.app.inject({ method: 'GET', url: '/api/v1/accounts/user:ali/balance' });
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toEqual({ accountId: 'user:ali', balance: 500 });

    const ghost = await built.app.inject({ method: 'GET', url: '/api/v1/accounts/user:ghost/balance' });
    expect(ghost.statusCode).toBe(404);

    const list = await built.app.inject({ method: 'GET', url: '/api/v1/accounts', headers: ADMIN });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((i: { id: string }) => i.id)).toContain('user:ali');
  });

  it('enforces the yearly mint cap (charter Article 3)', async () => {
    await newUser('user:fat');
    const ok = await built.app.inject({ method: 'POST', url: '/api/v1/wallet/mint', headers: ADMIN, payload: { accountId: 'user:fat', amount: 1_000_000 } });
    expect(ok.statusCode).toBe(200);
    const over = await built.app.inject({ method: 'POST', url: '/api/v1/wallet/mint', headers: ADMIN, payload: { accountId: 'user:fat', amount: 1 } });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('MINT_CAP_EXCEEDED');
  });

  it('runs the full escrow lifecycle over HTTP with exact 10% tax', async () => {
    await newUser('user:buyer');
    await newUser('user:seller');
    await mint('user:buyer', 1_000);

    const created = await built.app.inject({
      method: 'POST',
      url: '/api/v1/escrows',
      headers: ADMIN,
      payload: { id: 'e1', buyerId: 'user:buyer', sellerId: 'user:seller', amount: 100, productRef: 'prod:1' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().escrow).toMatchObject({ id: 'e1', status: 'CREATED' });

    const publicRead = await built.app.inject({ method: 'GET', url: '/api/v1/escrows/e1' });
    expect(publicRead.statusCode).toBe(200);
    expect(publicRead.json().status).toBe('CREATED');

    const fund = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/e1/fund', headers: ADMIN, payload: {} });
    expect(fund.statusCode).toBe(200);
    expect(fund.json().escrow.status).toBe('FUNDED');
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/accounts/user:buyer/balance' })).json().balance).toBe(900);
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/accounts/escrow:e1/balance' })).json().balance).toBe(100);

    const deliver = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/e1/deliver', headers: ADMIN, payload: { deliveryRef: 'payload:e1' } });
    expect(deliver.statusCode).toBe(200);
    expect(deliver.json().escrow.status).toBe('DELIVERED');

    const release = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/e1/release', headers: ADMIN, payload: {} });
    expect(release.statusCode).toBe(200);
    expect(release.json().escrow.status).toBe('RELEASED');
    expect(release.json().txId).toEqual(expect.any(String));
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/accounts/user:seller/balance' })).json().balance).toBe(90);
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/accounts/treasury:nation/balance' })).json().balance).toBe(10);

    const economy = await built.app.inject({ method: 'GET', url: '/api/v1/economy' });
    expect(economy.statusCode).toBe(200);
    const e = economy.json();
    expect(e).toMatchObject({
      currency: 'DNX',
      symbol: 'Đ',
      circulatingSupply: 1_000,
      treasuryBalance: 10,
      escrowLocked: 0,
      mintedAllTime: 1_000,
      burnedAllTime: 0,
      trialBalanceSum: 0,
      balanced: true,
      genesisSupply: 187_672,
      yearlyMintCap: 1_000_000,
    });
  });

  it('never double-moves money on retried fund calls (idempotency)', async () => {
    await newUser('user:buyer');
    await newUser('user:seller');
    await mint('user:buyer', 100);
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows', headers: ADMIN, payload: { id: 'e2', buyerId: 'user:buyer', sellerId: 'user:seller', amount: 40 } });

    const first = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/e2/fund', headers: ADMIN, payload: { idempotencyKey: 'fund-e2-attempt-1' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);
    const firstTxId = first.json().txId as string;

    const retry = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/e2/fund', headers: ADMIN, payload: { idempotencyKey: 'fund-e2-attempt-1' } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().replayed).toBe(true);
    expect(retry.json().txId).toBe(firstTxId);
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/accounts/escrow:e2/balance' })).json().balance).toBe(40);
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/accounts/user:buyer/balance' })).json().balance).toBe(60);
  });

  it('gates releases ≥ 50,000 Đ behind explicit human approval (Article 7)', async () => {
    await newUser('user:buyer');
    await newUser('user:seller');
    await mint('user:buyer', 60_000);
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows', headers: ADMIN, payload: { id: 'big', buyerId: 'user:buyer', sellerId: 'user:seller', amount: 60_000 } });
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows/big/fund', headers: ADMIN, payload: {} });
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows/big/deliver', headers: ADMIN, payload: {} });

    const blocked = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/big/release', headers: ADMIN, payload: {} });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('REQUIRES_HUMAN_APPROVAL');

    const approved = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/big/release', headers: ADMIN, payload: { approvedByAdmin: true } });
    expect(approved.statusCode).toBe(200);
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/accounts/user:seller/balance' })).json().balance).toBe(54_000);
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/accounts/treasury:nation/balance' })).json().balance).toBe(6_000);
  });

  it('refuses overdrafts, invalid transitions, and unknown escrows', async () => {
    await newUser('user:poor');
    await newUser('user:seller');
    await mint('user:poor', 50);

    await built.app.inject({ method: 'POST', url: '/api/v1/escrows', headers: ADMIN, payload: { id: 'e8', buyerId: 'user:poor', sellerId: 'user:seller', amount: 5_000 } });
    const overdraft = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/e8/fund', headers: ADMIN, payload: {} });
    expect(overdraft.statusCode).toBe(422);
    expect(overdraft.json().error.code).toBe('ACCOUNT_OVERDRAFT');

    await built.app.inject({ method: 'POST', url: '/api/v1/escrows', headers: ADMIN, payload: { id: 'e9', buyerId: 'user:poor', sellerId: 'user:seller', amount: 10 } });
    const earlyDeliver = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/e9/deliver', headers: ADMIN, payload: {} });
    expect(earlyDeliver.statusCode).toBe(422);
    expect(earlyDeliver.json().error.code).toBe('INVALID_TRANSITION');

    const ghost = await built.app.inject({ method: 'GET', url: '/api/v1/escrows/ghost' });
    expect(ghost.statusCode).toBe(404);
    const ghostFund = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/ghost/fund', headers: ADMIN, payload: {} });
    expect(ghostFund.statusCode).toBe(404);

    const dupEscrow = await built.app.inject({ method: 'POST', url: '/api/v1/escrows', headers: ADMIN, payload: { id: 'e9', buyerId: 'user:poor', sellerId: 'user:seller', amount: 10 } });
    expect(dupEscrow.statusCode).toBe(422);
    expect(dupEscrow.json().error.code).toBe('ESCROW_ALREADY_EXISTS');
  });

  it('refunds disputed escrows to the buyer in full, tax-free', async () => {
    await newUser('user:buyer');
    await newUser('user:seller');
    await mint('user:buyer', 100);
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows', headers: ADMIN, payload: { id: 'e10', buyerId: 'user:buyer', sellerId: 'user:seller', amount: 40 } });
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows/e10/fund', headers: ADMIN, payload: {} });

    const disputed = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/e10/dispute', headers: ADMIN, payload: { reason: 'کالا ناقص بود' } });
    expect(disputed.statusCode).toBe(200);
    expect(disputed.json().escrow.status).toBe('DISPUTED');
    expect(disputed.json().escrow.disputeReason).toBe('کالا ناقص بود');

    const refunded = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/e10/refund', headers: ADMIN, payload: {} });
    expect(refunded.statusCode).toBe(200);
    expect(refunded.json().escrow.status).toBe('REFUNDED');
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/accounts/user:buyer/balance' })).json().balance).toBe(100);
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/accounts/treasury:nation/balance' })).json().balance).toBe(0);
  });

  it('rejects malformed payloads with 400 INVALID_REQUEST (contracts on the wire)', async () => {
    const float = await built.app.inject({ method: 'POST', url: '/api/v1/wallet/mint', headers: ADMIN, payload: { accountId: 'user:x', amount: 1.5 } });
    expect(float.statusCode).toBe(400);
    expect(float.json().error.code).toBe('INVALID_REQUEST');

    const badId = await built.app.inject({ method: 'POST', url: '/api/v1/wallet/mint', headers: ADMIN, payload: { accountId: 'bad id!', amount: 5 } });
    expect(badId.statusCode).toBe(400);

    const negative = await built.app.inject({ method: 'POST', url: '/api/v1/escrows', headers: ADMIN, payload: { id: 'neg', buyerId: 'user:a', sellerId: 'user:b', amount: -5 } });
    expect(negative.statusCode).toBe(400);

    const noReason = await built.app.inject({ method: 'POST', url: '/api/v1/escrows/x/dispute', headers: ADMIN, payload: {} });
    expect(noReason.statusCode).toBe(400);
  });

  it('writes outbox events and audit rows for escrow commands', async () => {
    await newUser('user:buyer');
    await newUser('user:seller');
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows', headers: ADMIN, payload: { id: 'e11', buyerId: 'user:buyer', sellerId: 'user:seller', amount: 20 } });

    const outbox = await built.prisma.outboxEvent.findMany();
    expect(outbox.map((o) => o.kind)).toContain('EscrowCreated');
    expect(outbox.every((o) => o.published === false)).toBe(true);

    const audit = await built.prisma.auditLog.findMany({ where: { action: 'escrow.create' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.target).toBe('e11');
    expect(audit[0]?.actor).toBe('admin');
  });

  it('rate limits mutating endpoints per IP', async () => {
    const small = await buildApp({
      adminKey: ADMIN_KEY,
      botToken: undefined,
      devAuth: false,
      port: 8788,
      rateLimitPerMin: 4,
    });
    try {
      // hit 1 — account registration
      await small.app.inject({ method: 'POST', url: '/api/v1/accounts', headers: ADMIN, payload: { id: 'user:rl' } });
      // hits 2-4 — mints; the 4th is refused
      let last = 0;
      for (let i = 0; i < 4; i++) {
        const res = await small.app.inject({ method: 'POST', url: '/api/v1/wallet/mint', headers: ADMIN, payload: { accountId: 'user:rl', amount: 1 } });
        last = res.statusCode;
        if (i < 3) expect(res.statusCode).toBe(200);
      }
      expect(last).toBe(429);
    } finally {
      await small.app.close();
      await small.prisma.$disconnect();
    }
  });

  it('verifies Telegram initData HMAC round-trip and rejects tampering', () => {
    const token = '123456:TEST-TOKEN-abcdef0123456789';
    const initData = makeTestInitData(token, { id: 81_985_986_35, username: 'kia' });
    expect(verifyTelegramInitData(initData, token)).toEqual({ userId: '8198598635', username: 'kia' });

    const tampered = initData.slice(0, -3) + '000';
    expect(verifyTelegramInitData(tampered, token)).toBeNull();
    expect(verifyTelegramInitData(initData, '999999:OTHER-TOKEN-xyz0123456789')).toBeNull();
  });
});
