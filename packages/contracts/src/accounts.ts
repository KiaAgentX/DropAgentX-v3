/**
 * Account / balance contracts.
 */

import { z } from 'zod';
import { DNX, idSchema } from './common.js';

export const createAccountRequestSchema = z.object({
  id: idSchema,
  label: z.string().max(120).optional(),
});

export const accountViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string().nullable(),
  balance: z.number().int(),
  createdAt: z.string(),
});

export const accountListResponseSchema = z.object({
  items: z.array(accountViewSchema),
});

export const balanceResponseSchema = z.object({
  accountId: z.string(),
  balance: DNX,
});

export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;
export type AccountView = z.infer<typeof accountViewSchema>;
export type BalanceResponse = z.infer<typeof balanceResponseSchema>;
