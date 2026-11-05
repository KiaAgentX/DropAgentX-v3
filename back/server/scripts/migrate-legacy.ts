/**
 * Legacy migration — the day-one bridge from the recovered Railway DB to v3.
 *
 * Verified legacy facts (genesis audit, مهر ۱۴۰۵ — re-verify anytime):
 *   466 users · 1,554 transactions · Σ stored balances 187,672.8 Đ
 *   legacy tx ledger implied 187,735.8 → gap −63.0 explained 100%
 *     (9×50-credit purchases debited without tx rows = −450,
 *      one manual owner credit without a tx row = +387)
 *
 * v3 representation (ADR-002/003 — integer money, double-entry):
 *   - one account per legacy user: `user:tg:<id>` (all 466, banned or not)
 *   - ONE genesis transaction (idempotency `legacy:genesis:v1`):
 *       mint:genesis  −Σ(floor(credits))          (mint never positive)
 *       user_i        +floor(credits_i)           (per-citizen rounding)
 *     The genesis memo IS the transparent adjustment row (decision #5): it
 *     states exactly why the ledger starts at 187,672 and not 187,735.
 *   - an AuditLog row `legacy.adjustment` carries the itemized −63 gap
 *   - 30 products → Product (deliveryPayload only from `link` — legacy files
 *     lived on the ephemeral Railway disk and are gone forever)
 *
 * Idempotent: a second run detects the genesis idempotency key and exits with
 * the reconciliation report instead of double-minting.
 *
 * Usage:
 *   pnpm -F @dropagentx/server exec tsx scripts/migrate-legacy.ts \
 *     --legacy /path/to/marketplace-20260924-0400.db [--target file:./db/v3.db] [--dry-run]
 */

import { statSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import * as D from '@dropagentx/domain';
import { loadConfig } from '../src/config.js';
import { V3Store } from '../src/persistence.js';

// ── args ─────────────────────────────────────────────────────────────────────

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const legacyPath = argOf('--legacy');
const dryRun = process.argv.includes('--dry-run');
const targetArg = argOf('--target');

if (legacyPath === undefined) {
  console.error('Usage: tsx scripts/migrate-legacy.ts --legacy <legacy.db> [--target <v3.db url>] [--dry-run]');
  process.exit(2);
}
statSync(legacyPath);

process.env.DATABASE_URL = targetArg ?? process.env.DATABASE_URL;
if (process.env.DATABASE_URL === undefined) {
  console.error('No target: pass --target file:./db/v3.db or set DATABASE_URL');
  process.exit(2);
}
console.log(`[m[migrate] legacy = ${legacyPath}`);
console.log(`[m[migrate] target = ${process.env.DATABASE_URL}${dryRun ? ' (dry-run)' : ''}`);

// ── legacy reader (raw SQL — the legacy tables are not v3 models) ────────────

interface LegacyUser {
  user_id: string; // TEXT — legacy ids exceed Int32 (e.g. 5010703739)
  username: string | null;
  first_name: string | null;
  credits: number;
  is_banned: number;
}
interface LegacyProduct {
  id: number;
  creator_id: string; // TEXT — same Int32 overflow as user_id
  title: string;
  description: string | null;
  price_credits: number;
  category: string | null;
  link: string | null;
  is_active: number;
}

async function readLegacy(): Promise<{ users: LegacyUser[]; products: LegacyProduct[]; txCount: number }> {
  const legacy = new PrismaClient({ datasources: { db: { url: `file:${legacyPath}` } } });
  try {
    const users = (await legacy.$queryRawUnsafe<LegacyUser[]>(
      'SELECT CAST(user_id AS TEXT) AS user_id, username, first_name, credits, is_banned FROM users ORDER BY user_id',
    )).map((u) => ({ ...u, credits: Number(u.credits) }));
    const products = (await legacy.$queryRawUnsafe<LegacyProduct[]>(
      'SELECT CAST(id AS TEXT) AS id, CAST(creator_id AS TEXT) AS creator_id, title, description, price_credits, category, link, is_active FROM products ORDER BY id',
    )).map((p) => ({ ...p, price_credits: Number(p.price_credits) }));
    const txCount = (await legacy.$queryRawUnsafe<{ c: number }[]>('SELECT COUNT(*) as c FROM transactions'))[0]?.c ?? 0;
    return { users, products, txCount: Number(txCount) };
  } finally {
    await legacy.$disconnect();
  }
}

// ── reconciliation report (also the Phase-6 acceptance proof) ────────────────

async function reconcile(store: V3Store, prisma: PrismaClient, productCount: number): Promise<string> {
  const accounts = await store.listAccountsWithBalances();
  const users = accounts.filter((a) => a.id.startsWith('user:'));
  const sumUsers = users.reduce((a, u) => a + u.balance, 0);
  const economy = await store.economySummary();
  const products = await prisma.product.count();
  const audits = await prisma.auditLog.count({ where: { action: 'legacy.adjustment' } });
  return [
    `  Σ user wallets        = ${sumUsers} Đ  (acceptance: 187,672)`,
    `  trialBalance.balanced = ${economy.balanced} (Σ postings ${economy.trialBalanceSum})`,
    `  accounts              = ${accounts.length} (${users.length} users + system)`,
    `  products              = ${products}/${productCount}`,
    `  adjustment rows       = ${audits}`,
  ].join('\n');
}

// ── migration ────────────────────────────────────────────────────────────────

const GENESIS_KEY = 'legacy:genesis:v1';

async function main(): Promise<void> {
  const { users, products, txCount } = await readLegacy();
  const sumCredits = users.reduce((a, u) => a + u.credits, 0);
  const perCitizen = users.map((u) => ({ ...u, din: Math.floor(u.credits) }));
  const sumDin = perCitizen.reduce((a, u) => a + u.din, 0);
  const banned = users.filter((u) => u.is_banned === 1).length;

  console.log(`[m[migrate] legacy users: ${users.length} (banned ${banned}) · Σ credits ${sumCredits.toFixed(1)} Đ · tx rows ${txCount}`);
  console.log(`[m[migrate] per-citizen floor: Σ ${sumDin} Đ across ${perCitizen.filter((u) => u.din > 0).length} holder(s)`);
  console.log(`[m[migrate] legacy products: ${products.length}`);

  const config = loadConfig();
  const prisma = new PrismaClient();
  const store = new V3Store(prisma);
  await store.ensureSystemAccounts();

  const existing = await prisma.tx.findFirst({ where: { idempotencyKey: GENESIS_KEY } });
  if (existing !== null) {
    console.log('[m[migrate] genesis already present — replay-safe exit.');
    console.log(await reconcile(store, prisma, products.length));
    await prisma.$disconnect();
    return;
  }

  const memo =
    `legacy genesis — Σ held ${sumDin} Đ (floor per citizen from ${sumCredits.toFixed(1)}) — ` +
    `legacy tx log implied 187,735.8; stored balances 187,672.8; gap −63.0 resolved: ` +
    `9×50 purchases without tx rows (−450) + manual owner credit (+387) — genesis audit ۱۴۰۵`;

  if (dryRun) {
    console.log('[m[migrate] dry-run — no writes. Plan:');
    console.log(`  accounts: ${users.length} user account(s) + 4 system accounts`);
    console.log(`  genesis tx: mint:genesis −${sumDin} → ${perCitizen.filter((u) => u.din > 0).length} user posting(s)`);
    console.log(`  products: ${products.length} row(s)`);
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const u of perCitizen) {
      await tx.account.upsert({
        where: { id: `user:tg:${u.user_id}` },
        create: {
          id: `user:tg:${u.user_id}`,
          kind: 'user',
          label: u.username ?? u.first_name ?? `tg:${u.user_id}`,
        },
        update: {},
      });
    }

    await tx.tx.create({
      data: {
        id: 'tx_legacy_genesis',
        idempotencyKey: GENESIS_KEY,
        memo,
        at: new Date(),
        postings: {
          create: [
            { accountId: D.MINT_ACCOUNT_ID, amount: -sumDin },
            ...perCitizen.filter((u) => u.din > 0).map((u) => ({ accountId: `user:tg:${u.user_id}`, amount: u.din })),
          ],
        },
      },
    });

    await tx.auditLog.create({
      data: {
        actor: 'legacy-migration',
        action: 'legacy.adjustment',
        target: 'ledger',
        meta: JSON.stringify({
          legacyUsers: users.length,
          legacyTransactions: txCount,
          storedBalanceSum: sumCredits,
          perCitizenGenesis: sumDin,
          impliedByLegacyLedger: 187735.8,
          gap: -63.0,
          gapItemization: '9×50 purchases without tx rows (−450) + manual owner credit (+387)',
          source: 'marketplace-20260924-0400.db',
        }),
      },
    });

    for (const p of products) {
      await tx.product.upsert({
        where: { id: `legacy-${p.id}` },
        create: {
          id: `legacy-${p.id}`,
          sellerId: `user:tg:${p.creator_id}`,
          title: p.title.slice(0, 120),
          description: (p.description ?? '').slice(0, 800),
          priceDin: Math.floor(p.price_credits),
          ...(p.category !== null ? { category: p.category.slice(0, 60) } : {}),
          ...(p.link !== null && p.link.length > 0 ? { deliveryPayload: p.link } : {}),
          active: p.is_active === 1,
        },
        update: {},
      });
    }
  });

  console.log('[m[migrate] done.');
  console.log(await reconcile(store, prisma, products.length));
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error('[m[migrate] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
