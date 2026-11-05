import { describe, expect, it } from 'vitest';

import { unwrap } from '../errors.js';
import {
  addAccount,
  balanceOf,
  BURN_ACCOUNT_ID,
  circulatingSupply,
  isOverdraftViolation,
  MINT_ACCOUNT_ID,
  openLedger,
  post,
  TREASURY_ACCOUNT_ID,
  trialBalance,
  type LedgerState,
} from '../ledger.js';

const MINT = MINT_ACCOUNT_ID;
const TREASURY = TREASURY_ACCOUNT_ID;
const BURN = BURN_ACCOUNT_ID;

function newLedger(): LedgerState {
  let l = openLedger();
  l = unwrap(addAccount(l, { id: MINT, kind: 'mint' }));
  l = unwrap(addAccount(l, { id: TREASURY, kind: 'treasury' }));
  l = unwrap(addAccount(l, { id: BURN, kind: 'burn' }));
  l = unwrap(addAccount(l, { id: 'user:buyer', kind: 'user', label: 'خریدار' }));
  l = unwrap(addAccount(l, { id: 'user:seller', kind: 'user', label: 'فروشنده' }));
  l = unwrap(addAccount(l, { id: 'user:c', kind: 'user' }));
  return l;
}

function mintTo(state: LedgerState, accountId: string, amount: number): LedgerState {
  const r = post(state, {
    postings: [
      { accountId: MINT, amount: -amount },
      { accountId, amount },
    ],
    memo: `mint ${amount} → ${accountId}`,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.state;
}

describe('ledger — ADR-003 (immutable double-entry, fail-closed)', () => {
  it('opens empty and keeps accounts unique', () => {
    const l = newLedger();
    expect(trialBalance(l).sum).toBe(0);
    const dup = addAccount(l, { id: MINT, kind: 'mint' });
    expect(dup.ok).toBe(false);
  });

  it('mints supply and keeps conservation (Σ balances = 0)', () => {
    let l = newLedger();
    l = mintTo(l, 'user:buyer', 1_000);
    expect(unwrap(balanceOf(l, 'user:buyer'))).toBe(1_000);
    expect(unwrap(balanceOf(l, MINT))).toBe(-1_000);
    const tb = trialBalance(l);
    expect(tb.balanced).toBe(true);
    expect(circulatingSupply(l)).toBe(1_000);
  });

  it('rejects unbalanced transactions', () => {
    const l = newLedger();
    const r = post(l, {
      postings: [
        { accountId: 'user:buyer', amount: 10 },
        { accountId: 'user:seller', amount: 5 },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('UNBALANCED_TRANSACTION');
      expect(r.error.meta?.['sum']).toBe(15);
    }
  });

  it('rejects single-posting transactions', () => {
    const l = newLedger();
    const r = post(l, { postings: [{ accountId: 'user:buyer', amount: 10 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TOO_FEW_POSTINGS');
  });

  it('rejects unknown accounts and non-integer postings', () => {
    const l = newLedger();
    const unknown = post(l, {
      postings: [
        { accountId: 'user:buyer', amount: -10 },
        { accountId: 'user:ghost', amount: 10 },
      ],
    });
    expect(unknown.ok).toBe(false);
    const fractional = post(l, {
      postings: [
        { accountId: 'user:buyer', amount: -10.5 },
        { accountId: 'user:seller', amount: 10.5 },
      ],
    });
    expect(fractional.ok).toBe(false);
  });

  it('never lets a user go negative (fail-closed overdraft)', () => {
    let l = newLedger();
    l = mintTo(l, 'user:buyer', 500);
    const r = post(l, {
      postings: [
        { accountId: 'user:buyer', amount: -600 },
        { accountId: 'user:seller', amount: 600 },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ACCOUNT_OVERDRAFT');
      expect(r.error.meta?.['newBalance']).toBe(-100);
    }
    // state untouched after failure
    expect(unwrap(balanceOf(l, 'user:buyer'))).toBe(500);
    expect(unwrap(balanceOf(l, 'user:seller'))).toBe(0);
  });

  it('enforces direction rules: mint cannot gain, burn cannot lose', () => {
    let l = newLedger();
    l = mintTo(l, 'user:buyer', 1_000);
    expect(unwrap(balanceOf(l, MINT))).toBe(-1_000);
    // a credit that would push mint above zero is rejected (mint rule checked first by insertion order)
    const badMint = post(l, {
      postings: [
        { accountId: 'user:buyer', amount: -1_100 },
        { accountId: MINT, amount: 1_100 },
      ],
    });
    expect(badMint.ok).toBe(false);
    if (!badMint.ok) {
      expect(badMint.error.code).toBe('ACCOUNT_OVERDRAFT');
      expect(badMint.error.meta?.['accountId']).toBe(MINT);
    }
    // burn receiving is fine
    const burnOk = post(l, {
      postings: [
        { accountId: 'user:buyer', amount: -100 },
        { accountId: BURN, amount: 100 },
      ],
    });
    expect(burnOk.ok).toBe(true);
    expect(isOverdraftViolation('mint', 1)).toBe(true);
    expect(isOverdraftViolation('burn', -1)).toBe(true);
    expect(isOverdraftViolation('user', -1)).toBe(true);
    expect(isOverdraftViolation('escrow', -1)).toBe(true);
    expect(isOverdraftViolation('treasury', -1)).toBe(true);
    expect(isOverdraftViolation('mint', -1)).toBe(false);
    expect(isOverdraftViolation('burn', 1)).toBe(false);
  });

  it('replays idempotently: same key → same tx, state untouched', () => {
    let l = newLedger();
    l = mintTo(l, 'user:buyer', 500);
    const cmd = {
      idempotencyKey: 'order:42:settle',
      postings: [
        { accountId: 'user:buyer', amount: -100 },
        { accountId: 'user:seller', amount: 100 },
      ],
      memo: 'pay order 42',
    };
    const first = unwrap(post(l, cmd));
    expect(first.replayed).toBe(false);
    const second = unwrap(post(first.state, cmd));
    expect(second.replayed).toBe(true);
    expect(second.tx.id).toBe(first.tx.id);
    expect(second.state).toBe(first.state); // identical immutable state reference
    expect(unwrap(balanceOf(second.state, 'user:buyer'))).toBe(400);
    expect(unwrap(balanceOf(second.state, 'user:seller'))).toBe(100);
  });

  it('does not dedupe postings that lack an idempotency key', () => {
    let l = newLedger();
    l = mintTo(l, 'user:buyer', 500);
    const postings = [
      { accountId: 'user:buyer', amount: -10 },
      { accountId: 'user:seller', amount: 10 },
    ];
    l = unwrap(post(l, { postings })).state;
    l = unwrap(post(l, { postings })).state;
    expect(unwrap(balanceOf(l, 'user:seller'))).toBe(20);
  });

  it('assigns unique transaction ids', () => {
    let l = newLedger();
    l = mintTo(l, 'user:buyer', 100);
    const r1 = unwrap(post(l, { postings: [
      { accountId: 'user:buyer', amount: -1 },
      { accountId: 'user:seller', amount: 1 },
    ] }));
    const r2 = unwrap(post(r1.state, { postings: [
      { accountId: 'user:buyer', amount: -1 },
      { accountId: 'user:seller', amount: 1 },
    ] }));
    expect(r1.tx.id).not.toBe(r2.tx.id);
    expect(r2.tx.id).not.toBe('tx_1');
  });

  it('survives 300 seeded random operations with conservation intact', () => {
    let l = newLedger();
    for (const u of ['user:buyer', 'user:seller', 'user:c']) l = mintTo(l, u, 300);
    const rand = mulberry32(1405);
    const users = ['user:buyer', 'user:seller', 'user:c'];
    let mintedExtra = 0;
    let burnedTotal = 0;
    for (let i = 0; i < 300; i++) {
      const from = users[Math.floor(rand() * users.length)] as string;
      let to = users[Math.floor(rand() * users.length)] as string;
      if (to === from) to = 'user:seller';
      const amount = 1 + Math.floor(rand() * 50);
      const roll = rand();
      const postings =
        roll < 0.6
          ? [
              { accountId: from, amount: -amount },
              { accountId: to, amount },
            ]
          : roll < 0.8
            ? [
                { accountId: from, amount: -amount },
                { accountId: BURN, amount },
              ]
            : [
                { accountId: MINT, amount: -amount },
                { accountId: to, amount },
              ];
      const r = post(l, { postings, memo: `seeded op ${i}` });
      if (r.ok) {
        l = r.value.state;
        expect(trialBalance(l).balanced, `op ${i} broke conservation`).toBe(true);
        if (roll >= 0.8) mintedExtra += amount;
        if (roll >= 0.6 && roll < 0.8) burnedTotal += amount;
      } else {
        // failing ops must be policy failures, never conservation breakers
        expect(['ACCOUNT_OVERDRAFT', 'UNKNOWN_ACCOUNT', 'UNBALANCED_TRANSACTION']).toContain(r.error.code);
      }
    }
    expect(trialBalance(l).balanced).toBe(true);
    expect(circulatingSupply(l)).toBe(900 + mintedExtra - burnedTotal);
  });
});

/** Deterministic PRNG so the random-op test never flakes. */
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
