/**
 * Per-user consumption metering (PRODUCT-THESIS layer 3: "AI Add-on with a
 * spend cap and a transparent per-user bill").
 *
 * The meter is a port: the server persists rows via Prisma (auditable bills),
 * tests and simple deployments use the in-memory implementation below.
 * Fail-closed: when the daily cap is exhausted, the gateway refuses BEFORE any
 * provider call — an exhausted budget can never produce a surprise bill.
 */

export interface UsageRecord {
  readonly userId: string;
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly kind: 'chat' | 'route';
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly at: string; // ISO instant
}

export type MeterAllowance =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'AI_BUDGET_EXCEEDED'; readonly message: string; readonly usedToday: number; readonly cap: number };

export interface UsageMeter {
  /** Called BEFORE any provider call. */
  checkAllowance(userId: string): MeterAllowance;
  /** Called after every provider call (success or failure with known usage). */
  record(rec: Omit<UsageRecord, 'at'> & { readonly at?: string }): void;
}

export interface UsageMeterOptions {
  /** Per-user, per-UTC-day token cap. Default 120,000 — generous for chat, hostile to runaway loops. */
  readonly dailyTokenCap?: number;
  readonly now?: () => Date;
}

interface DayUsage {
  readonly day: string;
  used: number;
}

export interface InMemoryMeter extends UsageMeter {
  /** Tokens the user has spent on the current UTC day. */
  usedToday(userId: string): number;
  readonly dailyTokenCap: number;
}

/** In-memory, day-bucketed, deterministic (UTC days) — fits tests and single-process deploys. */
export function createInMemoryMeter(options: UsageMeterOptions = {}): InMemoryMeter {
  const cap = options.dailyTokenCap ?? 120_000;
  const now = options.now ?? (() => new Date());
  const byUser = new Map<string, DayUsage>();

  function dayKey(): string {
    return now().toISOString().slice(0, 10);
  }

  function used(userId: string): number {
    const current = byUser.get(userId);
    return current !== undefined && current.day === dayKey() ? current.used : 0;
  }

  return {
    dailyTokenCap: cap,
    checkAllowance(userId: string): MeterAllowance {
      const usedNow = used(userId);
      if (usedNow >= cap) {
        return {
          ok: false,
          code: 'AI_BUDGET_EXCEEDED',
          message: `Daily AI budget exhausted — ${usedNow} of ${cap} tokens used today. Try again tomorrow or contact staff.`,
          usedToday: usedNow,
          cap,
        };
      }
      return { ok: true };
    },
    record(rec): void {
      const day = dayKey();
      const current = byUser.get(rec.userId);
      const prior = current !== undefined && current.day === day ? current.used : 0;
      byUser.set(rec.userId, { day, used: prior + Math.max(0, rec.totalTokens) });
    },
    usedToday(userId: string): number {
      return used(userId);
    },
  };
}

// ── audit ────────────────────────────────────────────────────────────────────

export interface AiAuditEvent {
  readonly at: string;
  readonly userId: string;
  readonly agent: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly skill: string | null;
  readonly outcome: 'ok' | 'refused' | 'failed' | 'pending';
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly redactions: number;
  readonly code: string | null;
  readonly meta?: Readonly<Record<string, string | number>>;
}

export interface AuditSink {
  record(event: AiAuditEvent): void | Promise<void>;
}

/** Collecting sink for tests; the server wires a Prisma-backed sink instead. */
export function createCollectingSink(): AuditSink & { events: AiAuditEvent[] } {
  const events: AiAuditEvent[] = [];
  return { events, record(event) { events.push(event); } };
}
