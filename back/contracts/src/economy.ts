/**
 * Economy transparency contracts (charter Article 6 — شفافیت).
 * Read-only, public: the nation can always audit its own money.
 */

import { z } from 'zod';
import { DNX } from './common.js';

export const economySummarySchema = z.object({
  currency: z.literal('DNX'),
  symbol: z.literal('Đ'),
  circulatingSupply: DNX,
  treasuryBalance: DNX,
  escrowLocked: DNX,
  mintedAllTime: DNX,
  burnedAllTime: DNX,
  mintedThisYear: DNX,
  yearlyMintCap: DNX,
  genesisSupply: DNX,
  trialBalanceSum: z.number().int(),
  balanced: z.boolean(),
  accountCount: z.number().int(),
  openEscrows: z.number().int(),
});

export type EconomySummary = z.infer<typeof economySummarySchema>;
