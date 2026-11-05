/**
 * System meta contracts (health).
 */

import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('dropagentx-v3-server'),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
