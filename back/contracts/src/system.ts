/**
 * System meta contracts (health).
 * LLM fields (ADR-006) expose CONFIGURATION presence only — never the key,
 * never the base URL. A null model means the AI cycle is disabled.
 */

import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('dropagentx-v3-server'),
  version: z.string(),
  llmConfigured: z.boolean(),
  llmModel: z.string().nullable(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
