/**
 * API route registry — ONE definition per endpoint carries everything:
 * the zod contract (validation + OpenAPI), the security level and the handler.
 * This is the realization of ADR-005: contracts cannot drift from handlers.
 */

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import * as D from '@dropagentx/domain';
import * as C from '@dropagentx/contracts';
import { z } from 'zod';
import type { V3Store, ApplyResult } from './persistence.js';
import type { Config } from './config.js';
import { DomainFailure, HttpFailure } from './errors.js';

export interface RouteContext {
  readonly store: V3Store;
  readonly config: Config;
}

export interface RouteInput {
  readonly params: Record<string, string>;
  readonly query: Record<string, string>;
  readonly body: unknown;
}

export interface ApiRoute extends C.ApiRouteDef {
  handler: (ctx: RouteContext, input: RouteInput) => Promise<unknown>;
}

const RESERVED_PREFIXES = ['mint:', 'treasury:', 'burn:', 'escrow:'] as const;

function requireEscrow(result: ApplyResult): D.Escrow {
  if (result.escrow === undefined) {
    throw new HttpFailure(500, 'INTERNAL', 'Command completed without escrow state.');
  }
  return result.escrow;
}

function requireTx(result: ApplyResult): D.PostedTransaction {
  if (result.tx === undefined) {
    throw new HttpFailure(500, 'INTERNAL', 'Command completed without a transaction.');
  }
  return result.tx;
}

function escrowToView(e: D.Escrow): C.EscrowView {
  return {
    id: e.id,
    buyerId: e.buyerId,
    sellerId: e.sellerId,
    amount: e.amount,
    productRef: e.productRef ?? null,
    status: e.status,
    createdAt: e.createdAt,
    fundedTxId: e.fundedTxId ?? null,
    settleTxId: e.settleTxId ?? null,
    disputeReason: e.disputeReason ?? null,
    deliveryRef: e.deliveryRef ?? null,
    expiresAt: e.expiresAt ?? null,
  };
}

function escrowActionResponse(result: ApplyResult): C.EscrowActionResponse {
  return {
    escrow: escrowToView(requireEscrow(result)),
    txId: result.tx?.id ?? null,
    replayed: result.replayed,
  };
}

/** Exact yearly minted supply, derived from the loaded ledger state (Article 3). */
function mintedThisYearFromLedger(ledger: D.LedgerState): number {
  const yearStart = Date.UTC(new Date().getUTCFullYear(), 0, 1);
  let total = 0;
  for (const t of ledger.txs.values()) {
    if (Date.parse(t.at) >= yearStart) {
      for (const p of t.postings) {
        if (p.accountId === D.MINT_ACCOUNT_ID && p.amount < 0) total += -p.amount;
      }
    }
  }
  return total;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export const API_ROUTES: ApiRoute[] = [
  {
    method: 'get',
    path: '/health',
    operationId: 'health',
    summary: 'Liveness probe of the v3 server',
    tag: 'system',
    security: 'public',
    response: C.healthResponseSchema,
    handler: async ({ config }) => ({
      status: 'ok',
      service: 'dropagentx-v3-server',
      version: '0.3.0',
      llmConfigured: config.llm !== undefined,
      llmModel: config.llm?.model ?? null,
    }),
  },
  {
    method: 'get',
    path: '/economy',
    operationId: 'getEconomy',
    summary: 'Nation economy summary — public transparency (charter Article 6)',
    tag: 'economy',
    security: 'public',
    response: C.economySummarySchema,
    handler: async ({ store }) => {
      const s = await store.economySummary();
      return {
        currency: D.CHARTER.currency,
        symbol: D.CHARTER.symbol,
        ...s,
        yearlyMintCap: D.CHARTER.yearlyMintCapDin,
        genesisSupply: D.CHARTER.genesisSupplyDin,
      };
    },
  },

  {
    method: 'post',
    path: '/accounts',
    operationId: 'createAccount',
    summary: 'Register a user account (balance starts at 0)',
    tag: 'accounts',
    security: 'admin',
    body: C.createAccountRequestSchema,
    response: C.accountViewSchema,
    status: 201,
    handler: async ({ store }, { body }) => {
      const input = body as C.CreateAccountRequest;
      if (RESERVED_PREFIXES.some((p) => input.id.startsWith(p))) {
        throw new HttpFailure(422, 'RESERVED_ID', 'The mint:/treasury:/burn:/escrow: prefixes are system-reserved.');
      }
      const createdAt = new Date();
      try {
        await store.prisma.account.create({
          data: { id: input.id, kind: 'user', ...(input.label !== undefined ? { label: input.label } : {}), createdAt },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpFailure(422, 'DUPLICATE_ACCOUNT', `Account ${input.id} already exists.`);
        }
        throw err;
      }
      await store.prisma.auditLog.create({ data: { actor: 'admin', action: 'account.create', target: input.id } });
      return { id: input.id, kind: 'user', label: input.label ?? null, balance: 0, createdAt: createdAt.toISOString() };
    },
  },
  {
    method: 'get',
    path: '/accounts',
    operationId: 'listAccounts',
    summary: 'List all accounts with derived balances',
    tag: 'accounts',
    security: 'admin',
    response: C.accountListResponseSchema,
    handler: async ({ store }) => ({ items: await store.listAccountsWithBalances() }),
  },
  {
    method: 'get',
    path: '/accounts/{id}/balance',
    operationId: 'getBalance',
    summary: 'Derived balance of one account (public transparency)',
    tag: 'accounts',
    security: 'public',
    params: z.object({ id: C.idSchema }),
    response: C.balanceResponseSchema,
    handler: async ({ store }, { params }) => {
      const balance = await store.balanceOf(params.id!);
      if (balance === null) {
        throw new DomainFailure({ code: 'UNKNOWN_ACCOUNT', message: `Account ${params.id} does not exist` });
      }
      return { accountId: params.id!, balance };
    },
  },

  {
    method: 'post',
    path: '/wallet/mint',
    operationId: 'mint',
    summary: 'Mint dinar into a user account — yearly cap enforced (charter Article 3)',
    tag: 'wallet',
    security: 'admin',
    body: C.mintRequestSchema,
    response: C.walletMoveResponseSchema,
    handler: async ({ store }, { body }) => {
      const input = body as C.MintRequest;
      const amount = D.unwrap(D.din(input.amount));
      const result = await store.apply({
        actor: 'admin',
        action: 'wallet.mint',
        target: input.accountId,
        idempotencyKey: input.idempotencyKey,
        run: async (ledger) => {
          const cap = D.assertMintWithinCap(mintedThisYearFromLedger(ledger) as D.Din, amount);
          if (!cap.ok) return cap;
          const posted = D.post(ledger, {
            idempotencyKey: input.idempotencyKey,
            postings: [
              { accountId: D.MINT_ACCOUNT_ID, amount: -amount },
              { accountId: input.accountId, amount },
            ],
            memo: input.memo ?? `mint ${input.amount} → ${input.accountId}`,
          });
          if (!posted.ok) return posted;
          return D.ok({ ledger: posted.value.state, tx: posted.value.tx, events: [] });
        },
      });
      const tx = requireTx(result);
      const balance = D.unwrap(D.balanceOf(result.ledger, input.accountId));
      return { txId: tx.id, accountId: input.accountId, balance, replayed: result.replayed };
    },
  },
  {
    method: 'post',
    path: '/wallet/burn',
    operationId: 'burn',
    summary: 'Burn dinar from a user account — overdraft-impossible (charter Article 4)',
    tag: 'wallet',
    security: 'admin',
    body: C.burnRequestSchema,
    response: C.walletMoveResponseSchema,
    handler: async ({ store }, { body }) => {
      const input = body as C.BurnRequest;
      const amount = D.unwrap(D.din(input.amount));
      const result = await store.apply({
        actor: 'admin',
        action: 'wallet.burn',
        target: input.accountId,
        idempotencyKey: input.idempotencyKey,
        run: async (ledger) => {
          const posted = D.post(ledger, {
            idempotencyKey: input.idempotencyKey,
            postings: [
              { accountId: input.accountId, amount: -amount },
              { accountId: D.BURN_ACCOUNT_ID, amount },
            ],
            memo: input.memo ?? `burn ${input.amount} ← ${input.accountId}`,
          });
          if (!posted.ok) return posted;
          return D.ok({ ledger: posted.value.state, tx: posted.value.tx, events: [] });
        },
      });
      const tx = requireTx(result);
      const balance = D.unwrap(D.balanceOf(result.ledger, input.accountId));
      return { txId: tx.id, accountId: input.accountId, balance, replayed: result.replayed };
    },
  },

  {
    method: 'post',
    path: '/escrows',
    operationId: 'createEscrow',
    summary: 'Create an escrow (CREATED; money not moved yet)',
    tag: 'escrows',
    security: 'admin',
    body: C.createEscrowRequestSchema,
    response: C.escrowActionResponseSchema,
    status: 201,
    handler: async ({ store }, { body }) => {
      const input = body as C.CreateEscrowRequest;
      const id = input.id ?? `esc_${randomUUID()}`;
      const nowIso = new Date().toISOString();
      const result = await store.apply({
        actor: 'admin',
        action: 'escrow.create',
        target: id,
        escrowId: id,
        idempotencyKey: input.idempotencyKey,
        run: (ledger, registry) =>
          D.createEscrow(ledger, registry, {
            id,
            buyerId: input.buyerId,
            sellerId: input.sellerId,
            amount: D.unwrap(D.din(input.amount)),
            ...(input.productRef !== undefined ? { productRef: input.productRef } : {}),
            ...(input.ttlHours !== undefined
              ? { expiresAt: new Date(Date.now() + input.ttlHours * 3_600_000).toISOString() }
              : {}),
            at: nowIso,
          }),
      });
      return escrowActionResponse(result);
    },
  },
  {
    method: 'get',
    path: '/escrows',
    operationId: 'listEscrows',
    summary: 'List escrows (optionally filtered by status)',
    tag: 'escrows',
    security: 'admin',
    query: z.object({ status: C.escrowStatusSchema.optional() }),
    response: C.escrowListResponseSchema,
    handler: async ({ store }, { query }) => ({
      items: (await store.listEscrows(query.status as C.EscrowStatusWire | undefined)).map(escrowToView),
    }),
  },
  {
    method: 'get',
    path: '/escrows/{id}',
    operationId: 'getEscrow',
    summary: 'Read one escrow (public transparency)',
    tag: 'escrows',
    security: 'public',
    params: z.object({ id: C.idSchema }),
    response: C.escrowViewSchema,
    handler: async ({ store }, { params }) => {
      const escrow = await store.getEscrow(params.id!);
      if (escrow === null) {
        throw new DomainFailure({ code: 'ESCROW_NOT_FOUND', message: `Escrow ${params.id} does not exist` });
      }
      return escrowToView(escrow);
    },
  },
  {
    method: 'post',
    path: '/escrows/{id}/fund',
    operationId: 'fundEscrow',
    summary: 'Lock buyer money into the escrow account',
    tag: 'escrows',
    security: 'admin',
    params: z.object({ id: C.idSchema }),
    body: C.fundEscrowRequestSchema,
    response: C.escrowActionResponseSchema,
    handler: async ({ store }, { params, body }) => {
      const input = body as C.FundEscrowRequest;
      const result = await store.apply({
        actor: 'admin',
        action: 'escrow.fund',
        target: params.id!,
        escrowId: params.id!,
        idempotencyKey: input.idempotencyKey,
        run: (ledger, registry) =>
          D.fundEscrow(ledger, registry, {
            escrowId: params.id!,
            ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          }),
      });
      return escrowActionResponse(result);
    },
  },
  {
    method: 'post',
    path: '/escrows/{id}/deliver',
    operationId: 'deliverEscrow',
    summary: 'Mark the product as delivered (money still locked)',
    tag: 'escrows',
    security: 'admin',
    params: z.object({ id: C.idSchema }),
    body: C.deliverEscrowRequestSchema,
    response: C.escrowActionResponseSchema,
    handler: async ({ store }, { params, body }) => {
      const input = body as C.DeliverEscrowRequest;
      const result = await store.apply({
        actor: 'admin',
        action: 'escrow.deliver',
        target: params.id!,
        escrowId: params.id!,
        run: (ledger, registry) =>
          D.deliverEscrow(ledger, registry, {
            escrowId: params.id!,
            ...(input.deliveryRef !== undefined ? { deliveryRef: input.deliveryRef } : {}),
          }),
      });
      return escrowActionResponse(result);
    },
  },
  {
    method: 'post',
    path: '/escrows/{id}/release',
    operationId: 'releaseEscrow',
    summary: 'Settle: seller gets net (90%), treasury gets tax (10%) — HITL gate ≥ 50,000 Đ',
    tag: 'escrows',
    security: 'admin',
    params: z.object({ id: C.idSchema }),
    body: C.releaseEscrowRequestSchema,
    response: C.escrowActionResponseSchema,
    handler: async ({ store }, { params, body }) => {
      const input = body as C.ReleaseEscrowRequest;
      const result = await store.apply({
        actor: 'admin',
        action: 'escrow.release',
        target: params.id!,
        escrowId: params.id!,
        idempotencyKey: input.idempotencyKey,
        run: (ledger, registry) =>
          D.releaseEscrow(ledger, registry, {
            escrowId: params.id!,
            ...(input.approvedByAdmin !== undefined ? { approvedByAdmin: input.approvedByAdmin } : {}),
            ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          }),
      });
      return escrowActionResponse(result);
    },
  },
  {
    method: 'post',
    path: '/escrows/{id}/dispute',
    operationId: 'disputeEscrow',
    summary: 'Open a dispute (escrow stays locked until arbitration)',
    tag: 'escrows',
    security: 'admin',
    params: z.object({ id: C.idSchema }),
    body: C.disputeEscrowRequestSchema,
    response: C.escrowActionResponseSchema,
    handler: async ({ store }, { params, body }) => {
      const input = body as C.DisputeEscrowRequest;
      const result = await store.apply({
        actor: 'admin',
        action: 'escrow.dispute',
        target: params.id!,
        escrowId: params.id!,
        run: (ledger, registry) =>
          D.disputeEscrow(ledger, registry, {
            escrowId: params.id!,
            reason: input.reason,
          }),
      });
      return escrowActionResponse(result);
    },
  },
  {
    method: 'post',
    path: '/escrows/{id}/refund',
    operationId: 'refundEscrow',
    summary: 'Arbitration in favor of the buyer — full refund, no tax',
    tag: 'escrows',
    security: 'admin',
    params: z.object({ id: C.idSchema }),
    body: C.refundEscrowRequestSchema,
    response: C.escrowActionResponseSchema,
    handler: async ({ store }, { params, body }) => {
      const input = body as C.RefundEscrowRequest;
      const result = await store.apply({
        actor: 'admin',
        action: 'escrow.refund',
        target: params.id!,
        escrowId: params.id!,
        idempotencyKey: input.idempotencyKey,
        run: (ledger, registry) =>
          D.refundEscrow(ledger, registry, {
            escrowId: params.id!,
            ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          }),
      });
      return escrowActionResponse(result);
    },
  },
  {
    method: 'post',
    path: '/escrows/{id}/cancel',
    operationId: 'cancelEscrow',
    summary: 'Cancel a CREATED escrow — no money ever moved',
    tag: 'escrows',
    security: 'admin',
    params: z.object({ id: C.idSchema }),
    body: C.cancelEscrowRequestSchema,
    response: C.escrowActionResponseSchema,
    handler: async ({ store }, { params, body }) => {
      const input = body as C.CancelEscrowRequest;
      const result = await store.apply({
        actor: 'admin',
        action: 'escrow.cancel',
        target: params.id!,
        escrowId: params.id!,
        run: (ledger, registry) => D.cancelEscrow(ledger, registry, { escrowId: params.id! }),
      });
      return escrowActionResponse(result);
    },
  },
  {
    method: 'post',
    path: '/escrows/{id}/expire',
    operationId: 'expireEscrow',
    summary: 'TTL sweep — auto-refund a FUNDED escrow (charter Article 9)',
    tag: 'escrows',
    security: 'admin',
    params: z.object({ id: C.idSchema }),
    body: C.expireEscrowRequestSchema,
    response: C.escrowActionResponseSchema,
    handler: async ({ store }, { params, body }) => {
      const input = body as C.ExpireEscrowRequest;
      const result = await store.apply({
        actor: 'admin',
        action: 'escrow.expire',
        target: params.id!,
        escrowId: params.id!,
        idempotencyKey: input.idempotencyKey,
        run: (ledger, registry) =>
          D.expireEscrow(ledger, registry, {
            escrowId: params.id!,
            ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          }),
      });
      return escrowActionResponse(result);
    },
  },

  // ── HITL queue (charter Article 7) — the bot creates, humans decide ──

  {
    method: 'post',
    path: '/hitl',
    operationId: 'createHitlRequest',
    summary: 'Queue a human-approval request (amount copied from the escrow; duplicate id → replay)',
    tag: 'hitl',
    security: 'admin',
    body: C.createHitlRequestSchema,
    response: C.hitlViewSchema,
    status: 201,
    handler: async ({ store }, { body }) => {
      const input = body as C.CreateHitlRequest;
      const escrow = await store.getEscrow(input.escrowId);
      if (escrow === null) {
        throw new DomainFailure({ code: 'ESCROW_NOT_FOUND', message: `Escrow ${input.escrowId} does not exist` });
      }
      if (escrow.status !== 'DELIVERED' && escrow.status !== 'DISPUTED') {
        throw new DomainFailure({
          code: 'INVALID_TRANSITION',
          message: `Escrow ${escrow.id} is ${escrow.status} — only DELIVERED or DISPUTED escrows need release approval`,
        });
      }
      if (!D.requiresHitl(escrow.amount)) {
        throw new DomainFailure({
          code: 'HITL_NOT_REQUIRED',
          message: `Release of ${escrow.amount} Đ is below the HITL threshold (${D.CHARTER.hitlThresholdDin} Đ) — release directly`,
        });
      }
      const ttlHours = input.ttlHours ?? 24;
      const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
      const id = input.id ?? `hitl_${randomUUID()}`;
      const existing = await store.getHitl(id);
      if (existing !== null) return hitlToView(existing); // replay-safe creation
      const row = await store.insertHitl({
        id,
        kind: input.kind,
        escrowId: escrow.id,
        amount: escrow.amount,
        requesterId: input.requesterId,
        ...(input.note !== undefined ? { note: input.note } : {}),
        expiresAt,
      });
      await store.prisma.auditLog.create({
        data: { actor: input.requesterId, action: 'hitl.create', target: escrow.id, meta: JSON.stringify({ hitlId: row.id, amount: row.amount }) },
      });
      return hitlToView(row);
    },
  },
  {
    method: 'get',
    path: '/hitl',
    operationId: 'listHitlRequests',
    summary: 'List HITL requests (optionally filtered by status)',
    tag: 'hitl',
    security: 'admin',
    query: z.object({ status: C.hitlStatusSchema.optional() }),
    response: C.hitlListResponseSchema,
    handler: async ({ store }, { query }) => ({
      items: (await store.listHitl(query.status as C.HitlStatusWire | undefined)).map(hitlToView),
    }),
  },
  {
    method: 'get',
    path: '/hitl/{id}',
    operationId: 'getHitlRequest',
    summary: 'Read one HITL request',
    tag: 'hitl',
    security: 'admin',
    params: z.object({ id: C.idSchema }),
    response: C.hitlViewSchema,
    handler: async ({ store }, { params }) => {
      const row = await store.getHitl(params.id!);
      if (row === null) {
        throw new DomainFailure({ code: 'HITL_NOT_FOUND', message: `HITL request ${params.id} does not exist` });
      }
      return hitlToView(row);
    },
  },
  {
    method: 'post',
    path: '/hitl/{id}/approve',
    operationId: 'approveHitlRequest',
    summary: 'Approve → ESCROW_RELEASE settles in the same transaction (seller 90% + treasury 10%)',
    tag: 'hitl',
    security: 'admin',
    params: z.object({ id: C.idSchema }),
    body: C.hitlDecisionRequestSchema,
    response: C.hitlActionResponseSchema,
    handler: async ({ store }, { params, body }) => {
      const input = body as C.HitlDecisionRequest;
      const row = await store.getHitl(params.id!);
      if (row === null) {
        throw new DomainFailure({ code: 'HITL_NOT_FOUND', message: `HITL request ${params.id} does not exist` });
      }
      const decided = await store.decideHitl({
        requestId: row.id,
        decision: 'APPROVED',
        decidedBy: input.decidedBy,
        ...(input.note !== undefined ? { decisionNote: input.note } : {}),
        execute: (ledger, registry) =>
          D.releaseEscrow(ledger, registry, {
            escrowId: row.escrowId,
            approvedByAdmin: true,
            idempotencyKey: `hitl:${row.id}:approve`,
          }),
      });
      return {
        request: hitlToView(decided.request),
        escrow: decided.escrow !== undefined ? escrowToView(decided.escrow) : null,
        txId: decided.tx?.id ?? null,
        replayed: decided.replayed,
      };
    },
  },
  {
    method: 'post',
    path: '/hitl/{id}/reject',
    operationId: 'rejectHitlRequest',
    summary: 'Reject — no money moves; the escrow stays locked until arbitration decides otherwise',
    tag: 'hitl',
    security: 'admin',
    params: z.object({ id: C.idSchema }),
    body: C.hitlDecisionRequestSchema,
    response: C.hitlActionResponseSchema,
    handler: async ({ store }, { params, body }) => {
      const input = body as C.HitlDecisionRequest;
      const row = await store.getHitl(params.id!);
      if (row === null) {
        throw new DomainFailure({ code: 'HITL_NOT_FOUND', message: `HITL request ${params.id} does not exist` });
      }
      const decided = await store.decideHitl({
        requestId: row.id,
        decision: 'REJECTED',
        decidedBy: input.decidedBy,
        ...(input.note !== undefined ? { decisionNote: input.note } : {}),
        execute: () => {
          // Unreachable for REJECTED — decideHitl only calls execute on APPROVED.
          throw new HttpFailure(500, 'INTERNAL', 'REJECTED decision must not execute a settlement.');
        },
      });
      return {
        request: hitlToView(decided.request),
        escrow: decided.escrow !== undefined ? escrowToView(decided.escrow) : null,
        txId: decided.tx?.id ?? null,
        replayed: decided.replayed,
      };
    },
  },
  {
    method: 'post',
    path: '/hitl/sweep',
    operationId: 'sweepHitl',
    summary: 'TTL sweep — expire overdue PENDING requests (bots call this on an interval)',
    tag: 'hitl',
    security: 'admin',
    response: C.hitlSweepResponseSchema,
    handler: async ({ store }) => ({ expired: await store.expireOverdueHitl(new Date()) }),
  },
];

function hitlToView(row: {
  id: string;
  kind: string;
  escrowId: string;
  amount: number;
  requesterId: string;
  note: string | null;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
}): C.HitlView {
  return {
    id: row.id,
    kind: row.kind as C.HitlKind,
    escrowId: row.escrowId,
    amount: row.amount,
    requesterId: row.requesterId,
    note: row.note,
    status: row.status as C.HitlStatusWire,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt !== null ? row.decidedAt.toISOString() : null,
    decisionNote: row.decisionNote,
  };
}
