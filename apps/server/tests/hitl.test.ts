/**
 * Phase-3 acceptance suite (server side) — the HITL queue end-to-end:
 * create → list → approve (settlement in the same transaction) / reject / sweep.
 * Mirrors the ROADMAP Phase-3 criteria: ≥ 50,000 Đ releases only via human approval,
 * decision + money move are atomic, replays never pay twice.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/index.js';
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
  await built.prisma.hitlRequest.deleteMany();
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

/** A DELIVERED escrow of `amount` Đ — the state a release approval applies to. */
async function deliveredEscrow(amount: number, id = 'esc_big'): Promise<void> {
  await newUser('user:buyer');
  await newUser('user:seller');
  await mint('user:buyer', amount);
  const created = await built.app.inject({
    method: 'POST',
    url: '/api/v1/escrows',
    headers: ADMIN,
    payload: { id, buyerId: 'user:buyer', sellerId: 'user:seller', amount },
  });
  if (created.statusCode !== 201) throw new Error(`escrow create failed: ${created.statusCode} ${created.body}`);
  const funded = await built.app.inject({ method: 'POST', url: `/api/v1/escrows/${id}/fund`, headers: ADMIN, payload: {} });
  if (funded.statusCode !== 200) throw new Error(`escrow fund failed: ${funded.statusCode} ${funded.body}`);
  const delivered = await built.app.inject({ method: 'POST', url: `/api/v1/escrows/${id}/deliver`, headers: ADMIN, payload: {} });
  if (delivered.statusCode !== 200) throw new Error(`escrow deliver failed: ${delivered.statusCode} ${delivered.body}`);
}

interface HitlViewJson {
  id: string;
  status: string;
  amount: number;
  escrowId: string;
  requesterId: string;
  decidedBy: string | null;
}

describe('phase 3 — HITL queue on the server', () => {
  it('creates a PENDING request for a DELIVERED escrow ≥ 50,000 Đ (amount copied from escrow)', async () => {
    await deliveredEscrow(60_000);
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/v1/hitl',
      headers: ADMIN,
      payload: { kind: 'ESCROW_RELEASE', escrowId: 'esc_big', requesterId: 'user:buyer', note: 'worker bot' },
    });
    expect(res.statusCode).toBe(201);
    const view = res.json() as HitlViewJson;
    expect(view.status).toBe('PENDING');
    expect(view.amount).toBe(60_000); // copied from the escrow — the wire cannot lie
    expect(view.escrowId).toBe('esc_big');
    expect(view.requesterId).toBe('user:buyer');
    expect(view.decidedBy).toBeNull();
  });

  it('refuses creation for small amounts, missing escrows and non-releasable states', async () => {
    await deliveredEscrow(1_000, 'esc_small');
    const small = await built.app.inject({
      method: 'POST',
      url: '/api/v1/hitl',
      headers: ADMIN,
      payload: { kind: 'ESCROW_RELEASE', escrowId: 'esc_small', requesterId: 'user:buyer' },
    });
    expect(small.statusCode).toBe(422);
    expect(small.json().error.code).toBe('HITL_NOT_REQUIRED');

    const ghost = await built.app.inject({
      method: 'POST',
      url: '/api/v1/hitl',
      headers: ADMIN,
      payload: { kind: 'ESCROW_RELEASE', escrowId: 'esc_ghost', requesterId: 'user:buyer' },
    });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('ESCROW_NOT_FOUND');

    // FUNDED (not delivered yet) — premature approval is pointless, fail closed.
    await newUser('user:b2');
    await newUser('user:s2');
    await mint('user:b2', 60_000);
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows', headers: ADMIN, payload: { id: 'esc_funded', buyerId: 'user:b2', sellerId: 'user:s2', amount: 60_000 } });
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows/esc_funded/fund', headers: ADMIN, payload: {} });
    const premature = await built.app.inject({
      method: 'POST',
      url: '/api/v1/hitl',
      headers: ADMIN,
      payload: { kind: 'ESCROW_RELEASE', escrowId: 'esc_funded', requesterId: 'user:b2' },
    });
    expect(premature.statusCode).toBe(422);
    expect(premature.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('duplicate deterministic id is an honest replay, not a second queue entry', async () => {
    await deliveredEscrow(60_000);
    const payload = { id: 'hitl:esc_big:42', kind: 'ESCROW_RELEASE', escrowId: 'esc_big', requesterId: 'user:buyer' };
    const first = await built.app.inject({ method: 'POST', url: '/api/v1/hitl', headers: ADMIN, payload });
    expect(first.statusCode).toBe(201);
    const second = await built.app.inject({ method: 'POST', url: '/api/v1/hitl', headers: ADMIN, payload });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe('hitl:esc_big:42');
    const list = await built.app.inject({ method: 'GET', url: '/api/v1/hitl?status=PENDING', headers: ADMIN });
    expect(list.json().items).toHaveLength(1);
  });

  it('approve settles atomically: seller 54,000 + treasury 6,000 (10%), escrow RELEASED', async () => {
    await deliveredEscrow(60_000);
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/v1/hitl',
      headers: ADMIN,
      payload: { id: 'hitl_1', kind: 'ESCROW_RELEASE', escrowId: 'esc_big', requesterId: 'user:buyer' },
    });
    expect(created.statusCode).toBe(201);

    const approved = await built.app.inject({
      method: 'POST',
      url: '/api/v1/hitl/hitl_1/approve',
      headers: ADMIN,
      payload: { decidedBy: 'admin:owner', note: 'ok' },
    });
    expect(approved.statusCode).toBe(200);
    const body = approved.json();
    expect(body.request.status).toBe('APPROVED');
    expect(body.request.decidedBy).toBe('admin:owner');
    expect(body.escrow.status).toBe('RELEASED');
    expect(body.txId).toBeTypeOf('string');

    // Exact 10% split on the wire.
    const buyer = await built.app.inject({ method: 'GET', url: '/api/v1/accounts/user:buyer/balance' });
    const seller = await built.app.inject({ method: 'GET', url: '/api/v1/accounts/user:seller/balance' });
    const treasury = await built.app.inject({ method: 'GET', url: '/api/v1/economy' });
    expect(buyer.json().balance).toBe(0);
    expect(seller.json().balance).toBe(54_000);
    expect(treasury.json().treasuryBalance).toBe(6_000);
    expect(treasury.json().balanced).toBe(true);

    // Outbox carries the escrow events of the settlement.
    const outbox = await built.prisma.outboxEvent.findMany({ where: { kind: 'EscrowReleased' } });
    expect(outbox).toHaveLength(1);
  });

  it('approve replay returns the original settlement and never pays twice', async () => {
    await deliveredEscrow(60_000);
    await built.app.inject({ method: 'POST', url: '/api/v1/hitl', headers: ADMIN, payload: { id: 'hitl_1', kind: 'ESCROW_RELEASE', escrowId: 'esc_big', requesterId: 'user:buyer' } });
    const first = await built.app.inject({ method: 'POST', url: '/api/v1/hitl/hitl_1/approve', headers: ADMIN, payload: { decidedBy: 'admin:owner' } });
    expect(first.json().replayed).toBe(false);

    const second = await built.app.inject({ method: 'POST', url: '/api/v1/hitl/hitl_1/approve', headers: ADMIN, payload: { decidedBy: 'admin:owner' } });
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().txId).toBe(first.json().txId);
    expect(second.json().escrow.status).toBe('RELEASED');

    const seller = await built.app.inject({ method: 'GET', url: '/api/v1/accounts/user:seller/balance' });
    expect(seller.json().balance).toBe(54_000); // still exactly one settlement
  });

  it('reject leaves the escrow locked and a later approve refuses (already decided)', async () => {
    await deliveredEscrow(60_000);
    await built.app.inject({ method: 'POST', url: '/api/v1/hitl', headers: ADMIN, payload: { id: 'hitl_1', kind: 'ESCROW_RELEASE', escrowId: 'esc_big', requesterId: 'user:buyer' } });
    const rejected = await built.app.inject({ method: 'POST', url: '/api/v1/hitl/hitl_1/reject', headers: ADMIN, payload: { decidedBy: 'admin:owner', note: 'evidence insufficient' } });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().request.status).toBe('REJECTED');
    expect(rejected.json().txId).toBeNull();

    // No money moved.
    const escrow = await built.app.inject({ method: 'GET', url: '/api/v1/escrows/esc_big' });
    expect(escrow.json().status).toBe('DELIVERED');
    const escrowAccount = await built.app.inject({ method: 'GET', url: '/api/v1/accounts/escrow:esc_big/balance' });
    expect(escrowAccount.json().balance).toBe(60_000);

    // approve after reject — refused, and the REJECTED state is untouched.
    const late = await built.app.inject({ method: 'POST', url: '/api/v1/hitl/hitl_1/approve', headers: ADMIN, payload: { decidedBy: 'admin:owner' } });
    expect(late.statusCode).toBe(422);
    expect(late.json().error.code).toBe('HITL_ALREADY_DECIDED');
    expect((await built.app.inject({ method: 'GET', url: '/api/v1/hitl/hitl_1', headers: ADMIN })).json().status).toBe('REJECTED');
  });

  it('sweep expires overdue PENDING requests; expired ones refuse decisions', async () => {
    await deliveredEscrow(60_000);
    await built.app.inject({ method: 'POST', url: '/api/v1/hitl', headers: ADMIN, payload: { id: 'hitl_1', kind: 'ESCROW_RELEASE', escrowId: 'esc_big', requesterId: 'user:buyer', ttlHours: 1 } });
    // Simulate the TTL passing — the sweep, not a clock wait, is under test.
    await built.prisma.hitlRequest.update({ where: { id: 'hitl_1' }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    const sweep = await built.app.inject({ method: 'POST', url: '/api/v1/hitl/sweep', headers: ADMIN, payload: {} });
    expect(sweep.statusCode).toBe(200);
    expect(sweep.json().expired).toBe(1);

    const late = await built.app.inject({ method: 'POST', url: '/api/v1/hitl/hitl_1/approve', headers: ADMIN, payload: { decidedBy: 'admin:owner' } });
    expect(late.statusCode).toBe(422);
    expect(late.json().error.code).toBe('HITL_EXPIRED');
  });

  it('a failed settlement rolls the approval back (atomicity under domain refusal)', async () => {
    await deliveredEscrow(60_000);
    await built.app.inject({ method: 'POST', url: '/api/v1/hitl', headers: ADMIN, payload: { id: 'hitl_1', kind: 'ESCROW_RELEASE', escrowId: 'esc_big', requesterId: 'user:buyer' } });
    // Sabotage: refund the escrow behind the queue's back — the release must fail.
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows/esc_big/dispute', headers: ADMIN, payload: { reason: 'test' } });
    await built.app.inject({ method: 'POST', url: '/api/v1/escrows/esc_big/refund', headers: ADMIN, payload: {} });

    const approved = await built.app.inject({ method: 'POST', url: '/api/v1/hitl/hitl_1/approve', headers: ADMIN, payload: { decidedBy: 'admin:owner' } });
    expect(approved.statusCode).toBe(422);
    expect(approved.json().error.code).toBe('INVALID_TRANSITION');

    // The decision itself rolled back — the request is still PENDING.
    const view = await built.app.inject({ method: 'GET', url: '/api/v1/hitl/hitl_1', headers: ADMIN });
    expect(view.json().status).toBe('PENDING');
    expect(view.json().decidedBy).toBeNull();
  });

  it('is admin-only end to end (fail-closed 401/503 paths)', async () => {
    const noKey = await built.app.inject({ method: 'GET', url: '/api/v1/hitl', headers: JSON_HDR });
    expect(noKey.statusCode).toBe(401);
    const denyCreate = await built.app.inject({ method: 'POST', url: '/api/v1/hitl', headers: JSON_HDR, payload: { kind: 'ESCROW_RELEASE', escrowId: 'x', requesterId: 'user:x' } });
    expect(denyCreate.statusCode).toBe(401);
    const denyApprove = await built.app.inject({ method: 'POST', url: '/api/v1/hitl/hitl_1/approve', headers: JSON_HDR, payload: { decidedBy: 'user:x' } });
    expect(denyApprove.statusCode).toBe(401);
    const denySweep = await built.app.inject({ method: 'POST', url: '/api/v1/hitl/sweep', headers: JSON_HDR, payload: {} });
    expect(denySweep.statusCode).toBe(401);
  });

  it('OpenAPI exposes the six /hitl operations under the hitl tag', async () => {
    const doc = await built.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    const json = doc.json() as { paths: Record<string, Record<string, { tags?: string[] }>> };
    expect(json.paths['/hitl']).toBeDefined();
    expect(json.paths['/hitl/{id}/approve']).toBeDefined();
    expect(json.paths['/hitl/{id}/reject']).toBeDefined();
    expect(json.paths['/hitl/sweep']).toBeDefined();
    expect(json.paths['/hitl']!.post?.tags).toEqual(['hitl']);
  });
});
