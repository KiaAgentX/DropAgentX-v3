/**
 * Escrow contracts — the marketplace spine (ADR-004, charter Article 8).
 */

import { z } from 'zod';
import { DNX, escrowStatusSchema, idSchema, idempotencyKeySchema } from './common.js';

export const createEscrowRequestSchema = z.object({
  id: idSchema.optional(), // server generates when omitted; duplicates rejected
  buyerId: idSchema,
  sellerId: idSchema,
  amount: DNX,
  productRef: z.string().max(128).optional(),
  ttlHours: z.number().int().min(1).max(720).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const escrowViewSchema = z.object({
  id: z.string(),
  buyerId: z.string(),
  sellerId: z.string(),
  amount: DNX,
  productRef: z.string().nullable(),
  status: escrowStatusSchema,
  createdAt: z.string(),
  fundedTxId: z.string().nullable(),
  settleTxId: z.string().nullable(),
  disputeReason: z.string().nullable(),
  deliveryRef: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

export const escrowListResponseSchema = z.object({
  items: z.array(escrowViewSchema),
});

export const fundEscrowRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const deliverEscrowRequestSchema = z.object({
  deliveryRef: z.string().max(256).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const releaseEscrowRequestSchema = z.object({
  /** Article 7 — must be explicitly true for amounts ≥ 50,000 Đ. Never implicit. */
  approvedByAdmin: z.boolean().optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const disputeEscrowRequestSchema = z.object({
  reason: z.string().min(1).max(500),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const refundEscrowRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const cancelEscrowRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const expireEscrowRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const escrowActionResponseSchema = z.object({
  escrow: escrowViewSchema,
  txId: z.string().nullable(),
  replayed: z.boolean(),
});

export type CreateEscrowRequest = z.infer<typeof createEscrowRequestSchema>;
export type EscrowView = z.infer<typeof escrowViewSchema>;
export type EscrowActionResponse = z.infer<typeof escrowActionResponseSchema>;
export type FundEscrowRequest = z.infer<typeof fundEscrowRequestSchema>;
export type DeliverEscrowRequest = z.infer<typeof deliverEscrowRequestSchema>;
export type ReleaseEscrowRequest = z.infer<typeof releaseEscrowRequestSchema>;
export type DisputeEscrowRequest = z.infer<typeof disputeEscrowRequestSchema>;
export type RefundEscrowRequest = z.infer<typeof refundEscrowRequestSchema>;
export type CancelEscrowRequest = z.infer<typeof cancelEscrowRequestSchema>;
export type ExpireEscrowRequest = z.infer<typeof expireEscrowRequestSchema>;
