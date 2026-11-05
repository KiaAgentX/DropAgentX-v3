import { describe, expect, it } from 'vitest';

import { unwrap } from '../errors.js';
import {
  addAccount,
  balanceOf,
  BURN_ACCOUNT_ID,
  circulatingSupply,
  MINT_ACCOUNT_ID,
  openLedger,
  post,
  TREASURY_ACCOUNT_ID,
  trialBalance,
  type LedgerState,
} from '../ledger.js';
import {
  cancelEscrow,
  createEscrow,
  deliverEscrow,
  disputeEscrow,
  ESCROW_TERMINAL_STATUSES,
  ESCROW_TRANSITIONS,
  escrowAccountId,
  expireEscrow,
  findExpired,
  fundEscrow,
  openRegistry,
  refundEscrow,
  releaseEscrow,
  type EscrowRegistry,
} from '../escrow.js';
import type { Din } from '../money.js';

const MINT = MINT_ACCOUNT_ID;
const TREASURY = TREASURY_ACCOUNT_ID;
const BURN = BURN_ACCOUNT_ID;
const BUYER = 'user:buyer';
const SELLER = 'user:seller';
const d = (n: number): Din => n as Din;
const T0 = '2026-01-01T09:00:00.000Z';

function setup(): { ledger: LedgerState; registry: EscrowRegistry } {
  let l = openLedger();
  l = unwrap(addAccount(l, { id: MINT, kind: 'mint' }));
  l = unwrap(addAccount(l, { id: TREASURY, kind: 'treasury' }));
  l = unwrap(addAccount(l, { id: BURN, kind: 'burn' }));
  l = unwrap(addAccount(l, { id: BUYER, kind: 'user', label: 'خریدار' }));
  l = unwrap(addAccount(l, { id: SELLER, kind: 'user', label: 'فروشنده' }));
  l = unwrap(post(l, { postings: [{ accountId: MINT, amount: -1_000 }, { accountId: BUYER, amount: 1_000 }] })).state;
  return { ledger: l, registry: openRegistry() };
}

/** create → fund → deliver in one shot (funded escrow ready to settle, events accumulated) */
function funded(ledger: LedgerState, registry: EscrowRegistry, id: string, amount: number, expiresAt?: string) {
  const a = unwrap(createEscrow(ledger, registry, { id, buyerId: BUYER, sellerId: SELLER, amount: d(amount), expiresAt, at: T0 }));
  const b = unwrap(fundEscrow(a.ledger, a.registry, { escrowId: id, idempotencyKey: `fund:${id}` }));
  const c = unwrap(deliverEscrow(b.ledger, b.registry, { escrowId: id, deliveryRef: `payload:${id}` }));
  return { ledger: c.ledger, registry: c.registry, escrow: c.escrow, tx: c.tx, events: [...a.events, ...b.events, ...c.events] };
}

describe('escrow — ADR-004 (state machine over the ledger)', () => {
  it('runs the happy path: fund 100 → seller 90 + treasury 10 (tax 10%)', () => {
    const s = setup();
    const created = unwrap(createEscrow(s.ledger, s.registry, {
      id: 'e1', buyerId: BUYER, sellerId: SELLER, amount: d(100), productRef: 'prod:1', at: T0,
    }));
    expect(created.escrow.status).toBe('CREATED');
    expect(unwrap(balanceOf(created.ledger, escrowAccountId('e1')))).toBe(0);

    const fundedE = unwrap(fundEscrow(created.ledger, created.registry, { escrowId: 'e1', idempotencyKey: 'fund:e1' }));
    expect(fundedE.escrow.status).toBe('FUNDED');
    expect(unwrap(balanceOf(fundedE.ledger, BUYER))).toBe(900);
    expect(unwrap(balanceOf(fundedE.ledger, escrowAccountId('e1')))).toBe(100);

    const delivered = unwrap(deliverEscrow(fundedE.ledger, fundedE.registry, { escrowId: 'e1', deliveryRef: 'payload:e1' }));
    expect(delivered.escrow.status).toBe('DELIVERED');

    const released = unwrap(releaseEscrow(delivered.ledger, delivered.registry, { escrowId: 'e1', idempotencyKey: 'settle:e1' }));
    expect(released.escrow.status).toBe('RELEASED');
    expect(unwrap(balanceOf(released.ledger, BUYER))).toBe(900);
    expect(unwrap(balanceOf(released.ledger, SELLER))).toBe(90);
    expect(unwrap(balanceOf(released.ledger, TREASURY))).toBe(10);
    expect(unwrap(balanceOf(released.ledger, escrowAccountId('e1')))).toBe(0);
    expect(trialBalance(released.ledger).balanced).toBe(true);
    expect(circulatingSupply(released.ledger)).toBe(1_000);
  });

  it('emits deterministic events in order', () => {
    const s = setup();
    const r = funded(s.ledger, s.registry, 'e1', 100);
    const released = unwrap(releaseEscrow(r.ledger, r.registry, { escrowId: 'e1' }));
    const kinds = [...r.events, ...released.events].map((e) => e.kind);
    expect(kinds).toEqual(['EscrowCreated', 'EscrowFunded', 'EscrowDelivered', 'EscrowReleased']);
    expect(r.events[0]?.id).toBe('e1#EscrowCreated');
    expect(released.events[0]?.id).toBe('e1#EscrowReleased');
    expect(released.events[0]?.tax).toBe(10);
    expect(released.events[0]?.sellerNet).toBe(90);
  });

  it('gates big releases behind HITL at 50,000 Đ (Article 7)', () => {
    const s = setup();
    let l = unwrap(post(s.ledger, { postings: [{ accountId: MINT, amount: -60_000 }, { accountId: BUYER, amount: 60_000 }] })).state;
    const created = unwrap(createEscrow(l, s.registry, { id: 'big', buyerId: BUYER, sellerId: SELLER, amount: d(60_000) }));
    const f = unwrap(fundEscrow(created.ledger, created.registry, { escrowId: 'big' }));
    const del = unwrap(deliverEscrow(f.ledger, f.registry, { escrowId: 'big' }));
    const blocked = releaseEscrow(del.ledger, del.registry, { escrowId: 'big' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('REQUIRES_HUMAN_APPROVAL');
    const allowed = unwrap(releaseEscrow(del.ledger, del.registry, { escrowId: 'big', approvedByAdmin: true }));
    expect(unwrap(balanceOf(allowed.ledger, SELLER))).toBe(54_000);
    expect(unwrap(balanceOf(allowed.ledger, TREASURY))).toBe(6_000);
  });

  it('runs dispute → refund end to end', () => {
    const s = setup();
    const c = unwrap(createEscrow(s.ledger, s.registry, { id: 'e2', buyerId: BUYER, sellerId: SELLER, amount: d(40) }));
    const f = unwrap(fundEscrow(c.ledger, c.registry, { escrowId: 'e2' }));
    const disputed = unwrap(disputeEscrow(f.ledger, f.registry, { escrowId: 'e2', reason: 'کالا ناقص بود' }));
    expect(disputed.escrow.status).toBe('DISPUTED');
    const refunded = unwrap(refundEscrow(disputed.ledger, disputed.registry, { escrowId: 'e2' }));
    expect(refunded.escrow.status).toBe('REFUNDED');
    expect(unwrap(balanceOf(refunded.ledger, BUYER))).toBe(1_000);
    expect(unwrap(balanceOf(refunded.ledger, SELLER))).toBe(0);
    expect(unwrap(balanceOf(refunded.ledger, TREASURY))).toBe(0);
    expect(trialBalance(refunded.ledger).balanced).toBe(true);
  });

  it('allows arbitration to release a disputed escrow to the seller', () => {
    const s = setup();
    const c = unwrap(createEscrow(s.ledger, s.registry, { id: 'e3', buyerId: BUYER, sellerId: SELLER, amount: d(40) }));
    const f = unwrap(fundEscrow(c.ledger, c.registry, { escrowId: 'e3' }));
    const disputed = unwrap(disputeEscrow(f.ledger, f.registry, { escrowId: 'e3', reason: 'ادعای خریدار' }));
    const released = unwrap(releaseEscrow(disputed.ledger, disputed.registry, { escrowId: 'e3' }));
    expect(released.escrow.status).toBe('RELEASED');
    expect(unwrap(balanceOf(released.ledger, SELLER))).toBe(36);
    expect(unwrap(balanceOf(released.ledger, TREASURY))).toBe(4);
  });

  it('cancels before funding without moving any money', () => {
    const s = setup();
    const c = unwrap(createEscrow(s.ledger, s.registry, { id: 'e4', buyerId: BUYER, sellerId: SELLER, amount: d(70) }));
    const cancelled = unwrap(cancelEscrow(c.ledger, c.registry, { escrowId: 'e4' }));
    expect(cancelled.escrow.status).toBe('CANCELLED');
    expect(unwrap(balanceOf(cancelled.ledger, BUYER))).toBe(1_000);
    expect(unwrap(balanceOf(cancelled.ledger, SELLER))).toBe(0);
    expect(unwrap(balanceOf(cancelled.ledger, escrowAccountId('e4')))).toBe(0);
    expect(cancelled.tx).toBeUndefined();
  });

  it('expires funded escrows past their TTL and auto-refunds the buyer', () => {
    const s = setup();
    const c = unwrap(createEscrow(s.ledger, s.registry, {
      id: 'e5', buyerId: BUYER, sellerId: SELLER, amount: d(40), expiresAt: '2026-01-05T00:00:00.000Z',
    }));
    const f = unwrap(fundEscrow(c.ledger, c.registry, { escrowId: 'e5' }));
    const due = findExpired(f.registry, '2026-01-06T00:00:00.000Z');
    expect(due.map((e) => e.id)).toEqual(['e5']);
    const expired = unwrap(expireEscrow(f.ledger, f.registry, { escrowId: 'e5' }));
    expect(expired.escrow.status).toBe('EXPIRED');
    expect(unwrap(balanceOf(expired.ledger, BUYER))).toBe(1_000);
    expect(unwrap(balanceOf(expired.ledger, escrowAccountId('e5')))).toBe(0);
    expect(findExpired(expired.registry, '2026-01-06T00:00:00.000Z')).toHaveLength(0);
  });

  it('rejects every illegal transition (fail-closed machine)', () => {
    const s = setup();
    // unknown escrow
    expect(fundEscrow(s.ledger, s.registry, { escrowId: 'ghost' }).ok).toBe(false);
    const c = unwrap(createEscrow(s.ledger, s.registry, { id: 'e6', buyerId: BUYER, sellerId: SELLER, amount: d(20) }));
    // deliver before fund
    expect(deliverEscrow(c.ledger, c.registry, { escrowId: 'e6' }).ok).toBe(false);
    // release before fund
    expect(releaseEscrow(c.ledger, c.registry, { escrowId: 'e6' }).ok).toBe(false);
    // cancel after fund
    const f = unwrap(fundEscrow(c.ledger, c.registry, { escrowId: 'e6' }));
    expect(cancelEscrow(f.ledger, f.registry, { escrowId: 'e6' }).ok).toBe(false);
    // refund without dispute
    expect(refundEscrow(f.ledger, f.registry, { escrowId: 'e6' }).ok).toBe(false);
    // release before deliver
    expect(releaseEscrow(f.ledger, f.registry, { escrowId: 'e6' }).ok).toBe(false);
    // duplicate create
    expect(createEscrow(s.ledger, f.registry, { id: 'e6', buyerId: BUYER, sellerId: SELLER, amount: d(20) }).ok).toBe(false);
    // buyer must be a user account
    expect(createEscrow(s.ledger, s.registry, { id: 'e7', buyerId: TREASURY, sellerId: SELLER, amount: d(20) }).ok).toBe(false);
    // dispute requires a reason
    expect(disputeEscrow(f.ledger, f.registry, { escrowId: 'e6', reason: '   ' }).ok).toBe(false);
  });

  it('carries the transition table for UI consumption', () => {
    expect(ESCROW_TRANSITIONS['CREATED']).toContain('EscrowFunded');
    expect(ESCROW_TRANSITIONS['FUNDED']).toContain('EscrowExpired');
    expect(ESCROW_TRANSITIONS['DISPUTED']).toEqual(['EscrowRefunded', 'EscrowReleased']);
    for (const terminal of ESCROW_TERMINAL_STATUSES) {
      expect(ESCROW_TRANSITIONS[terminal]).toHaveLength(0);
    }
  });
});
