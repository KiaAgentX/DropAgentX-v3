/**
 * Phase-4 acceptance — the dashboard's EXACT client wrapper against the REAL
 * server (Fastify + Prisma + SQLite + the pure domain). app.inject() backs a
 * FetchLike, so no socket is opened; everything else is production-shaped.
 *
 * Proves: ADR-005 loop closed from the dashboard side — economy numbers,
 * full escrow lifecycle, idempotent replay, the HITL gate ≥ 50,000 Đ, and
 * fail-closed auth all read correctly through createDashboardClient.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '@dropagentx/contracts';
import { buildApp, type BuiltApp } from '@dropagentx/server';
import { createDashboardClient, errorKey } from '../src/lib/api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, '..', '..', 'server');
const tmp = mkdtempSync(path.join(tmpdir(), 'v3-dash-'));
process.env.DATABASE_URL = `file:${path.join(tmp, 'v3-dash-test.db')}`;

function makeInjectFetch(getBuilt: () => BuiltApp): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    const body = init?.body;
    const res = await getBuilt().app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: `${url.pathname}${url.search}`,
      ...(typeof body === 'string' ? { payload: body } : {}),
      headers: init?.headers === undefined ? {} : Object.fromEntries(new Headers(init.headers).entries()),
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
    return new Response(res.payload, { status: res.statusCode, headers });
  };
}

const ADMIN_KEY = 'v3-dashboard-test-key-0123456789';

let built: BuiltApp;
let client: ReturnType<typeof createDashboardClient>;

beforeAll(async () => {
  execSync('pnpm exec prisma db push --skip-generate', { cwd: serverDir, env: process.env, stdio: 'pipe' });
  built = await buildApp({ adminKey: ADMIN_KEY, botToken: undefined, devAuth: false, port: 8787, rateLimitPerMin: 100_000 });
  const injectFetch: FetchLike = makeInjectFetch(() => built);
  client = createDashboardClient({ baseUrl: 'http://test.local/api/v1', adminKey: ADMIN_KEY, fetchImpl: injectFetch });
});

afterAll(async () => {
  await built.app.close();
  await built.prisma.$disconnect();
});

describe('phase 4 — dashboard client ↔ real server round-trip', () => {
  it('reads health through the typed client', async () => {
    const res = await client.health();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe('ok');
      expect(res.value.service).toBe('dropagentx-v3-server');
    }
  });

  it('shows a fresh economy snapshot (charter constants visible, ledger balanced)', async () => {
    const res = await client.economy();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.genesisSupply).toBe(187_672);
      expect(res.value.yearlyMintCap).toBe(1_000_000);
      expect(res.value.balanced).toBe(true);
      expect(res.value.trialBalanceSum).toBe(0);
      expect(res.value.circulatingSupply).toBe(0);
    }
  });

  it('drives the full escrow lifecycle: mint → create → fund → deliver → release = 90/10', async () => {
    expect((await client.createAccount({ id: 'user:buy:1', label: 'buyer' })).ok).toBe(true);
    expect((await client.createAccount({ id: 'user:sell:1', label: 'seller' })).ok).toBe(true);

    const mint = await client.mint({ accountId: 'user:buy:1', amount: 1_000, memo: 'dashboard e2e genesis' });
    expect(mint.ok).toBe(true);

    const created = await client.createEscrow({ id: 'escrow:dash:1', buyerId: 'user:buy:1', sellerId: 'user:sell:1', amount: 100, productRef: 'test-product' });
    expect(created.ok).toBe(true);
    expect((await client.fundEscrow('escrow:dash:1', { idempotencyKey: 'dash:fund:escrow:dash:1' })).ok).toBe(true);
    expect((await client.deliverEscrow('escrow:dash:1', { deliveryRef: 'dash:proof', idempotencyKey: 'dash:deliver:escrow:dash:1' })).ok).toBe(true);
    const release = await client.releaseEscrow('escrow:dash:1', { idempotencyKey: 'dash:release:escrow:dash:1' });
    expect(release.ok).toBe(true);
    if (release.ok) {
      expect(release.value.escrow.status).toBe('RELEASED');
      expect(release.value.txId).not.toBeNull();
    }

    const balances = await client.listAccounts();
    expect(balances.ok).toBe(true);
    if (balances.ok) {
      const byId = new Map(balances.value.items.map((a) => [a.id, a.balance]));
      expect(byId.get('user:sell:1')).toBe(90);
      expect(byId.get('treasury:nation')).toBe(10);
      expect(byId.get('user:buy:1')).toBe(900); // spent exactly 100 of the 1,000 minted
    }

    const economy = await client.economy();
    expect(economy.ok).toBe(true);
    if (economy.ok) {
      expect(economy.value.circulatingSupply).toBe(1_000);
      expect(economy.value.treasuryBalance).toBe(10);
      expect(economy.value.escrowLocked).toBe(0);
      expect(economy.value.balanced).toBe(true);
    }
  });

  it('replays the same release idempotency key as a no-op — no double pay', async () => {
    const before = await client.economy();
    const replay = await client.releaseEscrow('escrow:dash:1', { idempotencyKey: 'dash:release:escrow:dash:1' });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.replayed).toBe(true);
    const after = await client.economy();
    if (before.ok && after.ok) expect(after.value.treasuryBalance).toBe(before.value.treasuryBalance);
  });

  it('burn beyond balance fails closed with the domain code', async () => {
    const res = await client.burn({ accountId: 'user:buy:1', amount: 901 }); // balance is 900
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('ACCOUNT_OVERDRAFT');
      expect(errorKey(res.error)).toBe('err.ACCOUNT_OVERDRAFT');
    }
  });

  it('refuses a release ≥ 50,000 Đ without human approval — and the HITL queue settles it 90/10', async () => {
    // big buyer
    expect((await client.createAccount({ id: 'user:buy:big' })).ok).toBe(true);
    expect((await client.createAccount({ id: 'user:sell:big' })).ok).toBe(true);
    expect((await client.mint({ accountId: 'user:buy:big', amount: 100_000, memo: 'hitl e2e' })).ok).toBe(true);
    expect(
      (await client.createEscrow({ id: 'escrow:dash:big', buyerId: 'user:buy:big', sellerId: 'user:sell:big', amount: 60_000 })).ok,
    ).toBe(true);
    expect((await client.fundEscrow('escrow:dash:big', { idempotencyKey: 'dash:fund:escrow:dash:big' })).ok).toBe(true);
    expect((await client.deliverEscrow('escrow:dash:big', { idempotencyKey: 'dash:deliver:escrow:dash:big' })).ok).toBe(true);

    // direct release is refused by the domain (Article 7)
    const direct = await client.releaseEscrow('escrow:dash:big', { idempotencyKey: 'dash:release:escrow:dash:big' });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.error.code).toBe('REQUIRES_HUMAN_APPROVAL');

    // queue → approve → settle atomically
    const queued = await client.createHitlRequest({
      kind: 'ESCROW_RELEASE',
      escrowId: 'escrow:dash:big',
      requesterId: 'user:sell:big',
      note: 'dashboard e2e',
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const hitlId = queued.value.id;

    const pending = await client.listHitl('PENDING');
    expect(pending.ok).toBe(true);
    if (pending.ok) expect(pending.value.items.some((i) => i.id === hitlId)).toBe(true);

    const approved = await client.approveHitl(hitlId, { decidedBy: 'admin:dashboard', note: 'e2e' });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.value.request.status).toBe('APPROVED');
      expect(approved.value.escrow?.status).toBe('RELEASED');
      expect(approved.value.txId).not.toBeNull();
    }

    const balances = await client.listAccounts();
    expect(balances.ok).toBe(true);
    if (balances.ok) {
      const byId = new Map(balances.value.items.map((a) => [a.id, a.balance]));
      expect(byId.get('user:sell:big')).toBe(54_000); // 90% of 60,000
      expect(byId.get('treasury:nation')).toBe(6_010); // 10 + 10% of 60,000
    }
  });

  it('a guest session (no key) is fail-closed on admin endpoints', async () => {
    const guest = createDashboardClient({ baseUrl: 'http://test.local/api/v1', adminKey: null, fetchImpl: makeInjectFetch(() => built) });
    const res = await guest.listAccounts();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.status).toBe(401);
      expect(res.error.code).toBe('ADMIN_KEY_REQUIRED');
    }
    // public transparency still works without a key
    const eco = await guest.economy();
    expect(eco.ok).toBe(true);
  });
});
