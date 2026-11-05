/**
 * HITL (human-in-the-loop) queue contracts — charter Article 7.
 *
 * Money actions ≥ 50,000 Đ must pass a human approval. The queue lives on the
 * server (single source of truth shared by bot and dashboard); the bot creates
 * requests and admins decide. An approval of kind ESCROW_RELEASE executes the
 * settlement atomically with the decision — decision + money move is one
 * transaction, and the release idempotency key is deterministic
 * (`hitl:<id>:approve`) so a retry can never pay twice.
 */

import { z } from 'zod';
import { DNX, idSchema, idempotencyKeySchema } from './common.js';
import { escrowViewSchema } from './escrows.js';

export const HITL_KINDS = ['ESCROW_RELEASE'] as const;
export const hitlKindSchema = z.enum(HITL_KINDS);
export type HitlKind = z.infer<typeof hitlKindSchema>;

export const HITL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export const hitlStatusSchema = z.enum(HITL_STATUSES);
export type HitlStatusWire = z.infer<typeof hitlStatusSchema>;

export const createHitlRequestSchema = z.object({
  /** Deterministic id enables replay-safe creation: duplicate id returns the existing request. */
  id: idSchema.optional(),
  kind: hitlKindSchema,
  escrowId: idSchema,
  /** Account id of the human who asked (e.g. user:tg:123) — carried for the audit trail. */
  requesterId: idSchema,
  /** Free-text context for the approver (username, product, reason). */
  note: z.string().max(500).optional(),
  /** Queue TTL in hours (default 24 on the server; overdue PENDING → EXPIRED). */
  ttlHours: z.number().int().min(1).max(720).optional(),
});

export const hitlDecisionRequestSchema = z.object({
  /** Account id of the human who decided (audit trail). */
  decidedBy: idSchema,
  note: z.string().max(500).optional(),
});

export const hitlViewSchema = z.object({
  id: z.string(),
  kind: hitlKindSchema,
  escrowId: z.string(),
  amount: DNX,
  requesterId: z.string(),
  note: z.string().nullable(),
  status: hitlStatusSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
});

export const hitlListResponseSchema = z.object({
  items: z.array(hitlViewSchema),
});

export const hitlSweepResponseSchema = z.object({
  expired: z.number().int().min(0),
});

export const hitlActionResponseSchema = z.object({
  request: hitlViewSchema,
  /** Set result — only for APPROVED on ESCROW_RELEASE; null when nothing moved. */
  escrow: escrowViewSchema.nullable(),
  txId: z.string().nullable(),
  replayed: z.boolean(),
});

export type CreateHitlRequest = z.infer<typeof createHitlRequestSchema>;
export type HitlDecisionRequest = z.infer<typeof hitlDecisionRequestSchema>;
export type HitlView = z.infer<typeof hitlViewSchema>;
export type HitlListResponse = z.infer<typeof hitlListResponseSchema>;
export type HitlSweepResponse = z.infer<typeof hitlSweepResponseSchema>;
export type HitlActionResponse = z.infer<typeof hitlActionResponseSchema>;
