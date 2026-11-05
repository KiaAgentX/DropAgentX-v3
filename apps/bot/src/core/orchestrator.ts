/**
 * Orchestrator — the PURE conversation core of the v3 bot (Phase 3).
 *
 * No grammY here: this module never knows Telegram's wire format. The glue
 * (telegram/bot.ts) maps updates to actors + text and sends the replies back.
 * Everything money-shaped goes through the typed contracts client to the v3
 * server, with DETERMINISTIC idempotency keys — a retried webhook or a
 * double-clicked button can never move money twice (ROADMAP phase-3 gate).
 *
 * Authorization (fail-closed, orchestrator-enforced):
 *   the server is admin-keyed (the bot is a trusted service), so user-scoping
 *   happens HERE: an actor may only act on escrows where they are the buyer
 *   (fund/release/dispute/cancel) or the seller (deliver).
 */

import * as D from '@dropagentx/domain';
import type { EscrowView, V3Client } from '@dropagentx/contracts';
import { accountIdForTelegram, resolveAccountRef } from '../identity.js';
import { errorKey, fmtDin, isLocale, t, type Locale } from '../i18n.js';

export type { Locale };

export interface InlineButton {
  readonly text: string;
  readonly callbackData: string;
}

export interface BotReply {
  readonly text: string;
  readonly keyboard?: readonly InlineButton[][];
}

export interface AdminPing {
  readonly text: string;
  readonly keyboard?: readonly InlineButton[][];
}

export interface BotOutcome {
  readonly reply: BotReply;
  readonly notifyAdmin?: AdminPing;
  readonly notifyRequester?: { readonly telegramId: string; readonly text: string };
}

export interface BotActor {
  readonly telegramId: string;
  readonly username?: string;
  readonly chatId: string;
  readonly isAdmin: boolean;
}

export interface CommandInput {
  readonly text: string;
  /** Per-message id (Telegram message_id) — seeds the deterministic idempotency keys. */
  readonly commandId: string;
}

export interface OrchestratorOptions {
  readonly v3: V3Client;
  readonly defaultLocale?: Locale;
  readonly hitlTtlHours?: number;
  readonly escrowTtlHours?: number;
}

const MAX_DIN = 9_007_199_254_740_991;

/**
 * Wire → domain money. Safe by construction: the contracts layer already
 * validated the number against the DNX schema (integer, ≥ 0, ≤ 2^53−1) —
 * this is only the brand crossing back into the pure domain (ADR-002).
 */
const asDin = (n: number): D.Din => n as D.Din;

export class Orchestrator {
  private readonly locales = new Map<string, Locale>();

  constructor(private readonly opts: OrchestratorOptions) {}

  private localeOf(actor: BotActor): Locale {
    return this.locales.get(actor.telegramId) ?? this.opts.defaultLocale ?? 'fa';
  }

  private fmt(locale: Locale, amount: number): string {
    return fmtDin(locale, amount);
  }

  private errText(locale: Locale, code: string, message: string): string {
    const key = errorKey(code);
    return key === 'errGeneric'
      ? t(locale, 'errGeneric', { code, message })
      : t(locale, key);
  }

  /** Create the account silently; DUPLICATE_ACCOUNT is the healthy replay path. */
  private async ensureAccount(locale: Locale, accountId: string): Promise<string | null> {
    const res = await this.opts.v3.createAccount({ id: accountId });
    if (res.ok) return null;
    if (res.error.code === 'DUPLICATE_ACCOUNT') return null;
    return this.errText(locale, res.error.code, res.error.message);
  }

  private async balanceText(locale: Locale, actor: BotActor): Promise<string> {
    const account = accountIdForTelegram(actor.telegramId);
    const ensured = await this.ensureAccount(locale, account);
    if (ensured !== null) return ensured;
    const res = await this.opts.v3.balance(account);
    if (!res.ok) return this.errText(locale, res.error.code, res.error.message);
    return t(locale, 'balanceLine', { account, balance: this.fmt(locale, res.value.balance) });
  }

  // ── dispatch ──

  async handle(actor: BotActor, input: CommandInput): Promise<BotOutcome> {
    const locale = this.localeOf(actor);
    const text = input.text.trim();
    if (!text.startsWith('/')) {
      return { reply: { text: t(locale, 'unknownCommand') } };
    }
    const [rawCommand = '', ...args] = text.slice(1).split(/\s+/);
    const command = rawCommand.split('@')[0]?.toLowerCase() ?? '';

    try {
      switch (command) {
        case 'start':
          return await this.start(actor, locale);
        case 'help':
          return { reply: { text: this.helpText(actor, locale) } };
        case 'balance':
          return { reply: { text: await this.balanceText(locale, actor) } };
        case 'economy':
          return { reply: { text: await this.economyText(locale) } };
        case 'buy':
          return await this.buy(actor, locale, args, input.commandId);
        case 'fund':
          return await this.fund(actor, locale, args);
        case 'orders':
          return await this.orders(actor, locale);
        case 'deliver':
          return await this.deliver(actor, locale, args);
        case 'release':
          return await this.release(actor, locale, args, input.commandId);
        case 'dispute':
          return await this.dispute(actor, locale, args);
        case 'cancel':
          return await this.cancel(actor, locale, args);
        case 'whoami':
          return { reply: { text: this.whoamiText(actor, locale) } };
        case 'lang': {
          const next = args[0]?.toLowerCase() ?? '';
          if (!isLocale(next)) return { reply: { text: t(locale, 'errUnknownLang') } };
          this.locales.set(actor.telegramId, next);
          return { reply: { text: t(next, 'langSwitched') } };
        }
        case 'pending':
          return await this.pending(actor, locale);
        case 'approve':
          return await this.decide(actor, locale, args, 'APPROVED');
        case 'reject':
          return await this.decide(actor, locale, args, 'REJECTED');
        case 'mint':
          return await this.mint(actor, locale, args);
        case 'sweep':
          return await this.sweep(actor, locale);
        default:
          return { reply: { text: t(locale, 'unknownCommand') } };
      }
    } catch (err) {
      // Nothing may crash the bot loop — the last line of defense is honest.
      const reason = err instanceof Error ? err.message.slice(0, 160) : 'unknown failure';
      return { reply: { text: t(locale, 'errGeneric', { code: 'UNEXPECTED', message: reason }) } };
    }
  }

  /** Inline-keyboard callback: hitl:approve:<id> | hitl:reject:<id> — admin only.
   *  The id itself contains colons, so only the first two segments are structural. */
  async handleCallback(actor: BotActor, data: string): Promise<BotOutcome> {
    const locale = this.localeOf(actor);
    const [prefix = '', action = '', ...rest] = data.split(':');
    const hitlId = rest.join(':');
    if (prefix !== 'hitl' || (action !== 'approve' && action !== 'reject') || hitlId.length === 0) {
      return { reply: { text: t(locale, 'unknownCommand') } };
    }
    if (!actor.isAdmin) return { reply: { text: t(locale, 'adminOnly') } };
    return await this.decide(actor, locale, [action, hitlId], action === 'approve' ? 'APPROVED' : 'REJECTED');
  }

  // ── user flows ──

  private async start(actor: BotActor, locale: Locale): Promise<BotOutcome> {
    const balance = await this.balanceText(locale, actor);
    const name = actor.username !== undefined ? `@${actor.username}` : actor.telegramId;
    const account = accountIdForTelegram(actor.telegramId);
    const balancePart = balance.includes('\n') ? balance.split('\n').pop() ?? balance : balance;
    return { reply: { text: `${t(locale, 'welcome', { name, account, balance: balancePart })}\n\n${this.helpText(actor, locale)}` } };
  }

  private helpText(actor: BotActor, locale: Locale): string {
    return actor.isAdmin ? t(locale, 'help') + t(locale, 'helpAdmin') : t(locale, 'help');
  }

  private whoamiText(actor: BotActor, locale: Locale): string {
    return t(locale, 'whoamiLine', {
      tg: actor.telegramId,
      account: accountIdForTelegram(actor.telegramId),
      locale,
      admin: actor.isAdmin ? '✓' : '✗',
    });
  }

  private async economyText(locale: Locale): Promise<string> {
    const res = await this.opts.v3.economy();
    if (!res.ok) return this.errText(locale, res.error.code, res.error.message);
    const s = res.value;
    const balanceLine = s.balanced
      ? t(locale, 'economyBalanced')
      : t(locale, 'economyUnbalanced', { value: s.trialBalanceSum });
    return [
      t(locale, 'economyHeader'),
      t(locale, 'economyCirculating', { value: this.fmt(locale, s.circulatingSupply) }),
      t(locale, 'economyTreasury', { value: this.fmt(locale, s.treasuryBalance) }),
      t(locale, 'economyLocked', { value: this.fmt(locale, s.escrowLocked) }),
      balanceLine,
    ].join('\n');
  }

  private parseAmount(raw: string | undefined): number | null {
    if (raw === undefined || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_DIN) return null;
    return n;
  }

  private async buy(actor: BotActor, locale: Locale, args: readonly string[], commandId: string): Promise<BotOutcome> {
    const amount = this.parseAmount(args[0]);
    if (amount === null) return { reply: { text: t(locale, 'buyUsage') } };
    const seller = resolveAccountRef(args[1] ?? '');
    if (seller === null) return { reply: { text: t(locale, 'errSellerRef') } };
    const buyer = accountIdForTelegram(actor.telegramId);
    if (buyer === seller) {
      return { reply: { text: this.errText(locale, 'INVALID_ACCOUNT_KIND', 'buyer = seller') } };
    }
    const product = args.slice(2).join(' ').slice(0, 128);

    const ensuredBuyer = await this.ensureAccount(locale, buyer);
    if (ensuredBuyer !== null) return { reply: { text: ensuredBuyer } };
    const ensuredSeller = await this.ensureAccount(locale, seller);
    if (ensuredSeller !== null) return { reply: { text: ensuredSeller } };

    const escrowId = `esc:buy:${actor.telegramId}:${commandId}`;
    const created = await this.opts.v3.createEscrow({
      id: escrowId,
      buyerId: buyer,
      sellerId: seller,
      amount,
      ...(product.length > 0 ? { productRef: product } : {}),
      ttlHours: this.opts.escrowTtlHours ?? 72,
    });
    // Replay path: the SAME message id delivered twice (webhook retry) already
    // created this escrow — fetch it and continue; the fund below replays honestly.
    let escrow: EscrowView;
    if (created.ok) {
      escrow = created.value.escrow;
    } else if (created.error.code === 'ESCROW_ALREADY_EXISTS') {
      const existing = await this.opts.v3.getEscrow(escrowId);
      if (!existing.ok) return { reply: { text: this.errText(locale, existing.error.code, existing.error.message) } };
      if (existing.value.buyerId !== buyer) {
        return { reply: { text: this.errText(locale, 'INVALID_ACCOUNT_KIND', 'escrow owned by another buyer') } };
      }
      escrow = existing.value;
    } else {
      return { reply: { text: this.errText(locale, created.error.code, created.error.message) } };
    }

    const funded = await this.opts.v3.fundEscrow(escrow.id, { idempotencyKey: `fund:${escrow.id}` });
    if (!funded.ok) {
      // Honest partial state: the escrow exists (CREATED) but nothing is locked yet.
      return {
        reply: {
          text: t(locale, 'buyFailed', {
            escrow: escrow.id,
            error: this.errText(locale, funded.error.code, funded.error.message),
          }),
        },
      };
    }
    return {
      reply: {
        text: t(locale, 'buyOk', { escrow: escrow.id, amount: this.fmt(locale, amount), seller }),
      },
    };
  }

  private async fund(actor: BotActor, locale: Locale, args: readonly string[]): Promise<BotOutcome> {
    const escrowId = args[0]?.trim() ?? '';
    if (escrowId.length === 0) return { reply: { text: t(locale, 'errEscrowNotFound') } };
    const loaded = await this.opts.v3.getEscrow(escrowId);
    if (!loaded.ok) return { reply: { text: this.errText(locale, loaded.error.code, loaded.error.message) } };
    if (loaded.value.buyerId !== accountIdForTelegram(actor.telegramId)) {
      return { reply: { text: t(locale, 'notYourEscrow') } };
    }
    const funded = await this.opts.v3.fundEscrow(escrowId, { idempotencyKey: `fund:${escrowId}` });
    if (!funded.ok) return { reply: { text: this.errText(locale, funded.error.code, funded.error.message) } };
    return {
      reply: { text: t(locale, 'fundOk', { escrow: escrowId, amount: this.fmt(locale, loaded.value.amount) }) },
    };
  }

  private async orders(actor: BotActor, locale: Locale): Promise<BotOutcome> {
    const me = accountIdForTelegram(actor.telegramId);
    const res = await this.opts.v3.listEscrows();
    if (!res.ok) return { reply: { text: this.errText(locale, res.error.code, res.error.message) } };
    const mine = res.value.items.filter((e) => e.buyerId === me || e.sellerId === me);
    if (mine.length === 0) return { reply: { text: t(locale, 'ordersEmpty') } };
    const lines = mine.map((e) =>
      t(locale, 'orderLine', {
        escrow: e.id,
        amount: this.fmt(locale, e.amount),
        status: e.status,
        product: e.productRef !== null ? ` — ${e.productRef}` : '',
      }),
    );
    return { reply: { text: `${t(locale, 'ordersHeader')}\n${lines.join('\n')}` } };
  }

  private async loadOwnedEscrow(
    actor: BotActor,
    locale: Locale,
    escrowId: string,
    side: 'buyer' | 'seller',
  ): Promise<{ ok: true; escrow: EscrowView } | { ok: false; outcome: BotOutcome }> {
    if (escrowId.length === 0) {
      return { ok: false, outcome: { reply: { text: t(locale, 'errEscrowNotFound') } } };
    }
    const res = await this.opts.v3.getEscrow(escrowId);
    if (!res.ok) {
      return { ok: false, outcome: { reply: { text: this.errText(locale, res.error.code, res.error.message) } } };
    }
    const expected = accountIdForTelegram(actor.telegramId);
    const owner = side === 'buyer' ? res.value.buyerId : res.value.sellerId;
    if (owner !== expected) {
      return { ok: false, outcome: { reply: { text: t(locale, 'notYourEscrow') } } };
    }
    return { ok: true, escrow: res.value };
  }

  private async deliver(actor: BotActor, locale: Locale, args: readonly string[]): Promise<BotOutcome> {
    const escrowId = args[0]?.trim() ?? '';
    const owned = await this.loadOwnedEscrow(actor, locale, escrowId, 'seller');
    if (!owned.ok) return owned.outcome;
    const res = await this.opts.v3.deliverEscrow(escrowId, { idempotencyKey: `deliver:${escrowId}` });
    if (!res.ok) return { reply: { text: this.errText(locale, res.error.code, res.error.message) } };
    return { reply: { text: t(locale, 'deliverOk', { escrow: escrowId }) } };
  }

  private async release(actor: BotActor, locale: Locale, args: readonly string[], commandId: string): Promise<BotOutcome> {
    const escrowId = args[0]?.trim() ?? '';
    const owned = await this.loadOwnedEscrow(actor, locale, escrowId, 'buyer');
    if (!owned.ok) return owned.outcome;
    const escrow = owned.escrow;
    if (!D.requiresHitl(asDin(escrow.amount))) {
      const res = await this.opts.v3.releaseEscrow(escrowId, { idempotencyKey: `release:${escrowId}` });
      if (!res.ok) return { reply: { text: this.errText(locale, res.error.code, res.error.message) } };
      const split = D.unwrap(D.splitSellerTax(asDin(escrow.amount)));
      return {
        reply: {
          text: t(locale, 'releaseOk', {
            net: this.fmt(locale, split.seller),
            tax: this.fmt(locale, split.tax),
            txId: res.value.txId ?? '—',
          }),
        },
      };
    }

    // Article 7 — human in the loop. Deterministic per message; re-filing the
    // SAME message replays, a NEW message opens a fresh request.
    const hitlId = `hitl:release:${escrowId}:${commandId}`;
    const filed = await this.opts.v3.createHitlRequest({
      id: hitlId,
      kind: 'ESCROW_RELEASE',
      escrowId,
      requesterId: accountIdForTelegram(actor.telegramId),
      ...(actor.username !== undefined ? { note: `@${actor.username}` } : {}),
      ttlHours: this.opts.hitlTtlHours ?? 24,
    });
    if (!filed.ok) return { reply: { text: this.errText(locale, filed.error.code, filed.error.message) } };
    const split = D.unwrap(D.splitSellerTax(asDin(escrow.amount)));
    const notifyText = t(locale, 'hitlNotify', {
      id: filed.value.id,
      escrow: escrow.id,
      amount: this.fmt(locale, escrow.amount),
      requester: filed.value.requesterId,
      net: this.fmt(locale, split.seller),
      tax: this.fmt(locale, split.tax),
    });
    return {
      reply: {
        text: t(locale, 'releasePending', { amount: this.fmt(locale, escrow.amount), hitl: filed.value.id }),
      },
      notifyAdmin: {
        text: notifyText,
        keyboard: [
          [
            { text: t(locale, 'kbApprove'), callbackData: `hitl:approve:${filed.value.id}` },
            { text: t(locale, 'kbReject'), callbackData: `hitl:reject:${filed.value.id}` },
          ],
        ],
      },
    };
  }

  private async dispute(actor: BotActor, locale: Locale, args: readonly string[]): Promise<BotOutcome> {
    const escrowId = args[0]?.trim() ?? '';
    const reason = args.slice(1).join(' ').trim();
    const owned = await this.loadOwnedEscrow(actor, locale, escrowId, 'buyer');
    if (!owned.ok) return owned.outcome;
    if (reason.length === 0) {
      return { reply: { text: this.errText(locale, 'INVALID_TRANSITION', 'empty reason') } };
    }
    const res = await this.opts.v3.disputeEscrow(escrowId, { reason });
    if (!res.ok) return { reply: { text: this.errText(locale, res.error.code, res.error.message) } };
    return { reply: { text: t(locale, 'disputeOk', { escrow: escrowId }) } };
  }

  private async cancel(actor: BotActor, locale: Locale, args: readonly string[]): Promise<BotOutcome> {
    const escrowId = args[0]?.trim() ?? '';
    const owned = await this.loadOwnedEscrow(actor, locale, escrowId, 'buyer');
    if (!owned.ok) return owned.outcome;
    const res = await this.opts.v3.cancelEscrow(escrowId, { idempotencyKey: `cancel:${escrowId}` });
    if (!res.ok) return { reply: { text: this.errText(locale, res.error.code, res.error.message) } };
    return { reply: { text: t(locale, 'cancelOk', { escrow: escrowId }) } };
  }

  // ── admin flows ──

  private async pending(actor: BotActor, locale: Locale): Promise<BotOutcome> {
    if (!actor.isAdmin) return { reply: { text: t(locale, 'adminOnly') } };
    const res = await this.opts.v3.listHitl('PENDING');
    if (!res.ok) return { reply: { text: this.errText(locale, res.error.code, res.error.message) } };
    if (res.value.items.length === 0) return { reply: { text: t(locale, 'pendingEmpty') } };
    const lines = res.value.items.map((r) =>
      t(locale, 'pendingLine', { id: r.id, escrow: r.escrowId, amount: this.fmt(locale, r.amount), requester: r.requesterId }),
    );
    return { reply: { text: `${t(locale, 'pendingHeader')}\n${lines.join('\n')}` } };
  }

  private async decide(actor: BotActor, locale: Locale, args: readonly string[], decision: 'APPROVED' | 'REJECTED'): Promise<BotOutcome> {
    if (!actor.isAdmin) return { reply: { text: t(locale, 'adminOnly') } };
    // args from /approve <id> → [id]; from callback → [action, id].
    const hitlId = args.length >= 2 ? args[1] ?? '' : args[0] ?? '';
    if (hitlId.length === 0) return { reply: { text: t(locale, 'errHITLNotFound') } };

    const loaded = await this.opts.v3.getHitl(hitlId);
    if (!loaded.ok) return { reply: { text: this.errText(locale, loaded.error.code, loaded.error.message) } };
    const request = loaded.value;

    const decided =
      decision === 'APPROVED'
        ? await this.opts.v3.approveHitl(hitlId, { decidedBy: 'admin:kia-owner' })
        : await this.opts.v3.rejectHitl(hitlId, { decidedBy: 'admin:kia-owner' });
    if (!decided.ok) return { reply: { text: this.errText(locale, decided.error.code, decided.error.message) } };

    const settled = decided.value.escrow !== null;
    const split = D.unwrap(D.splitSellerTax(asDin(request.amount)));
    const replyText =
      decision === 'APPROVED'
        ? t(locale, 'approved', {
            id: hitlId,
            net: settled ? this.fmt(locale, split.seller) : '—',
            tax: settled ? this.fmt(locale, split.tax) : '—',
          })
        : t(locale, 'rejected', { id: hitlId });

    const requesterTg = /^(\d+)$/.exec(request.requesterId.replace(/^user:tg:/, ''))?.[1];
    const outcome: BotOutcome = {
      reply: { text: replyText },
      ...(requesterTg !== undefined && decided.value.replayed === false
        ? {
            notifyRequester: {
              telegramId: requesterTg,
              text:
                decision === 'APPROVED'
                  ? t(locale, 'releaseOk', {
                      net: settled ? this.fmt(locale, split.seller) : '—',
                      tax: settled ? this.fmt(locale, split.tax) : '—',
                      txId: decided.value.txId ?? '—',
                    })
                  : t(locale, 'rejected', { id: hitlId }),
            },
          }
        : {}),
    };
    return outcome;
  }

  private async mint(actor: BotActor, locale: Locale, args: readonly string[]): Promise<BotOutcome> {
    if (!actor.isAdmin) return { reply: { text: t(locale, 'adminOnly') } };
    const account = resolveAccountRef(args[0] ?? '');
    const amount = this.parseAmount(args[1]);
    if (account === null || amount === null) return { reply: { text: t(locale, 'mintUsage') } };
    // The ledger refuses postings to unknown accounts — onboard first, mint second.
    const ensured = await this.ensureAccount(locale, account);
    if (ensured !== null) return { reply: { text: ensured } };
    const res = await this.opts.v3.mint({ accountId: account, amount, memo: 'bot mint' });
    if (!res.ok) return { reply: { text: this.errText(locale, res.error.code, res.error.message) } };
    return {
      reply: { text: t(locale, 'minted', { amount: this.fmt(locale, amount), account, balance: this.fmt(locale, res.value.balance) }) },
    };
  }

  private async sweep(actor: BotActor, locale: Locale): Promise<BotOutcome> {
    if (!actor.isAdmin) return { reply: { text: t(locale, 'adminOnly') } };
    const res = await this.opts.v3.sweepHitl();
    if (!res.ok) return { reply: { text: this.errText(locale, res.error.code, res.error.message) } };
    return { reply: { text: t(locale, 'sweepDone', { count: res.value.expired }) } };
  }
}
