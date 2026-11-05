/**
 * Nation genesis proof — v3 edition.
 *
 * An EXTERNAL audit: plain SQL against the target SQLite, deliberately not
 * going through Prisma or the domain, so the numbers cannot inherit bugs from
 * the code they audit. Same spirit as the legacy nation-genesis-proof.py.
 *
 * Prints: Σ user wallets (must equal the genesis supply 187,672 Đ),
 * Σ all postings (must be 0 — double-entry closure), and the mint/burn
 * balances. Exit code 1 on any violated expectation.
 *
 * Usage: tsx scripts/genesis-proof.ts [--db file:./db/v3-migrated.db]
 */

import { statSync } from 'node:fs';
import Database from 'better-sqlite3';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let dbPath = argOf('--db');
if (dbPath === undefined) {
  dbPath = process.env.DATABASE_URL;
  if (dbPath === undefined) {
    console.error('Usage: tsx scripts/genesis-proof.ts --db file:./db/v3.db (or DATABASE_URL)');
    process.exit(2);
  }
}
const file = dbPath.replace(/^file:/, '');
statSync(file);

const db = new Database(file, { readonly: true });
const accounts = db
  .prepare("SELECT id, kind FROM Account ORDER BY id")
  .all() as { id: string; kind: string }[];
const sums = new Map<string, number>();
for (const row of db.prepare('SELECT accountId, SUM(amount) AS s FROM Posting GROUP BY accountId').all() as { accountId: string; s: number }[]) {
  sums.set(row.accountId, row.s);
}

const userRows = accounts.filter((a) => a.id.startsWith('user:'));
const sumUsers = userRows.reduce((acc, a) => acc + (sums.get(a.id) ?? 0), 0);
const sumAll = [...sums.values()].reduce((acc, v) => acc + v, 0);
const mint = sums.get('mint:genesis') ?? 0;
const treasury = sums.get('treasury:nation') ?? 0;
const burn = sums.get('burn:void') ?? 0;
const escrows = accounts.filter((a) => a.kind === 'escrow');
const escrowLocked = escrows.reduce((acc, a) => acc + (sums.get(a.id) ?? 0), 0);
const genesisTx = db
  .prepare("SELECT id, memo FROM Tx WHERE idempotencyKey = 'legacy:genesis:v1'")
  .get() as { id: string; memo: string } | undefined;
const holders = userRows.filter((a) => (sums.get(a.id) ?? 0) > 0).length;

const EXPECTED_SUPPLY = 187_672;

const lines = [
  '══════════ nation genesis proof — v3 ══════════',
  `database                 : ${file}`,
  `accounts                 : ${accounts.length} (${userRows.length} users, ${escrows.length} escrow, system ${accounts.length - userRows.length - escrows.length})`,
  `funded wallets           : ${holders}`,
  `Σ user wallets           : ${sumUsers} Đ   expected ${EXPECTED_SUPPLY} Đ`,
  `Σ all postings           : ${sumAll}    expected 0 (double-entry closure)`,
  `mint:genesis balance     : ${mint} Đ   (never positive)`,
  `treasury:nation balance  : ${treasury} Đ`,
  `burn:void balance        : ${burn} Đ   (never negative)`,
  `escrow locked            : ${escrowLocked} Đ`,
  `genesis tx               : ${genesisTx?.id ?? 'MISSING'}`,
  genesisTx !== undefined ? `  memo: ${genesisTx.memo.slice(0, 160)}…` : '  (no legacy genesis row — fresh ledger?)',
  '',
];

const problems: string[] = [];
if (sumUsers !== EXPECTED_SUPPLY) problems.push(`Σ user wallets ${sumUsers} ≠ ${EXPECTED_SUPPLY}`);
if (sumAll !== 0) problems.push(`Σ all postings ${sumAll} ≠ 0`);
if (mint > 0) problems.push(`mint:genesis positive (${mint})`);
if (burn < 0) problems.push(`burn:void negative (${burn})`);
if (genesisTx === undefined) problems.push('legacy genesis transaction missing');

for (const line of lines) console.log(line);
if (problems.length === 0) {
  console.log('PROOF OK — every expectation holds.');
  process.exit(0);
}
console.log(`PROOF FAILED — ${problems.join(' · ')}`);
process.exit(1);
