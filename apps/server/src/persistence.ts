/**
 * Persistence adapter — the ONLY place where the pure domain touches storage.
 *
 * Design (ADR-003 + ADR-001):
 *  - The postings table is the single source of truth; balances are derived.
 *  - Each command runs inside a Prisma interactive transaction:
 *      1. load the full ledger state (accounts, derived balances, txs, idempotency)
 *      2. run the pure domain closure
 *      3. persist new tx + postings, escrow upsert, outbox events, audit log
 *  - Idempotency: pre-check inside the transaction short-circuits replays;
 *    a race still cannot double-spend because Tx.idempotencyKey is UNIQUE.
 *
 * Scale note: v3 loads full state per command (correctness first). At the
 * current scale (~1.5k txs) this is microseconds; revisit with a read model
 * only when the ledger grows by orders of magnitude.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import * as D from '@dropagentx/domain';
import { DomainFailure } from './errors.js';

export interface CommandOutcome {
  readonly ledger: D.LedgerState;
  readonly tx?: D.PostedTransaction;
  readonly escrow?: D.Escrow;
  readonly events: readonly D.DomainEvent[];
}

export interface ApplyOptions {
  readonly actor: string;
  readonly action: string;
  readonly target?: string;
  readonly escrowId?: string;
  readonly idempotencyKey?: string;
  readonly run: (
    ledger: D.LedgerState,
    registry: D.EscrowRegistry,
  ) => D.Result<CommandOutcome> | Promise<D.Result<CommandOutcome>>;
}

export interface ApplyResult {
  readonly replayed: boolean;
  readonly tx?: D.PostedTransaction;
  readonly escrow?: D.Escrow;
  readonly ledger: D.LedgerState;
}

type TxClient = Prisma.TransactionClient;

function rowToEscrow(row: {
  id: string;
  buyerId: string;
  sellerId: string;
  amount: number;
  productRef: string | null;
  status: string;
  createdAt: Date;
  fundedTxId: string | null;
  settleTxId: string | null;
  disputeReason: string | null;
  deliveryRef: string | null;
  expiresAt: Date | null;
}): D.Escrow {
  return {
    id: row.id,
    buyerId: row.buyerId,
    sellerId: row.sellerId,
    amount: row.amount as D.Din,
    ...(row.productRef !== null ? { productRef: row.productRef } : {}),
    status: row.status as D.EscrowStatus,
    createdAt: row.createdAt.toISOString(),
    ...(row.fundedTxId !== null ? { fundedTxId: row.fundedTxId } : {}),
    ...(row.settleTxId !== null ? { settleTxId: row.settleTxId } : {}),
    ...(row.disputeReason !== null ? { disputeReason: row.disputeReason } : {}),
    ...(row.deliveryRef !== null ? { deliveryRef: row.deliveryRef } : {}),
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt.toISOString() } : {}),
  };
}

function rowToTx(row: {
  id: string;
  idempotencyKey: string | null;
  memo: string | null;
  at: Date;
  postings: { accountId: string; amount: number }[];
}): D.PostedTransaction {
  return {
    id: row.id,
    ...(row.idempotencyKey !== null ? { idempotencyKey: row.idempotencyKey } : {}),
    ...(row.memo !== null ? { memo: row.memo } : {}),
    postings: row.postings.map((p) => ({ accountId: p.accountId, amount: p.amount })),
    at: row.at.toISOString(),
  };
}

function escrowToRows(escrow: D.Escrow) {
  return {
    id: escrow.id,
    buyerId: escrow.buyerId,
    sellerId: escrow.sellerId,
    amount: escrow.amount,
    ...(escrow.productRef !== undefined ? { productRef: escrow.productRef } : {}),
    status: escrow.status,
    createdAt: new Date(escrow.createdAt),
    ...(escrow.fundedTxId !== undefined ? { fundedTxId: escrow.fundedTxId } : {}),
    ...(escrow.settleTxId !== undefined ? { settleTxId: escrow.settleTxId } : {}),
    ...(escrow.disputeReason !== undefined ? { disputeReason: escrow.disputeReason } : {}),
    ...(escrow.deliveryRef !== undefined ? { deliveryRef: escrow.deliveryRef } : {}),
    ...(escrow.expiresAt !== undefined ? { expiresAt: new Date(escrow.expiresAt) } : {}),
  };
}

export class V3Store {
  constructor(readonly prisma: PrismaClient) {}

  /** System accounts must exist before any money moves (charter Article 4). */
  async ensureSystemAccounts(): Promise<void> {
    const defs: readonly (readonly [string, D.AccountKind, string])[] = [
      [D.MINT_ACCOUNT_ID, 'mint', 'منبع عرضه (ضرب)'],
      [D.TREASURY_ACCOUNT_ID, 'treasury', 'خزانه ملی'],
      [D.BURN_ACCOUNT_ID, 'burn', 'مقصد سوزاندن'],
    ];
    for (const [id, kind, label] of defs) {
      await this.prisma.account.upsert({ where: { id }, create: { id, kind, label }, update: {} });
    }
  }

  private async loadLedgerState(tx: TxClient): Promise<D.LedgerState> {
    const accounts = await tx.account.findMany();
    const sums = await tx.posting.groupBy({ by: ['accountId'], _sum: { amount: true } });
    const balances = new Map<string, number>();
    for (const a of accounts) balances.set(a.id, 0);
    for (const s of sums) balances.set(s.accountId, s._sum.amount ?? 0);

    const txRows = await tx.tx.findMany({ include: { postings: { orderBy: { id: 'asc' } } } });
    const txs = new Map<string, D.PostedTransaction>();
    const idempotency = new Map<string, string>();
    for (const t of txRows) {
      const posted = rowToTx(t);
      txs.set(posted.id, posted);
      if (posted.idempotencyKey !== undefined) idempotency.set(posted.idempotencyKey, posted.id);
    }

    return {
      accounts: new Map(
        accounts.map((a) => [a.id, { id: a.id, kind: a.kind as D.AccountKind, ...(a.label !== null ? { label: a.label } : {}) }]),
      ),
      balances,
      txs,
      idempotency,
    };
  }

  private async loadEscrowRegistry(tx: TxClient, escrowId?: string): Promise<D.EscrowRegistry> {
    const escrows = new Map<string, D.Escrow>();
    if (escrowId !== undefined) {
      const row = await tx.escrow.findUnique({ where: { id: escrowId } });
      if (row !== null) escrows.set(row.id, rowToEscrow(row));
    }
    return { escrows };
  }

  async apply(options: ApplyOptions): Promise<ApplyResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (options.idempotencyKey !== undefined) {
          const existing = await tx.tx.findUnique({
            where: { idempotencyKey: options.idempotencyKey },
            include: { postings: { orderBy: { id: 'asc' } } },
          });
          if (existing !== null) {
            const ledger = await this.loadLedgerState(tx);
            const escrowRow =
              options.escrowId !== undefined
                ? await tx.escrow.findUnique({ where: { id: options.escrowId } })
                : null;
            return {
              replayed: true,
              tx: rowToTx(existing),
              ledger,
              ...(escrowRow !== null ? { escrow: rowToEscrow(escrowRow) } : {}),
            };
          }
        }

        const ledger = await this.loadLedgerState(tx);
        const registry = await this.loadEscrowRegistry(tx, options.escrowId);
        const result = await options.run(ledger, registry);
        if (!result.ok) throw new DomainFailure(result.error);
        const outcome = result.value;

        if (outcome.escrow !== undefined) {
          const escrowAccountId = D.escrowAccountId(outcome.escrow.id);
          await tx.account.upsert({
            where: { id: escrowAccountId },
            create: { id: escrowAccountId, kind: 'escrow', label: `escrow ${outcome.escrow.id}` },
            update: {},
          });
          await tx.escrow.upsert({
            where: { id: outcome.escrow.id },
            create: escrowToRows(outcome.escrow),
            update: escrowToRows(outcome.escrow),
          });
        }

        if (outcome.tx !== undefined) {
          await tx.tx.create({
            data: {
              id: outcome.tx.id,
              idempotencyKey: options.idempotencyKey ?? outcome.tx.idempotencyKey ?? null,
              memo: outcome.tx.memo ?? null,
              at: new Date(outcome.tx.at),
              postings: {
                create: outcome.tx.postings.map((p) => ({ accountId: p.accountId, amount: p.amount })),
              },
            },
          });
        }

        if (outcome.events.length > 0) {
          await tx.outboxEvent.createMany({
            data: outcome.events.map((e) => ({ kind: e.kind, payload: JSON.stringify(e) })),
          });
        }

        await tx.auditLog.create({
          data: {
            actor: options.actor,
            action: options.action,
            target: options.target ?? null,
            meta: outcome.tx !== undefined ? JSON.stringify({ txId: outcome.tx.id }) : null,
          },
        });

        return { replayed: false, tx: outcome.tx, escrow: outcome.escrow, ledger: outcome.ledger };
      });
    } catch (err) {
      // Concurrent identical idempotency keys: the unique constraint saved us —
      // turn the conflict into an honest replay read.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        options.idempotencyKey !== undefined
      ) {
        const existing = await this.prisma.tx.findUnique({
          where: { idempotencyKey: options.idempotencyKey },
          include: { postings: { orderBy: { id: 'asc' } } },
        });
        if (existing !== null) {
          const escrowRow =
            options.escrowId !== undefined
              ? await this.prisma.escrow.findUnique({ where: { id: options.escrowId } })
              : null;
          return {
            replayed: true,
            tx: rowToTx(existing),
            ledger: await this.loadLedgerStatePlain(),
            ...(escrowRow !== null ? { escrow: rowToEscrow(escrowRow) } : {}),
          };
        }
      }
      throw err;
    }
  }

  private async loadLedgerStatePlain(): Promise<D.LedgerState> {
    const [accounts, sums, txRows] = await Promise.all([
      this.prisma.account.findMany(),
      this.prisma.posting.groupBy({ by: ['accountId'], _sum: { amount: true } }),
      this.prisma.tx.findMany({ include: { postings: { orderBy: { id: 'asc' } } } }),
    ]);
    const balances = new Map<string, number>();
    for (const a of accounts) balances.set(a.id, 0);
    for (const s of sums) balances.set(s.accountId, s._sum.amount ?? 0);
    const txs = new Map<string, D.PostedTransaction>();
    const idempotency = new Map<string, string>();
    for (const t of txRows) {
      const posted = rowToTx(t);
      txs.set(posted.id, posted);
      if (posted.idempotencyKey !== undefined) idempotency.set(posted.idempotencyKey, posted.id);
    }
    return {
      accounts: new Map(accounts.map((a) => [a.id, { id: a.id, kind: a.kind as D.AccountKind, ...(a.label !== null ? { label: a.label } : {}) }])),
      balances,
      txs,
      idempotency,
    };
  }

  // ── read-only helpers ──

  async balanceOf(accountId: string): Promise<number | null> {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (account === null) return null;
    const agg = await this.prisma.posting.aggregate({ where: { accountId }, _sum: { amount: true } });
    return agg._sum.amount ?? 0;
  }

  async listAccountsWithBalances(): Promise<{ id: string; kind: string; label: string | null; balance: number; createdAt: string }[]> {
    const accounts = await this.prisma.account.findMany({ orderBy: { id: 'asc' } });
    const sums = await this.prisma.posting.groupBy({ by: ['accountId'], _sum: { amount: true } });
    const balances = new Map<string, number>();
    for (const s of sums) balances.set(s.accountId, s._sum.amount ?? 0);
    return accounts.map((a) => ({
      id: a.id,
      kind: a.kind,
      label: a.label,
      balance: balances.get(a.id) ?? 0,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  async getEscrow(id: string): Promise<D.Escrow | null> {
    const row = await this.prisma.escrow.findUnique({ where: { id } });
    return row === null ? null : rowToEscrow(row);
  }

  async listEscrows(status?: D.EscrowStatus): Promise<D.Escrow[]> {
    const rows = await this.prisma.escrow.findMany({
      ...(status !== undefined ? { where: { status } } : {}),
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(rowToEscrow);
  }

  async mintedThisYear(): Promise<number> {
    const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
    const agg = await this.prisma.posting.aggregate({
      where: { accountId: D.MINT_ACCOUNT_ID, tx: { at: { gte: yearStart } } },
      _sum: { amount: true },
    });
    return -(agg._sum.amount ?? 0);
  }

  async economySummary() {
    const [accounts, sums, escrowOpen, mintedThisYear] = await Promise.all([
      this.prisma.account.findMany(),
      this.prisma.posting.groupBy({ by: ['accountId'], _sum: { amount: true } }),
      this.prisma.escrow.count({ where: { status: { in: ['CREATED', 'FUNDED', 'DELIVERED', 'DISPUTED'] } } }),
      this.mintedThisYear(),
    ]);
    const balances = new Map<string, number>();
    for (const s of sums) balances.set(s.accountId, s._sum.amount ?? 0);
    let trialSum = 0;
    let users = 0;
    let escrowLocked = 0;
    let treasury = 0;
    let mint = 0;
    let burn = 0;
    for (const a of accounts) {
      const balance = balances.get(a.id) ?? 0;
      trialSum += balance;
      switch (a.kind) {
        case 'user':
          users += balance;
          break;
        case 'escrow':
          escrowLocked += balance;
          break;
        case 'treasury':
          treasury += balance;
          break;
        case 'mint':
          mint += balance;
          break;
        case 'burn':
          burn += balance;
          break;
      }
    }
    return {
      circulatingSupply: users + escrowLocked + treasury,
      treasuryBalance: treasury,
      escrowLocked,
      mintedAllTime: -mint,
      burnedAllTime: burn,
      mintedThisYear,
      trialBalanceSum: trialSum,
      balanced: trialSum === 0,
      accountCount: accounts.length,
      openEscrows: escrowOpen,
    };
  }
}
