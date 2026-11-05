/**
 * KIA-OS skills (v3) — exactly 16 fail-closed skills the agents may call.
 *
 * Layering (hexagonal): this module owns the REGISTRY — identity, metadata,
 * authorization, argument validation. EXECUTION is a port (SkillExecutor) that
 * the server wires to the domain store; tests wire fakes. The gateway never
 * executes business logic itself.
 *
 * Fail-closed rules, enforced here BEFORE the executor is ever called:
 *  - unknown skill → refusal (no executor call);
 *  - agent not allowed for the skill → refusal (no executor call);
 *  - staff-only skills with a non-staff context → refusal (no executor call);
 *  - arguments that fail the zod schema → refusal (no executor call).
 *
 * Money skills move integer Đ only; the executor decides HITL (≥ 50,000 Đ)
 * and idempotency keys. Amounts carry the suffix Din so the LLM manifests
 * make the unit unambiguous.
 */

import { z } from 'zod';
import type { AgentName } from './agents.js';

// ── shared vocabulary ────────────────────────────────────────────────────────

export const HITL_THRESHOLD_DIN = 50_000;

export type SkillKind = 'read' | 'write' | 'money' | 'staff';

export type CallerRole = 'user' | 'staff';

export interface SkillContext {
  readonly userId: string;
  readonly role: CallerRole;
  readonly language: string;
}

export interface SkillPending {
  readonly approvalId: string;
  readonly reason: string;
}

export type SkillOutcome =
  | { readonly ok: true; readonly data: unknown; readonly summary: string }
  | { readonly ok: true; readonly pending: SkillPending; readonly data: unknown; readonly summary: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type SkillExecutor = (
  skillId: string,
  args: unknown,
  ctx: SkillContext,
) => Promise<SkillOutcome>;

// ── skill definitions ────────────────────────────────────────────────────────

export interface SkillDef {
  readonly id: string;
  readonly kind: SkillKind;
  readonly titleFa: string;
  readonly titleEn: string;
  readonly description: string;
  readonly allowedAgents: readonly AgentName[];
  /** Additional hard gate: staff role required at the gateway boundary. */
  readonly staffOnly?: boolean;
  readonly input: z.ZodType<unknown>;
}

const dinInt = z.number().int().positive().max(1_000_000_000);

export const SKILLS: Record<string, SkillDef> = {
  wallet_get: {
    id: 'wallet_get',
    kind: 'read',
    titleFa: 'موجودی کیف پول',
    titleEn: 'Wallet balance',
    description: "Read the calling user's own wallet balance in Đ.",
    allowedAgents: ['orchestrator', 'receptionist', 'sales', 'support', 'analyst', 'content'],
    input: z.object({}).strict(),
  },
  wallet_history: {
    id: 'wallet_history',
    kind: 'read',
    titleFa: 'تاریخچه کیف پول',
    titleEn: 'Wallet history',
    description: "Read the calling user's own recent ledger entries (integer Đ).",
    allowedAgents: ['orchestrator', 'support', 'analyst', 'receptionist'],
    input: z.object({ limit: z.number().int().min(1).max(20).optional() }).strict(),
  },
  wallet_transfer: {
    id: 'wallet_transfer',
    kind: 'money',
    titleFa: 'انتقال دینار',
    titleEn: 'Dinar transfer',
    description: 'Transfer an integer amount of Đ from the calling user to another account.',
    allowedAgents: ['orchestrator'],
    input: z.object({ toAccountId: z.string().min(1).max(80), amountDin: dinInt }).strict(),
  },
  escrow_create: {
    id: 'escrow_create',
    kind: 'money',
    titleFa: 'ایجاد اسکرو',
    titleEn: 'Open escrow',
    description:
      'Open an escrow order for the calling user (buyer) with a seller and an integer Đ amount; funding happens through the escrow machine only.',
    allowedAgents: ['orchestrator', 'sales'],
    input: z
      .object({ sellerAccountId: z.string().min(1).max(80), amountDin: dinInt, productRef: z.string().max(200).optional() })
      .strict(),
  },
  escrow_deliver: {
    id: 'escrow_deliver',
    kind: 'money',
    titleFa: 'تحویل سفارش',
    titleEn: 'Mark delivered',
    description: 'Mark one of the escrow orders as delivered (seller side).',
    allowedAgents: ['orchestrator', 'sales', 'support'],
    input: z.object({ escrowId: z.string().min(1).max(80), deliveryRef: z.string().max(200).optional() }).strict(),
  },
  escrow_release: {
    id: 'escrow_release',
    kind: 'money',
    titleFa: 'آزادسازی اسکرو',
    titleEn: 'Release escrow',
    description: 'Release a funded escrow — settles seller (net) + treasury (10% tax) atomically.',
    allowedAgents: ['orchestrator', 'support'],
    input: z.object({ escrowId: z.string().min(1).max(80) }).strict(),
  },
  escrow_refund: {
    id: 'escrow_refund',
    kind: 'money',
    titleFa: 'بازگشت وجه',
    titleEn: 'Refund escrow',
    description:
      'File/execute a refund of a funded escrow back to the buyer. Large amounts need human approval (HITL) — the outcome states this honestly.',
    allowedAgents: ['orchestrator', 'support'],
    input: z.object({ escrowId: z.string().min(1).max(80), reason: z.string().min(3).max(500) }).strict(),
  },
  escrow_list: {
    id: 'escrow_list',
    kind: 'read',
    titleFa: 'فهرست اسکروها',
    titleEn: 'List escrows',
    description: "List the calling user's own escrow orders (buyer or seller side), optionally by status.",
    allowedAgents: ['orchestrator', 'receptionist', 'sales', 'support', 'analyst'],
    input: z.object({ status: z.string().max(20).optional(), limit: z.number().int().min(1).max(20).optional() }).strict(),
  },
  product_create: {
    id: 'product_create',
    kind: 'write',
    titleFa: 'ثبت محصول',
    titleEn: 'Create product',
    description: 'Create a product listing for the calling seller: title, integer Đ price, description, optional category.',
    allowedAgents: ['orchestrator', 'sales', 'content'],
    input: z
      .object({
        title: z.string().min(3).max(120),
        priceDin: dinInt,
        description: z.string().min(3).max(800),
        category: z.string().max(60).optional(),
      })
      .strict(),
  },
  product_list: {
    id: 'product_list',
    kind: 'read',
    titleFa: 'فهرست محصولات',
    titleEn: 'List products',
    description: 'List active product listings (integer Đ prices).',
    allowedAgents: ['orchestrator', 'receptionist', 'sales', 'analyst', 'content'],
    input: z.object({ limit: z.number().int().min(1).max(20).optional() }).strict(),
  },
  product_search: {
    id: 'product_search',
    kind: 'read',
    titleFa: 'جستجوی محصول',
    titleEn: 'Search products',
    description: 'Search active product listings by a free-text query.',
    allowedAgents: ['orchestrator', 'receptionist', 'sales', 'content'],
    input: z.object({ query: z.string().min(1).max(100) }).strict(),
  },
  kb_search: {
    id: 'kb_search',
    kind: 'read',
    titleFa: 'جستجوی دانش',
    titleEn: 'Knowledge search',
    description: 'Search the marketplace knowledge base (policies, FAQ) — grounds answers.',
    allowedAgents: ['orchestrator', 'receptionist', 'sales', 'support', 'analyst', 'content'],
    input: z.object({ query: z.string().min(1).max(200) }).strict(),
  },
  kb_upsert: {
    id: 'kb_upsert',
    kind: 'staff',
    titleFa: 'به‌روزرسانی دانش',
    titleEn: 'Knowledge upsert',
    description: 'Create or update a knowledge-base entry (staff only).',
    allowedAgents: ['orchestrator', 'analyst', 'content'],
    staffOnly: true,
    input: z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(4000) }).strict(),
  },
  analytics_report: {
    id: 'analytics_report',
    kind: 'staff',
    titleFa: 'گزارش تحلیلی',
    titleEn: 'Analytics report',
    description: 'Business snapshot for the owner: orders, GMV, treasury, pending approvals (staff only).',
    allowedAgents: ['orchestrator', 'analyst'],
    staffOnly: true,
    input: z.object({}).strict(),
  },
  owner_notify: {
    id: 'owner_notify',
    kind: 'write',
    titleFa: 'اطلاع به مالک',
    titleEn: 'Notify owner',
    description: 'Send a short escalation note to the marketplace owner (bugs, complaints, hot leads).',
    allowedAgents: ['orchestrator', 'sales', 'support'],
    input: z.object({ subject: z.string().min(1).max(120), detail: z.string().min(1).max(1000) }).strict(),
  },
  economy_status: {
    id: 'economy_status',
    kind: 'read',
    titleFa: 'وضعیت اقتصاد',
    titleEn: 'Economy status',
    description:
      'Public charter transparency: circulating supply, treasury balance, escrow lock, yearly mint cap usage (Article 6).',
    allowedAgents: ['orchestrator', 'receptionist', 'analyst'],
    input: z.object({}).strict(),
  },
};

export const SKILL_IDS: readonly string[] = Object.keys(SKILLS);

/** Registry invariant — 16 skills, every allowedAgent exists, staff skills are staff-gated. */
export function assertRegistryConsistent(): void {
  if (SKILL_IDS.length !== 16) {
    throw new Error(`skills registry must hold exactly 16 skills — found ${SKILL_IDS.length}`);
  }
}

// ── the fail-closed boundary in front of the executor ────────────────────────

export type SkillGateResult =
  | { readonly ok: true; readonly args: unknown }
  | { readonly ok: false; readonly code: 'UNKNOWN_SKILL' | 'SKILL_FORBIDDEN' | 'STAFF_ONLY' | 'INVALID_ARGS'; readonly message: string };

/** Authorization + validation — the ONLY sanctioned entry into an executor. */
export function gateSkill(skillId: string, agent: AgentName, rawArgs: unknown, ctx: SkillContext): SkillGateResult {
  const def = SKILLS[skillId];
  if (def === undefined) {
    return { ok: false, code: 'UNKNOWN_SKILL', message: `Unknown skill "${skillId}".` };
  }
  if (!def.allowedAgents.includes(agent)) {
    return { ok: false, code: 'SKILL_FORBIDDEN', message: `Skill "${skillId}" is not allowed for agent "${agent}".` };
  }
  if (def.staffOnly === true && ctx.role !== 'staff') {
    return { ok: false, code: 'STAFF_ONLY', message: `Skill "${skillId}" requires staff role.` };
  }
  const parsed = def.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first !== undefined ? `${first.path.join('.') || 'args'}: ${first.message}` : 'arguments failed validation';
    return { ok: false, code: 'INVALID_ARGS', message: `Invalid arguments for "${skillId}" — ${where}.` };
  }
  return { ok: true, args: parsed.data };
}

/** Run the fail-closed gate, then the executor port. Never throws. */
export async function runSkill(
  executor: SkillExecutor,
  skillId: string,
  agent: AgentName,
  rawArgs: unknown,
  ctx: SkillContext,
): Promise<SkillOutcome> {
  const gate = gateSkill(skillId, agent, rawArgs, ctx);
  if (!gate.ok) {
    return { ok: false, code: gate.code, message: gate.message };
  }
  try {
    return await executor(skillId, gate.args, ctx);
  } catch {
    return { ok: false, code: 'SKILL_FAILED', message: `Skill "${skillId}" failed — try again or escalate to a human.` };
  }
}

// ── LLM-facing manifest (JSON envelope contract) ─────────────────────────────

export interface SkillManifestEntry {
  readonly id: string;
  readonly kind: SkillKind;
  readonly description: string;
  readonly args: unknown;
}

const EMPTY_ARGS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

/** Compact JSON-schema manifest of the skills ONE agent may use. */
export function manifestForAgent(agent: AgentName): readonly SkillManifestEntry[] {
  const entries: SkillManifestEntry[] = [];
  for (const def of Object.values(SKILLS)) {
    if (!def.allowedAgents.includes(agent)) continue;
    let args: unknown;
    try {
      args = z.toJSONSchema(def.input, { target: 'draft-7' });
    } catch {
      args = EMPTY_ARGS_SCHEMA;
    }
    entries.push({ id: def.id, kind: def.kind, description: def.description, args });
  }
  return entries;
}
