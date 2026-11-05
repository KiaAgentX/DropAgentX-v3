/**
 * ADR-003 — Immutable double-entry ledger (pure functional core).
 *
 * Conventions:
 *  - posting amount > 0 → credit into account, amount < 0 → debit out of account.
 *  - every transaction has ≥ 2 postings and they ALWAYS sum to zero.
 *  - direction rules per account kind (fail-closed):
 *      user/escrow/treasury → balance can never go negative,
 *      mint  → balance can never go positive (it only issues supply),
 *      burn  → balance can never go negative (it only receives destroyed money).
 *  - idempotencyKey: posting twice with the same key is a no-op replay,
 *    returning the original transaction (safe for retried bot/API calls).
 *  - conservation (sacred): Σ balances over ALL accounts = 0, always.
 */

import { err, ok, type Result } from './errors.js';
import type { Din } from './money.js';

export type AccountKind = 'user' | 'escrow' | 'treasury' | 'mint' | 'burn';

export interface Account {
  readonly id: string;
  readonly kind: AccountKind;
  readonly label?: string;
}

export interface Posting {
  readonly accountId: string;
  readonly amount: number; // signed safe integer
}

export interface PostedTransaction {
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly postings: readonly Posting[];
  readonly memo?: string;
  readonly at: string;
}

export interface LedgerState {
  readonly accounts: ReadonlyMap<string, Account>;
  readonly balances: ReadonlyMap<string, number>;
  readonly txs: ReadonlyMap<string, PostedTransaction>;
  readonly idempotency: ReadonlyMap<string, string>; // key → txId
}

/** Well-known system accounts (convention shared with apps/adapters). */
export const MINT_ACCOUNT_ID = 'mint:genesis';
export const TREASURY_ACCOUNT_ID = 'treasury:nation';
export const BURN_ACCOUNT_ID = 'burn:void';

export const openLedger = (): LedgerState => ({
  accounts: new Map(),
  balances: new Map(),
  txs: new Map(),
  idempotency: new Map(),
});

export function addAccount(state: LedgerState, account: Account): Result<LedgerState> {
  if (state.accounts.has(account.id)) {
    return err('DUPLICATE_ACCOUNT', `Account ${account.id} already exists`);
  }
  const accounts = new Map(state.accounts);
  accounts.set(account.id, account);
  const balances = new Map(state.balances);
  balances.set(account.id, 0);
  return ok({ accounts, balances, txs: state.txs, idempotency: state.idempotency });
}

export interface PostCommand {
  readonly id?: string;
  readonly idempotencyKey?: string;
  readonly postings: readonly Posting[];
  readonly memo?: string;
  readonly at?: string;
}

export interface PostOutcome {
  readonly state: LedgerState;
  readonly tx: PostedTransaction;
  readonly replayed: boolean;
}

export function isOverdraftViolation(kind: AccountKind, balance: number): boolean {
  switch (kind) {
    case 'mint':
      return balance > 0;
    case 'burn':
      return balance < 0;
    case 'user':
    case 'escrow':
    case 'treasury':
      return balance < 0;
  }
}

export function post(state: LedgerState, cmd: PostCommand): Result<PostOutcome> {
  // 1) Idempotent replay — returning the original tx is OK, not an error.
  if (cmd.idempotencyKey !== undefined) {
    const existingId = state.idempotency.get(cmd.idempotencyKey);
    const existing = existingId !== undefined ? state.txs.get(existingId) : undefined;
    if (existing !== undefined) {
      return ok({ state, tx: existing, replayed: true });
    }
  }

  // 2) Shape validation.
  if (cmd.postings.length < 2) {
    return err('TOO_FEW_POSTINGS', `A transaction needs at least 2 postings, got ${cmd.postings.length}`);
  }
  for (const p of cmd.postings) {
    if (!Number.isSafeInteger(p.amount)) {
      return err('NON_INTEGER_AMOUNT', `Posting to ${p.accountId} must be a safe integer, got ${p.amount}`);
    }
    if (!state.accounts.has(p.accountId)) {
      return err('UNKNOWN_ACCOUNT', `Unknown account ${p.accountId}`);
    }
  }
  const sum = cmd.postings.reduce((acc, p) => acc + p.amount, 0);
  if (sum !== 0) {
    return err('UNBALANCED_TRANSACTION', `Postings must sum to zero, got ${sum}`, { sum });
  }

  // 3) Direction rules (fail-closed) — evaluate on a draft, commit only if clean.
  const draft = new Map(state.balances);
  for (const p of cmd.postings) {
    draft.set(p.accountId, (draft.get(p.accountId) ?? 0) + p.amount);
  }
  for (const [accountId, newBalance] of draft) {
    const account = state.accounts.get(accountId);
    if (account === undefined) continue; // unreachable — validated above
    if (isOverdraftViolation(account.kind, newBalance)) {
      return err(
        'ACCOUNT_OVERDRAFT',
        `Account ${accountId} (${account.kind}) cannot go to ${newBalance}`,
        { accountId, kind: account.kind, newBalance },
      );
    }
  }

  // 4) Commit — new immutable state.
  const txId = cmd.id ?? `tx_${state.txs.size + 1}`;
  const tx: PostedTransaction = {
    id: txId,
    idempotencyKey: cmd.idempotencyKey,
    postings: [...cmd.postings],
    memo: cmd.memo,
    at: cmd.at ?? new Date().toISOString(),
  };
  const txs = new Map(state.txs);
  txs.set(tx.id, tx);
  const idempotency = new Map(state.idempotency);
  if (cmd.idempotencyKey !== undefined) {
    idempotency.set(cmd.idempotencyKey, tx.id);
  }
  return ok({ state: { accounts: state.accounts, balances: draft, txs, idempotency }, tx, replayed: false });
}

export function balanceOf(state: LedgerState, accountId: string): Result<number> {
  const b = state.balances.get(accountId);
  if (b === undefined) {
    return err('UNKNOWN_ACCOUNT', `Unknown account ${accountId}`);
  }
  return ok(b);
}

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly kind: AccountKind;
  readonly balance: number;
}

export interface TrialBalance {
  readonly rows: readonly TrialBalanceRow[];
  readonly sum: number;
  readonly balanced: boolean;
}

export function trialBalance(state: LedgerState): TrialBalance {
  const rows: TrialBalanceRow[] = [];
  let sum = 0;
  for (const [accountId, balance] of state.balances) {
    const account = state.accounts.get(accountId);
    if (account === undefined) continue;
    rows.push({ accountId, kind: account.kind, balance });
    sum += balance;
  }
  return { rows, sum, balanced: sum === 0 };
}

/** Money held by citizens (users + escrow + treasury) = issued − burned. */
export function circulatingSupply(state: LedgerState): number {
  let total = 0;
  for (const [accountId, balance] of state.balances) {
    const account = state.accounts.get(accountId);
    if (account === undefined) continue;
    if (account.kind === 'user' || account.kind === 'escrow' || account.kind === 'treasury') {
      total += balance;
    }
  }
  return total;
}

/** Type alias re-export for adapters that build money amounts from raw input. */
export type { Din };
