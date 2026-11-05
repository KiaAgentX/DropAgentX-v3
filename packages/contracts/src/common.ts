/**
 * Common wire primitives shared by every endpoint contract (ADR-005).
 *
 * Money on the wire is an integer number of Đ (dinar) — mirrors ADR-002.
 * Error codes are intentionally a loose `string` on the wire: the domain may
 * grow new codes without breaking old clients; codes are additive only.
 */

import { z } from 'zod';

/** 1 Đ = 1 integer unit. Never a float, never negative. */
export const DNX = z.number().int().min(0).max(9_007_199_254_740_991);

/** Signed integer ledger amount (postings may be negative). */
export const SIGNED_INT = z.number().int().min(-9_007_199_254_740_991).max(9_007_199_254_740_991);

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_.-]+$/, 'ids may only contain letters, digits, : _ . -');

export const idempotencyKeySchema = z.string().min(8).max(128);

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  meta: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const ESCROW_STATUSES = [
  'CREATED',
  'FUNDED',
  'DELIVERED',
  'RELEASED',
  'DISPUTED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
] as const;

export const escrowStatusSchema = z.enum(ESCROW_STATUSES);
export type EscrowStatusWire = z.infer<typeof escrowStatusSchema>;
