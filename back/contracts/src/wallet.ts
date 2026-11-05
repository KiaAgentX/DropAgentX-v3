/**
 * Wallet contracts — mint & burn (charter Articles 3, 4).
 * Mint/burn are admin-service actions in the Phase-2 service API;
 * the user-facing facade arrives with the bot in Phase 3.
 */

import { z } from 'zod';
import { DNX, idSchema, idempotencyKeySchema } from './common.js';

export const mintRequestSchema = z.object({
  accountId: idSchema,
  amount: DNX,
  memo: z.string().max(200).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const burnRequestSchema = z.object({
  accountId: idSchema,
  amount: DNX,
  memo: z.string().max(200).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const walletMoveResponseSchema = z.object({
  txId: z.string(),
  accountId: z.string(),
  balance: z.number().int(),
  replayed: z.boolean(),
});

export type MintRequest = z.infer<typeof mintRequestSchema>;
export type BurnRequest = z.infer<typeof burnRequestSchema>;
export type WalletMoveResponse = z.infer<typeof walletMoveResponseSchema>;
