/**
 * Domain events — typed, deterministic ids, no clock hidden inside.
 * `at` is always supplied by the caller (handler command or adapter clock).
 */

export interface BaseEvent {
  readonly id: string;
  readonly at: string;
  readonly correlationId?: string;
}

export interface TransactionPostedEvent extends BaseEvent {
  readonly kind: 'TransactionPosted';
  readonly txId: string;
  readonly memo?: string;
  readonly idempotencyKey?: string;
}

export type EscrowEventKind =
  | 'EscrowCreated'
  | 'EscrowFunded'
  | 'EscrowDelivered'
  | 'EscrowReleased'
  | 'EscrowDisputed'
  | 'EscrowRefunded'
  | 'EscrowCancelled'
  | 'EscrowExpired';

export interface EscrowEvent extends BaseEvent {
  readonly kind: EscrowEventKind;
  readonly escrowId: string;
  readonly buyerId?: string;
  readonly sellerId?: string;
  readonly amount?: number;
  readonly txId?: string;
  readonly sellerNet?: number;
  readonly tax?: number;
  readonly reason?: string;
}

export type DomainEvent = TransactionPostedEvent | EscrowEvent;

export function transactionPostedEvent(
  base: Omit<TransactionPostedEvent, 'kind' | 'id' | 'at'>,
  at: string,
): TransactionPostedEvent {
  return { ...base, kind: 'TransactionPosted', id: `${base.txId}#posted`, at };
}

export function escrowEvent(
  base: Omit<EscrowEvent, 'id' | 'at'>,
  at: string,
): EscrowEvent {
  // Deterministic id: each escrow kind transition happens at most once per escrow.
  return { ...base, id: `${base.escrowId}#${base.kind}`, at };
}
