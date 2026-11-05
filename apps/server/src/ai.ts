/**
 * Server-side AI assembly — wires the pure ai-gateway to Prisma + the domain.
 *
 *  - PrismaUsageMeter: per-user daily token cap, persisted (transparent bill).
 *  - PrismaAuditSink: every AI outcome lands in AuditLog (action `ai.<outcome>`).
 *  - createServerSkillExecutor: the 16 KIA-OS skills mapped onto V3Store /
 *    Product / KbEntry / the HITL queue. The gateway already ran the
 *    fail-closed authorization gate (agent allow-list, staff-only, arg
 *    schemas) BEFORE this executor is called — this layer only executes.
 *
 * Money rules (charter): integer Đ only; release ≥ 50,000 Đ files a HITL
 * request (the domain enforces it again inside releaseEscrow — two nets);
 * refunds move escrow → buyer with no tax; failed domain closures are typed
 * outcomes, never exceptions.
 *
 * Identity convention (same as the bot): numeric Telegram ids normalize to
 * account ids `user:tg:<id>`; full account ids pass through.
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import * as D from '@dropagentx/domain';
import type { LlmConfig } from '@dropagentx/llm';
import { createLlmClient } from '@dropagentx/llm';
import {
  AiGateway,
  ProviderChain,
  redact,
  type AiAuditEvent,
  type AuditSink,
  type ChainEntry,
  type SkillContext,
  type SkillExecutor,
  type SkillOutcome,
  type UsageMeter,
} from '@dropagentx/ai-gateway';
import { DomainFailure } from './errors.js';
import type { V3Store } from './persistence.js';

const HITL_THRESHOLD_DIN = 50_000;

/** Numeric Telegram id → user:tg:<id>; already-normalized ids pass through. */
export function normalizeAccountId(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return `user:tg:${trimmed}`;
  return trimmed;
}

// ── meter ────────────────────────────────────────────────────────────────────

interface MeterRec {
  readonly userId: string;
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly kind: 'chat' | 'route';
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/**
 * The UsageMeter port is synchronous (the gateway must gate BEFORE any provider
 * call), while Prisma is async. Strategy: a per-user day cache is refreshed by
 * `ensureAllowance()` before each ask; `record()` queues rows and updates the
 * cache immediately; `flush()` persists the queue — the route handler awaits it.
 */
export class PrismaUsageMeter implements UsageMeter {
  private readonly cache = new Map<string, { day: string; used: number }>();
  private readonly pending: MeterRec[] = [];

  constructor(
    private readonly prisma: PrismaClient,
    readonly dailyTokenCap: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private dayKey(): string {
    const n = this.now();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString().slice(0, 10);
  }

  /** Precompute today's spend so the synchronous gate is exact. */
  async ensureAllowance(userId: string): Promise<void> {
    const agg = await this.prisma.aiUsage.aggregate({
      _sum: { totalTokens: true },
      where: { userId, at: { gte: new Date(`${this.dayKey()}T00:00:00.000Z`) } },
    });
    this.cache.set(userId, { day: this.dayKey(), used: agg._sum.totalTokens ?? 0 });
  }

  checkAllowance(userId: string): { ok: true } | { ok: false; code: 'AI_BUDGET_EXCEEDED'; message: string; usedToday: number; cap: number } {
    const cached = this.cache.get(userId);
    const used = cached !== undefined && cached.day === this.dayKey() ? cached.used : 0;
    if (used >= this.dailyTokenCap) {
      return {
        ok: false,
        code: 'AI_BUDGET_EXCEEDED',
        message: `Daily AI budget exhausted — ${used} of ${this.dailyTokenCap} tokens used today. Try again tomorrow or contact staff.`,
        usedToday: used,
        cap: this.dailyTokenCap,
      };
    }
    return { ok: true };
  }

  record(rec: MeterRec): void {
    this.pending.push(rec);
    const cached = this.cache.get(rec.userId);
    const prior = cached !== undefined && cached.day === this.dayKey() ? cached.used : 0;
    this.cache.set(rec.userId, { day: this.dayKey(), used: prior + Math.max(0, rec.totalTokens) });
  }

  async flush(): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length);
    if (batch.length === 0) return;
    await this.prisma.aiUsage.createMany({
      data: batch.map((r) => ({
        userId: r.userId,
        agent: r.agent,
        provider: r.provider,
        model: r.model,
        kind: r.kind,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        totalTokens: r.totalTokens,
        outcome: 'ok',
      })),
    });
  }

  async usedTodayOf(userId: string): Promise<number> {
    const agg = await this.prisma.aiUsage.aggregate({
      _sum: { totalTokens: true },
      where: { userId, at: { gte: new Date(`${this.dayKey()}T00:00:00.000Z`) } },
    });
    return agg._sum.totalTokens ?? 0;
  }
}

// ── audit ────────────────────────────────────────────────────────────────────

export class PrismaAuditSink implements AuditSink {
  constructor(private readonly prisma: PrismaClient) {}

  async record(event: AiAuditEvent): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actor: event.userId,
        action: `ai.${event.outcome}`,
        target: event.agent,
        meta: JSON.stringify({
          provider: event.provider,
          model: event.model,
          skill: event.skill,
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
          redactions: event.redactions,
          code: event.code,
          ...(event.meta ?? {}),
        }),
      },
    });
  }
}

// ── the 16 skills wired to the domain ────────────────────────────────────────

export interface ServerExecutorDeps {
  readonly store: V3Store;
  readonly prisma: PrismaClient;
}

function escrowView(e: D.Escrow): Record<string, unknown> {
  return {
    id: e.id,
    buyerId: e.buyerId,
    sellerId: e.sellerId,
    amountDin: e.amount,
    status: e.status,
    productRef: e.productRef ?? null,
  };
}

function toSkillFailure(err: unknown): SkillOutcome {
  if (err instanceof DomainFailure) {
    return { ok: false, code: err.error.code, message: err.error.message };
  }
  return { ok: false, code: 'SKILL_FAILED', message: 'The action failed — try again or escalate to a human.' };
}

export function createServerSkillExecutor(deps: ServerExecutorDeps): SkillExecutor {
  const { store, prisma } = deps;

  return async (skillId, rawArgs, ctx): Promise<SkillOutcome> => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const actor = normalizeAccountId(ctx.userId);
    try {
      switch (skillId) {
        case 'wallet_get': {
          const balance = await store.balanceOf(actor);
          if (balance === null) return { ok: false, code: 'UNKNOWN_ACCOUNT', message: `No wallet found for ${actor}.` };
          return { ok: true, data: { accountId: actor, balanceDin: balance }, summary: `Balance: ${balance} Đ.` };
        }
        case 'wallet_history': {
          const limit = typeof args.limit === 'number' ? args.limit : 5;
          const account = await store.balanceOf(actor);
          if (account === null) return { ok: false, code: 'UNKNOWN_ACCOUNT', message: `No wallet found for ${actor}.` };
          const entries = await store.recentPostingsFor(actor, limit);
          return {
            ok: true,
            data: { entries: entries.map((e) => ({ txId: e.txId, amountDin: e.amount, memo: e.memo, at: e.at })) },
            summary: entries.length > 0 ? `${entries.length} recent ledger entries.` : 'No ledger entries yet.',
          };
        }
        case 'wallet_transfer': {
          const amount = D.unwrap(D.din(Number(args.amountDin)));
          const to = normalizeAccountId(String(args.toAccountId));
          const ik = `ai:${randomUUID()}`;
          const result = await store.apply({
            actor,
            action: 'wallet.transfer',
            target: to,
            idempotencyKey: ik,
            run: (ledger) => {
              const posted = D.post(ledger, {
                idempotencyKey: ik,
                memo: `AI transfer ${actor} → ${to}`,
                postings: [
                  { accountId: actor, amount: -amount },
                  { accountId: to, amount },
                ],
              });
              if (!posted.ok) return posted;
              return D.ok({ ledger: posted.value.state, tx: posted.value.tx, events: [] });
            },
          });
          if (!result.replayed && result.tx === undefined) {
            return { ok: false, code: 'TRANSFER_FAILED', message: 'Transfer rejected by the ledger.' };
          }
          return { ok: true, data: { txId: result.tx?.id ?? null, amountDin: amount }, summary: `Transferred ${amount} Đ to ${to}.` };
        }
        case 'escrow_create': {
          const amount = D.unwrap(D.din(Number(args.amountDin)));
          const id = `esc_${randomUUID()}`;
          const sellerId = normalizeAccountId(String(args.sellerAccountId));
          const result = await store.apply({
            actor,
            action: 'escrow.create',
            target: id,
            escrowId: id,
            idempotencyKey: `ai:${randomUUID()}`,
            run: (ledger, registry) =>
              D.createEscrow(ledger, registry, {
                id,
                buyerId: actor,
                sellerId,
                amount: D.unwrap(D.din(amount)),
                ...(typeof args.productRef === 'string' ? { productRef: args.productRef } : {}),
              }),
          });
          const escrow = result.escrow;
          if (escrow === undefined) return { ok: false, code: 'ESCROW_FAILED', message: 'Escrow rejected by the domain.' };
          if (amount >= HITL_THRESHOLD_DIN) {
            const hitlRow = await store.insertHitl({
              id: `hitl-${randomUUID()}`,
              kind: 'ESCROW_RELEASE',
              escrowId: escrow.id,
              amount,
              requesterId: actor,
              note: `AI-filed escrow ≥ 50,000 Đ (seller ${sellerId}) — release requires human approval.`,
              expiresAt: new Date(Date.now() + 24 * 3_600_000),
            });
            const hitlId = hitlRow.id;
            return {
              ok: true,
              pending: { approvalId: hitlId, reason: `Escrow of ${amount} Đ ≥ 50,000 Đ — release needs human approval.` },
              data: { escrowId: escrow.id, amountDin: amount, hitlId },
              summary: `Escrow ${escrow.id} created (${amount} Đ); HITL approval ${hitlId} filed for its release. Next step: the buyer funds it.`,
            };
          }
          return { ok: true, data: { escrowId: escrow.id, amountDin: amount }, summary: `Escrow ${escrow.id} created — ${amount} Đ, buyer ${actor}, seller ${sellerId}.` };
        }
        case 'escrow_deliver': {
          const escrowId = String(args.escrowId);
          const escrow = await store.getEscrow(escrowId);
          if (escrow === null) return { ok: false, code: 'ESCROW_NOT_FOUND', message: `Escrow ${escrowId} not found.` };
          if (escrow.sellerId !== actor) return { ok: false, code: 'FORBIDDEN', message: 'Only the seller can mark the order delivered.' };
          const result = await store.apply({
            actor,
            action: 'escrow.deliver',
            target: escrowId,
            escrowId,
            idempotencyKey: `ai:${randomUUID()}`,
            run: (ledger, registry) =>
              D.deliverEscrow(ledger, registry, {
                escrowId,
                ...(typeof args.deliveryRef === 'string' ? { deliveryRef: args.deliveryRef } : {}),
              }),
          });
          return result.escrow !== undefined
            ? { ok: true, data: { escrowId, status: result.escrow.status }, summary: `Escrow ${escrowId} marked DELIVERED — awaiting buyer release.` }
            : { ok: false, code: 'ESCROW_FAILED', message: 'Deliver rejected by the state machine.' };
        }
        case 'escrow_release': {
          const escrowId = String(args.escrowId);
          const escrow = await store.getEscrow(escrowId);
          if (escrow === null) return { ok: false, code: 'ESCROW_NOT_FOUND', message: `Escrow ${escrowId} not found.` };
          if (escrow.buyerId !== actor && escrow.sellerId !== actor) {
            return { ok: false, code: 'FORBIDDEN', message: 'Only the buyer or seller can release this escrow.' };
          }
          const amount = escrow.amount;
          if (amount >= HITL_THRESHOLD_DIN) {
            const hitlRow = await store.insertHitl({
              id: `hitl-${randomUUID()}`,
              kind: 'ESCROW_RELEASE',
              escrowId,
              amount,
              requesterId: actor,
              note: 'AI-filed release ≥ 50,000 Đ — settles seller 90% + treasury 10% atomically on approval.',
              expiresAt: new Date(Date.now() + 24 * 3_600_000),
            });
            const hitlId = hitlRow.id;
            return {
              ok: true,
              pending: { approvalId: hitlId, reason: `Release of ${amount} Đ ≥ 50,000 Đ needs human approval.` },
              data: { hitlId, escrowId },
              summary: `Release filed for approval (${hitlId}) — nothing moved yet.`,
            };
          }
          const result = await store.apply({
            actor,
            action: 'escrow.release',
            target: escrowId,
            escrowId,
            idempotencyKey: `ai:${randomUUID()}`,
            run: (ledger, registry) => D.releaseEscrow(ledger, registry, { escrowId }),
          });
          return result.tx !== undefined && result.escrow !== undefined
            ? { ok: true, data: { escrowId, settleTxId: result.tx.id }, summary: `Released: seller gets 90% (${Math.floor(amount * 0.9)} Đ), treasury 10% (${amount - Math.floor(amount * 0.9)} Đ).` }
            : { ok: false, code: 'ESCROW_FAILED', message: 'Release rejected by the state machine.' };
        }
        case 'escrow_refund': {
          const escrowId = String(args.escrowId);
          const reason = redact(String(args.reason ?? 'AI-filed refund')).slice(0, 500);
          const escrow = await store.getEscrow(escrowId);
          if (escrow === null) return { ok: false, code: 'ESCROW_NOT_FOUND', message: `Escrow ${escrowId} not found.` };
          if (escrow.buyerId !== actor && escrow.sellerId !== actor) {
            return { ok: false, code: 'FORBIDDEN', message: 'Only the buyer or seller can request a refund.' };
          }
          const amount = escrow.amount;
          if (amount >= HITL_THRESHOLD_DIN) {
            const hitlRow = await store.insertHitl({
              id: `hitl-${randomUUID()}`,
              kind: 'ESCROW_RELEASE',
              escrowId,
              amount,
              requesterId: actor,
              note: `AI-filed refund ≥ 50,000 Đ — reason: ${reason.slice(0, 300)}`,
              expiresAt: new Date(Date.now() + 24 * 3_600_000),
            });
            const hitlId = hitlRow.id;
            return {
              ok: true,
              pending: { approvalId: hitlId, reason: `Refund of ${amount} Đ ≥ 50,000 Đ needs human approval.` },
              data: { hitlId, escrowId },
              summary: `Refund filed for approval (${hitlId}) — nothing moved yet.`,
            };
          }
          // Domain rule: refund requires DISPUTED. File the dispute, then refund — one command each.
          const disputed = await store.apply({
            actor,
            action: 'escrow.dispute',
            target: escrowId,
            escrowId,
            idempotencyKey: `ai:${randomUUID()}`,
            run: (ledger, registry) => D.disputeEscrow(ledger, registry, { escrowId, reason }),
          });
          if (disputed.escrow?.status !== 'DISPUTED') {
            return { ok: false, code: 'ESCROW_FAILED', message: 'Dispute rejected by the state machine.' };
          }
          const result = await store.apply({
            actor,
            action: 'escrow.refund',
            target: escrowId,
            escrowId,
            idempotencyKey: `ai:${randomUUID()}`,
            run: (ledger, registry) => D.refundEscrow(ledger, registry, { escrowId }),
          });
          return result.tx !== undefined && result.escrow !== undefined
            ? { ok: true, data: { escrowId, refundTxId: result.tx.id }, summary: `Refunded ${amount} Đ to the buyer — full amount, no tax on refunds.` }
            : { ok: false, code: 'ESCROW_FAILED', message: 'Refund rejected by the state machine.' };
        }
        case 'escrow_list': {
          const all = await store.listEscrows();
          const mine = all.filter((e) => e.buyerId === actor || e.sellerId === actor);
          const limit = typeof args.limit === 'number' ? args.limit : 10;
          const statusFilter = typeof args.status === 'string' && args.status.length > 0 ? args.status.toUpperCase() : null;
          const items = mine.filter((e) => (statusFilter === null ? true : e.status === statusFilter)).slice(0, limit);
          return { ok: true, data: { escrows: items.map(escrowView) }, summary: `${items.length} escrow(s) involving ${actor}.` };
        }
        case 'product_create': {
          const title = redact(String(args.title)).slice(0, 120);
          const product = await prisma.product.create({
            data: {
              id: `prod-${randomUUID()}`,
              sellerId: actor,
              title,
              description: redact(String(args.description)).slice(0, 800),
              priceDin: Number(args.priceDin),
              ...(typeof args.category === 'string' ? { category: redact(args.category).slice(0, 60) } : {}),
            },
          });
          return { ok: true, data: { productId: product.id, priceDin: product.priceDin }, summary: `Product "${title}" listed at ${product.priceDin} Đ.` };
        }
        case 'product_list': {
          const limit = typeof args.limit === 'number' ? args.limit : 10;
          const items = await prisma.product.findMany({ where: { active: true }, take: limit, orderBy: { createdAt: 'desc' } });
          return {
            ok: true,
            data: { products: items.map((p) => ({ id: p.id, title: p.title, priceDin: p.priceDin, sellerId: p.sellerId })) },
            summary: items.length > 0 ? `${items.length} active product(s).` : 'No products listed yet.',
          };
        }
        case 'product_search': {
          const query = redact(String(args.query)).slice(0, 100);
          const items = await prisma.product.findMany({
            where: { active: true, OR: [{ title: { contains: query } }, { description: { contains: query } }] },
            take: 10,
            orderBy: { createdAt: 'desc' },
          });
          return {
            ok: true,
            data: { products: items.map((p) => ({ id: p.id, title: p.title, priceDin: p.priceDin })) },
            summary: items.length > 0 ? `${items.length} match(es) for "${query}".` : `No products matched "${query}".`,
          };
        }
        case 'kb_search': {
          const query = redact(String(args.query)).slice(0, 200);
          const items = await prisma.kbEntry.findMany({
            take: 5,
            where: { OR: [{ title: { contains: query } }, { body: { contains: query } }] },
          });
          return {
            ok: true,
            data: { entries: items.map((k) => ({ title: k.title, body: k.body })) },
            summary: items.length > 0 ? `${items.length} knowledge entry(ies) matched.` : 'No knowledge entries matched.',
          };
        }
        case 'kb_upsert': {
          const title = redact(String(args.title)).slice(0, 200);
          const body = redact(String(args.body)).slice(0, 4000);
          const existing = await prisma.kbEntry.findFirst({ where: { title } });
          const saved = existing
            ? await prisma.kbEntry.update({ where: { id: existing.id }, data: { body } })
            : await prisma.kbEntry.create({ data: { id: `kb-${randomUUID()}`, title, body } });
          return {
            ok: true,
            data: { kbId: saved.id, title: saved.title },
            summary: existing ? `Knowledge entry "${title}" updated.` : `Knowledge entry "${title}" created.`,
          };
        }
        case 'analytics_report': {
          const [accounts, escrows, economy, pendingHitl] = await Promise.all([
            store.listAccountsWithBalances(),
            store.listEscrows(),
            store.economySummary(),
            store.listHitl('PENDING'),
          ]);
          const users = accounts.filter((a) => a.id.startsWith('user:'));
          const activeEscrows = escrows.filter((e) => e.status === 'FUNDED' || e.status === 'DELIVERED' || e.status === 'DISPUTED');
          return {
            ok: true,
            data: {
              users: users.length,
              activeEscrows: activeEscrows.length,
              pendingHitl: pendingHitl.length,
              circulatingSupplyDin: economy.circulatingSupply,
              treasuryDin: economy.treasuryBalance,
              balanced: economy.balanced,
            },
            summary: `${users.length} users · ${activeEscrows.length} active escrows · ${pendingHitl.length} HITL pending · supply ${economy.circulatingSupply} Đ.`,
          };
        }
        case 'owner_notify': {
          const subject = redact(String(args.subject)).slice(0, 120);
          const detail = redact(String(args.detail)).slice(0, 1000);
          await prisma.auditLog.create({
            data: { actor, action: 'ai.owner_notify', target: 'owner', meta: JSON.stringify({ subject, detail }) },
          });
          return { ok: true, data: { notified: true }, summary: `Owner notified: "${subject}".` };
        }
        case 'economy_status': {
          const economy = await store.economySummary();
          return {
            ok: true,
            data: economy,
            summary: `Supply ${economy.circulatingSupply} Đ · treasury ${economy.treasuryBalance} Đ · escrow locked ${economy.escrowLocked} Đ · balanced ${economy.balanced}.`,
          };
        }
        default:
          return { ok: false, code: 'UNKNOWN_SKILL', message: `Skill "${skillId}" has no server binding.` };
      }
    } catch (err) {
      return toSkillFailure(err);
    }
  };
}

// ── gateway assembly ─────────────────────────────────────────────────────────

export interface BuildAiGatewayOptions {
  readonly store: V3Store;
  readonly prisma: PrismaClient;
  readonly providers: readonly { readonly name: string; readonly config: LlmConfig }[];
  readonly dailyTokenCap: number;
}

export interface AssembledAi {
  readonly gateway: AiGateway;
  readonly meter: PrismaUsageMeter;
}

export function buildAiGateway(options: BuildAiGatewayOptions): AssembledAi {
  const entries: ChainEntry[] = options.providers.map((p) => ({ name: p.name, client: createLlmClient(p.config) }));
  const chain = new ProviderChain(entries);
  const meter = new PrismaUsageMeter(options.prisma, options.dailyTokenCap);
  const audit = new PrismaAuditSink(options.prisma);
  const executor = createServerSkillExecutor({ store: options.store, prisma: options.prisma });
  const gateway = new AiGateway({ chain, executor, meter, audit });
  return { gateway, meter };
}
