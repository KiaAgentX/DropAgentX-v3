/**
 * ADR-004 — Escrow as an explicit state machine over the ledger.
 *
 * States:  CREATED → FUNDED → DELIVERED → RELEASED
 *                        ↘ DISPUTED → REFUNDED | RELEASED (arbitration)
 *          CREATED → CANCELLED        (nothing ever moved)
 *          FUNDED  → EXPIRED          (auto refund on TTL sweep)
 *
 * Money path (Article 8 — escrow mandatory for marketplace):
 *   fund     : buyer → escrow
 *   release  : escrow → seller (net) + escrow → treasury (tax 10%)
 *   refund   : escrow → buyer (full, no tax)
 */

import { err, ok, type Result } from './errors.js';
import type { Din } from './money.js';
import { addAccount, post, TREASURY_ACCOUNT_ID, type LedgerState, type PostedTransaction } from './ledger.js';
import { requiresHitl, splitSellerTax, CHARTER } from './charter.js';
import { escrowEvent, type EscrowEvent, type EscrowEventKind } from './events.js';

export type EscrowStatus =
  | 'CREATED'
  | 'FUNDED'
  | 'DELIVERED'
  | 'RELEASED'
  | 'DISPUTED'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'EXPIRED';

export const ESCROW_TERMINAL_STATUSES: readonly EscrowStatus[] = [
  'RELEASED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
];

/** Machine-readable transition table (used by handlers, tests and UI). */
export const ESCROW_TRANSITIONS: Readonly<Record<EscrowStatus, readonly EscrowEventKind[]>> = {
  CREATED: ['EscrowFunded', 'EscrowCancelled'],
  FUNDED: ['EscrowDelivered', 'EscrowDisputed', 'EscrowExpired'],
  DELIVERED: ['EscrowReleased', 'EscrowDisputed'],
  DISPUTED: ['EscrowRefunded', 'EscrowReleased'],
  RELEASED: [],
  REFUNDED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export interface Escrow {
  readonly id: string;
  readonly buyerId: string;
  readonly sellerId: string;
  readonly amount: Din;
  readonly productRef?: string;
  readonly status: EscrowStatus;
  readonly createdAt: string;
  readonly fundedTxId?: string;
  readonly settleTxId?: string;
  readonly disputeReason?: string;
  readonly deliveryRef?: string;
  readonly expiresAt?: string;
}

export interface EscrowRegistry {
  readonly escrows: ReadonlyMap<string, Escrow>;
}

export const openRegistry = (): EscrowRegistry => ({ escrows: new Map() });

export const escrowAccountId = (escrowId: string): string => `escrow:${escrowId}`;

export interface EscrowOutcome {
  readonly ledger: LedgerState;
  readonly registry: EscrowRegistry;
  readonly escrow: Escrow;
  readonly events: readonly EscrowEvent[];
  readonly tx?: PostedTransaction;
}

function putEscrow(registry: EscrowRegistry, escrow: Escrow): EscrowRegistry {
  const escrows = new Map(registry.escrows);
  escrows.set(escrow.id, escrow);
  return { escrows };
}

function loadEscrow(registry: EscrowRegistry, escrowId: string): Result<Escrow> {
  const escrow = registry.escrows.get(escrowId);
  if (escrow === undefined) {
    return err('ESCROW_NOT_FOUND', `Escrow ${escrowId} does not exist`);
  }
  return ok(escrow);
}

export interface CreateEscrowCommand {
  readonly id: string;
  readonly buyerId: string;
  readonly sellerId: string;
  readonly amount: Din;
  readonly productRef?: string;
  readonly expiresAt?: string;
  readonly at?: string;
}

export function createEscrow(
  ledger: LedgerState,
  registry: EscrowRegistry,
  cmd: CreateEscrowCommand,
): Result<EscrowOutcome> {
  if (registry.escrows.has(cmd.id)) {
    return err('ESCROW_ALREADY_EXISTS', `Escrow ${cmd.id} already exists`);
  }
  const buyer = ledger.accounts.get(cmd.buyerId);
  if (buyer === undefined) {
    return err('UNKNOWN_ACCOUNT', `Buyer account ${cmd.buyerId} does not exist`);
  }
  const seller = ledger.accounts.get(cmd.sellerId);
  if (seller === undefined) {
    return err('UNKNOWN_ACCOUNT', `Seller account ${cmd.sellerId} does not exist`);
  }
  if (buyer.kind !== 'user' || seller.kind !== 'user') {
    return err('INVALID_ACCOUNT_KIND', 'Buyer and seller must both be user accounts');
  }
  const escrowAccount = { id: escrowAccountId(cmd.id), kind: 'escrow' as const, label: `escrow ${cmd.id}` };
  const withAccount = addAccount(ledger, escrowAccount);
  if (!withAccount.ok) return withAccount;

  const at = cmd.at ?? new Date().toISOString();
  const escrow: Escrow = {
    id: cmd.id,
    buyerId: cmd.buyerId,
    sellerId: cmd.sellerId,
    amount: cmd.amount,
    productRef: cmd.productRef,
    status: 'CREATED',
    createdAt: at,
    expiresAt: cmd.expiresAt,
  };
  const event = escrowEvent(
    { kind: 'EscrowCreated', escrowId: escrow.id, buyerId: escrow.buyerId, sellerId: escrow.sellerId, amount: escrow.amount },
    at,
  );
  return ok({ ledger: withAccount.value, registry: putEscrow(registry, escrow), escrow, events: [event] });
}

export interface EscrowRefCommand {
  readonly escrowId: string;
  readonly idempotencyKey?: string;
  readonly at?: string;
}

export function fundEscrow(
  ledger: LedgerState,
  registry: EscrowRegistry,
  cmd: EscrowRefCommand,
): Result<EscrowOutcome> {
  const loaded = loadEscrow(registry, cmd.escrowId);
  if (!loaded.ok) return loaded;
  const escrow = loaded.value;
  if (escrow.status !== 'CREATED') {
    return err('INVALID_TRANSITION', `Cannot fund escrow in status ${escrow.status}`);
  }
  const posted = post(ledger, {
    idempotencyKey: cmd.idempotencyKey,
    postings: [
      { accountId: escrow.buyerId, amount: -escrow.amount },
      { accountId: escrowAccountId(escrow.id), amount: escrow.amount },
    ],
    memo: `fund escrow ${escrow.id}`,
    at: cmd.at,
  });
  if (!posted.ok) return posted;
  const funded: Escrow = { ...escrow, status: 'FUNDED', fundedTxId: posted.value.tx.id };
  const event = escrowEvent(
    { kind: 'EscrowFunded', escrowId: escrow.id, amount: escrow.amount, txId: posted.value.tx.id },
    posted.value.tx.at,
  );
  return ok({
    ledger: posted.value.state,
    registry: putEscrow(registry, funded),
    escrow: funded,
    events: [event],
    tx: posted.value.tx,
  });
}

export interface DeliverEscrowCommand extends EscrowRefCommand {
  readonly deliveryRef?: string;
}

export function deliverEscrow(
  ledger: LedgerState,
  registry: EscrowRegistry,
  cmd: DeliverEscrowCommand,
): Result<EscrowOutcome> {
  const loaded = loadEscrow(registry, cmd.escrowId);
  if (!loaded.ok) return loaded;
  const escrow = loaded.value;
  if (escrow.status !== 'FUNDED') {
    return err('INVALID_TRANSITION', `Cannot deliver escrow in status ${escrow.status}`);
  }
  const at = cmd.at ?? new Date().toISOString();
  const delivered: Escrow = { ...escrow, status: 'DELIVERED', deliveryRef: cmd.deliveryRef };
  const event = escrowEvent({ kind: 'EscrowDelivered', escrowId: escrow.id }, at);
  return ok({ ledger, registry: putEscrow(registry, delivered), escrow: delivered, events: [event] });
}

export interface ReleaseEscrowCommand extends EscrowRefCommand {
  /** Article 7 — required (true) when amount ≥ 50,000 Đ. */
  readonly approvedByAdmin?: boolean;
}

export function releaseEscrow(
  ledger: LedgerState,
  registry: EscrowRegistry,
  cmd: ReleaseEscrowCommand,
): Result<EscrowOutcome> {
  const loaded = loadEscrow(registry, cmd.escrowId);
  if (!loaded.ok) return loaded;
  const escrow = loaded.value;
  if (escrow.status !== 'DELIVERED' && escrow.status !== 'DISPUTED') {
    return err('INVALID_TRANSITION', `Cannot release escrow in status ${escrow.status}`);
  }
  if (requiresHitl(escrow.amount) && cmd.approvedByAdmin !== true) {
    return err(
      'REQUIRES_HUMAN_APPROVAL',
      `Release of ${escrow.amount} Đ requires human approval (HITL threshold ${CHARTER.hitlThresholdDin} Đ)`,
    );
  }
  const split = splitSellerTax(escrow.amount);
  if (!split.ok) return split;
  const posted = post(ledger, {
    idempotencyKey: cmd.idempotencyKey,
    postings: [
      { accountId: escrowAccountId(escrow.id), amount: -escrow.amount },
      { accountId: escrow.sellerId, amount: split.value.seller },
      { accountId: TREASURY_ACCOUNT_ID, amount: split.value.tax },
    ],
    memo: `release escrow ${escrow.id} (tax ${split.value.tax})`,
    at: cmd.at,
  });
  if (!posted.ok) return posted;
  const released: Escrow = { ...escrow, status: 'RELEASED', settleTxId: posted.value.tx.id };
  const event = escrowEvent(
    {
      kind: 'EscrowReleased',
      escrowId: escrow.id,
      txId: posted.value.tx.id,
      sellerNet: split.value.seller,
      tax: split.value.tax,
    },
    posted.value.tx.at,
  );
  return ok({
    ledger: posted.value.state,
    registry: putEscrow(registry, released),
    escrow: released,
    events: [event],
    tx: posted.value.tx,
  });
}

export interface DisputeEscrowCommand extends EscrowRefCommand {
  readonly reason: string;
}

export function disputeEscrow(
  ledger: LedgerState,
  registry: EscrowRegistry,
  cmd: DisputeEscrowCommand,
): Result<EscrowOutcome> {
  const loaded = loadEscrow(registry, cmd.escrowId);
  if (!loaded.ok) return loaded;
  const escrow = loaded.value;
  if (escrow.status !== 'FUNDED' && escrow.status !== 'DELIVERED') {
    return err('INVALID_TRANSITION', `Cannot dispute escrow in status ${escrow.status}`);
  }
  if (cmd.reason.trim().length === 0) {
    return err('INVALID_TRANSITION', 'A dispute requires a non-empty reason');
  }
  const at = cmd.at ?? new Date().toISOString();
  const disputed: Escrow = { ...escrow, status: 'DISPUTED', disputeReason: cmd.reason };
  const event = escrowEvent({ kind: 'EscrowDisputed', escrowId: escrow.id, reason: cmd.reason }, at);
  return ok({ ledger, registry: putEscrow(registry, disputed), escrow: disputed, events: [event] });
}

export function refundEscrow(
  ledger: LedgerState,
  registry: EscrowRegistry,
  cmd: EscrowRefCommand,
): Result<EscrowOutcome> {
  const loaded = loadEscrow(registry, cmd.escrowId);
  if (!loaded.ok) return loaded;
  const escrow = loaded.value;
  if (escrow.status !== 'DISPUTED') {
    return err('INVALID_TRANSITION', `Cannot refund escrow in status ${escrow.status} (must be DISPUTED)`);
  }
  const posted = post(ledger, {
    idempotencyKey: cmd.idempotencyKey,
    postings: [
      { accountId: escrowAccountId(escrow.id), amount: -escrow.amount },
      { accountId: escrow.buyerId, amount: escrow.amount },
    ],
    memo: `refund escrow ${escrow.id}`,
    at: cmd.at,
  });
  if (!posted.ok) return posted;
  const refunded: Escrow = { ...escrow, status: 'REFUNDED', settleTxId: posted.value.tx.id };
  const event = escrowEvent(
    { kind: 'EscrowRefunded', escrowId: escrow.id, txId: posted.value.tx.id, amount: escrow.amount },
    posted.value.tx.at,
  );
  return ok({
    ledger: posted.value.state,
    registry: putEscrow(registry, refunded),
    escrow: refunded,
    events: [event],
    tx: posted.value.tx,
  });
}

export function cancelEscrow(
  ledger: LedgerState,
  registry: EscrowRegistry,
  cmd: EscrowRefCommand,
): Result<EscrowOutcome> {
  const loaded = loadEscrow(registry, cmd.escrowId);
  if (!loaded.ok) return loaded;
  const escrow = loaded.value;
  if (escrow.status !== 'CREATED') {
    return err('INVALID_TRANSITION', `Cannot cancel escrow in status ${escrow.status} (only CREATED)`);
  }
  const at = cmd.at ?? new Date().toISOString();
  const cancelled: Escrow = { ...escrow, status: 'CANCELLED' };
  const event = escrowEvent({ kind: 'EscrowCancelled', escrowId: escrow.id }, at);
  return ok({ ledger, registry: putEscrow(registry, cancelled), escrow: cancelled, events: [event] });
}

/** FUNDED → EXPIRED with automatic full refund (Article 9). */
export function expireEscrow(
  ledger: LedgerState,
  registry: EscrowRegistry,
  cmd: EscrowRefCommand,
): Result<EscrowOutcome> {
  const loaded = loadEscrow(registry, cmd.escrowId);
  if (!loaded.ok) return loaded;
  const escrow = loaded.value;
  if (escrow.status !== 'FUNDED') {
    return err('INVALID_TRANSITION', `Cannot expire escrow in status ${escrow.status} (must be FUNDED)`);
  }
  const posted = post(ledger, {
    idempotencyKey: cmd.idempotencyKey,
    postings: [
      { accountId: escrowAccountId(escrow.id), amount: -escrow.amount },
      { accountId: escrow.buyerId, amount: escrow.amount },
    ],
    memo: `expire-refund escrow ${escrow.id}`,
    at: cmd.at,
  });
  if (!posted.ok) return posted;
  const expired: Escrow = { ...escrow, status: 'EXPIRED', settleTxId: posted.value.tx.id };
  const event = escrowEvent(
    { kind: 'EscrowExpired', escrowId: escrow.id, txId: posted.value.tx.id, amount: escrow.amount },
    posted.value.tx.at,
  );
  return ok({
    ledger: posted.value.state,
    registry: putEscrow(registry, expired),
    escrow: expired,
    events: [event],
    tx: posted.value.tx,
  });
}

/** Sweep helper: escrows past their TTL that still hold money in escrow. */
export function findExpired(registry: EscrowRegistry, nowIso: string): readonly Escrow[] {
  const now = Date.parse(nowIso);
  const out: Escrow[] = [];
  for (const escrow of registry.escrows.values()) {
    if (escrow.status !== 'FUNDED' || escrow.expiresAt === undefined) continue;
    if (Date.parse(escrow.expiresAt) <= now) out.push(escrow);
  }
  return out;
}
