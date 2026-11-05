/**
 * seed-demo.ts — load a rich, coherent demo dataset into a v3 database so the
 * dashboard (and the screenshots in docs/screenshots/) show every escrow state,
 * every account role and a live HITL queue instead of empty tables.
 *
 * Replay-safe by construction (the same discipline as the domain):
 *   - fixed account / escrow / HITL ids      → duplicates are skipped
 *   - fixed idempotency keys on every move   → re-running never double-spends
 *   - invalid transitions on re-run          → treated as "already done"
 *
 * Usage (server must be running):
 *   BASE_URL=http://127.0.0.1:8787/api/v1 KIA_ADMIN_KEY=<key> \
 *     pnpm -F @dropagentx/server exec tsx scripts/seed-demo.ts
 *
 * Charter budget: mints 260,000 Đ total (well under the 1,000,000 Đ yearly cap).
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787/api/v1';
const KEY = process.env.KIA_ADMIN_KEY ?? '';
if (KEY === '') {
  console.error('[seed] KIA_ADMIN_KEY is required');
  process.exit(1);
}

interface Err {
  error: { code: string; message: string };
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ ok: true; value: T } | { ok: false; code: string; message: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-kia-key': KEY,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return { ok: false, code: 'MALFORMED', message: text.slice(0, 160) };
  }
  if (!res.ok) {
    const e = payload as Err | null;
    return {
      ok: false,
      code: e?.error?.code ?? `HTTP_${res.status}`,
      message: e?.error?.message ?? text.slice(0, 160),
    };
  }
  return { ok: true, value: payload as T };
}

/** Run a step; "already happened" codes are success for a replay-safe seed. */
async function step(label: string, p: Promise<{ ok: unknown; code?: string; message?: string }>): Promise<void> {
  const r = await p;
  const benign = new Set([
    'DUPLICATE_ACCOUNT',
    'ESCROW_ALREADY_EXISTS',
    'INVALID_TRANSITION',
    'HITL_ALREADY_DECIDED',
    'REQUIRES_HUMAN_APPROVAL', // release already gated — the HITL request exists
  ]);
  if (r.ok) console.log(`[seed] ok      ${label}`);
  else if (r.code !== undefined && benign.has(r.code)) console.log(`[seed] replay  ${label} (${r.code})`);
  else {
    console.error(`[seed] FAIL    ${label} — ${r.code}: ${r.message}`);
    process.exit(1);
  }
}

const ACCOUNTS = [
  { id: 'user:tg:1001', label: 'Sara — buyer (Telegram 1001)' },
  { id: 'user:tg:2002', label: 'Kiana — seller (Telegram 2002)' },
  { id: 'user:tg:3003', label: 'Navid — buyer (Telegram 3003)' },
  { id: 'user:tg:4004', label: 'Sahar — seller (Telegram 4004)' },
] as const;

const MINTS = [
  { accountId: 'user:tg:1001', amount: 120_000, memo: 'demo wallet top-up' },
  { accountId: 'user:tg:2002', amount: 40_000, memo: 'demo wallet top-up' },
  { accountId: 'user:tg:3003', amount: 100_000, memo: 'demo wallet top-up' },
  { accountId: 'user:tg:4004', amount: 25_000, memo: 'demo wallet top-up' },
] as const;

interface EscrowSeed {
  id: string;
  buyerId: string;
  sellerId: string;
  amount: number;
  productRef: string;
  path: 'CREATED' | 'FUNDED' | 'DELIVERED' | 'RELEASED' | 'DISPUTED' | 'CANCELLED' | 'EXPIRED' | 'HITL_PENDING' | 'HITL_APPROVED';
  disputeReason?: string;
}

const ESCROWS: EscrowSeed[] = [
  { id: 'esc-demo-001', buyerId: 'user:tg:1001', sellerId: 'user:tg:2002', amount: 12_000, productRef: 'لپ‌تاپ دست دوم', path: 'CREATED' },
  { id: 'esc-demo-002', buyerId: 'user:tg:1001', sellerId: 'user:tg:2002', amount: 6_500, productRef: 'پکیج آموزش زبان', path: 'FUNDED' },
  { id: 'esc-demo-003', buyerId: 'user:tg:3003', sellerId: 'user:tg:2002', amount: 18_000, productRef: 'کنسول بازی دست دوم', path: 'DELIVERED' },
  { id: 'esc-demo-004', buyerId: 'user:tg:3003', sellerId: 'user:tg:4004', amount: 2_500, productRef: 'کتاب صوتی', path: 'RELEASED' },
  { id: 'esc-demo-005', buyerId: 'user:tg:1001', sellerId: 'user:tg:4004', amount: 9_000, productRef: 'هدفون بی‌سیم', path: 'DISPUTED', disputeReason: 'کالا ناقص به دست رسید — دو تکه شکسته بود' },
  { id: 'esc-demo-006', buyerId: 'user:tg:4004', sellerId: 'user:tg:2002', amount: 4_000, productRef: 'کتاب دیجیتال', path: 'CANCELLED' },
  { id: 'esc-demo-007', buyerId: 'user:tg:3003', sellerId: 'user:tg:2002', amount: 5_200, productRef: 'ساعت هوشمند', path: 'EXPIRED' },
  { id: 'esc-demo-008', buyerId: 'user:tg:1001', sellerId: 'user:tg:2002', amount: 60_000, productRef: 'لپ‌تاپ گیمینگ', path: 'HITL_PENDING' },
  { id: 'esc-demo-009', buyerId: 'user:tg:3003', sellerId: 'user:tg:4004', amount: 55_000, productRef: 'دوربین DSLR', path: 'HITL_APPROVED' },
];

async function main(): Promise<void> {
  console.log(`[seed] target ${BASE}`);

  for (const a of ACCOUNTS) {
    await step(`account ${a.id}`, call('POST', '/accounts', { id: a.id, label: a.label }));
  }
  let i = 0;
  for (const m of MINTS) {
    i += 1;
    await step(`mint ${m.amount} → ${m.accountId}`, call('POST', '/wallet/mint', { ...m, idempotencyKey: `seed-mint-${i}` }));
  }

  for (const e of ESCROWS) {
    const common = { id: e.id, buyerId: e.buyerId, sellerId: e.sellerId, amount: e.amount, productRef: e.productRef };
    await step(`escrow ${e.id} create`, call('POST', '/escrows', common));
    if (e.path !== 'CREATED' && e.path !== 'CANCELLED') {
      await step(`escrow ${e.id} fund`, call('POST', `/escrows/${e.id}/fund`, { idempotencyKey: `seed-fund-${e.id}` }));
    }
    if (e.path === 'DELIVERED' || e.path === 'RELEASED' || e.path === 'HITL_PENDING' || e.path === 'HITL_APPROVED') {
      await step(`escrow ${e.id} deliver`, call('POST', `/escrows/${e.id}/deliver`, { idempotencyKey: `seed-deliver-${e.id}` }));
    }
    if (e.path === 'RELEASED') {
      await step(`escrow ${e.id} release (below HITL)`, call('POST', `/escrows/${e.id}/release`, { idempotencyKey: `seed-release-${e.id}` }));
    }
    if (e.path === 'DISPUTED') {
      await step(`escrow ${e.id} dispute`, call('POST', `/escrows/${e.id}/dispute`, { reason: e.disputeReason ?? 'demo dispute', idempotencyKey: `seed-dispute-${e.id}` }));
    }
    if (e.path === 'CANCELLED') {
      await step(`escrow ${e.id} cancel`, call('POST', `/escrows/${e.id}/cancel`, { idempotencyKey: `seed-cancel-${e.id}` }));
    }
    if (e.path === 'EXPIRED') {
      await step(`escrow ${e.id} expire`, call('POST', `/escrows/${e.id}/expire`, { idempotencyKey: `seed-expire-${e.id}` }));
    }
    if (e.path === 'HITL_PENDING' || e.path === 'HITL_APPROVED') {
      // ≥ 50,000 Đ → the release attempt is refused until a human approves (Article 7).
      const rel = await call('POST', `/escrows/${e.id}/release`, { idempotencyKey: `seed-release-${e.id}` });
      if (!rel.ok && rel.code === 'REQUIRES_HUMAN_APPROVAL') {
        console.log(`[seed] ok      escrow ${e.id} release gated by HITL (threshold respected)`);
        await step(`hitl hitl-demo-${e.id} create`, call('POST', '/hitl', {
          id: `hitl-demo-${e.id}`,
          kind: 'ESCROW_RELEASE',
          escrowId: e.id,
          requesterId: e.buyerId,
          note: `تسویه ${e.productRef} — مبلغ ${e.amount} Đ (بالای آستانه ۵۰٬۰۰۰)`,
        }));
        if (e.path === 'HITL_APPROVED') {
          await step(`hitl hitl-demo-${e.id} approve`, call('POST', `/hitl/hitl-demo-${e.id}/approve`, { decidedBy: 'owner:demo', note: 'owner approved via demo seed' }));
        }
      } else if (rel.ok) {
        console.log(`[seed] ok      escrow ${e.id} released directly (already approved on a previous run)`);
      } else if (rel.code === 'INVALID_TRANSITION') {
        console.log(`[seed] replay  escrow ${e.id} already settled`);
      } else {
        console.error(`[seed] FAIL    escrow ${e.id} release — ${rel.code}: ${rel.message}`);
        process.exit(1);
      }
    }
  }

  const econ = await call<{
    circulatingSupply: number;
    treasuryBalance: number;
    escrowLocked: number;
    mintedAllTime: number;
    balanced: boolean;
    trialBalanceSum: number;
    accountCount: number;
    openEscrows: number;
  }>('GET', '/economy');
  if (!econ.ok) {
    console.error(`[seed] FAIL    economy check — ${econ.code}`);
    process.exit(1);
  }
  const s = econ.value;
  console.log(
    `[seed] economy: minted ${s.mintedAllTime} Đ | circulating ${s.circulatingSupply} Đ | ` +
      `escrow locked ${s.escrowLocked} Đ | treasury ${s.treasuryBalance} Đ | ` +
      `accounts ${s.accountCount} | open escrows ${s.openEscrows} | balanced ${s.balanced} (Σ ${s.trialBalanceSum})`,
  );
  if (!s.balanced) {
    console.error('[seed] FAIL — ledger is not balanced; this demo seed must never break Σ = 0');
    process.exit(1);
  }
  console.log('[seed] DONE — demo dataset ready.');
}

void main();
