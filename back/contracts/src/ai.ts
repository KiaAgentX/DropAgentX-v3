/**
 * AI cycle contracts (Phase 5) — the Zenovix gateway over the wire (ADR-005).
 *
 * The AI layer is OPT-IN infrastructure: every response is audited on the
 * server, metered per user with a daily token cap, and redacted before it
 * leaves the process. Staff-only execution (role: "staff") requires the
 * admin key — the handler verifies it fail-closed.
 */

import { z } from 'zod';
import { idSchema } from './common.js';

export const AI_AGENT_NAMES = ['orchestrator', 'receptionist', 'sales', 'support', 'analyst', 'content'] as const;
export const aiAgentNameSchema = z.enum(AI_AGENT_NAMES);
export type AiAgentName = z.infer<typeof aiAgentNameSchema>;

export const AI_SKILL_KINDS = ['read', 'write', 'money', 'staff'] as const;
export const aiSkillKindSchema = z.enum(AI_SKILL_KINDS);

export const aiAgentViewSchema = z.object({
  name: aiAgentNameSchema,
  emoji: z.string(),
  titleFa: z.string(),
  titleEn: z.string(),
  description: z.string(),
  skills: z.array(z.string()),
});

export const aiSkillViewSchema = z.object({
  id: z.string(),
  kind: aiSkillKindSchema,
  titleFa: z.string(),
  titleEn: z.string(),
  description: z.string(),
  allowedAgents: z.array(aiAgentNameSchema),
  staffOnly: z.boolean(),
});

export const aiAgentsListResponseSchema = z.object({ items: z.array(aiAgentViewSchema) });
export const aiSkillsListResponseSchema = z.object({ items: z.array(aiSkillViewSchema) });

export const aiToolTraceSchema = z.object({
  skill: z.string(),
  ok: z.boolean(),
  summary: z.string(),
  pendingApproval: z.boolean(),
  code: z.string().nullable(),
});

export const aiUsageSchema = z.object({
  provider: z.string().nullable(),
  model: z.string().nullable(),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
});

export const aiChatRequestSchema = z.object({
  /** Caller identity — numeric Telegram id (normalized to user:tg:<id>) or a full account id. */
  userId: idSchema,
  role: z.enum(['user', 'staff']).default('user'),
  text: z.string().min(1).max(4000),
  /** BCP-47-ish language tag mirrored verbatim into the agent prompt. */
  language: z.string().min(2).max(16).default('fa'),
  /** Skip routing (the bot knows the slash command). */
  directAgent: aiAgentNameSchema.optional(),
  /** Most recent turns first-omitted; oldest first, max 10 messages. */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(2000) }))
    .max(10)
    .optional(),
  /** Pre-fetched knowledge context grounded into the agent prompt. */
  knowledge: z.string().max(4000).optional(),
});

export const aiChatResponseSchema = z.object({
  reply: z.string(),
  agent: aiAgentNameSchema,
  via: z.enum(['direct', 'prefilter', 'llm']),
  provider: z.string(),
  toolTraces: z.array(aiToolTraceSchema),
  usage: aiUsageSchema,
  pendingApproval: z.boolean(),
  redactions: z.number().int().min(0),
});

export const aiUsageViewSchema = z.object({
  userId: z.string(),
  usedToday: z.number().int().min(0),
  cap: z.number().int().min(0),
  remainingToday: z.number().int().min(0),
});

export type AiAgentView = z.infer<typeof aiAgentViewSchema>;
export type AiSkillView = z.infer<typeof aiSkillViewSchema>;
export type AiToolTrace = z.infer<typeof aiToolTraceSchema>;
export type AiUsage = z.infer<typeof aiUsageSchema>;
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;
export type AiChatResponse = z.infer<typeof aiChatResponseSchema>;
export type AiUsageView = z.infer<typeof aiUsageViewSchema>;

// ── route definitions (one per endpoint — ADR-005) ──────────────────────────

export const AI_ROUTES = [
  {
    method: 'POST' as const,
    path: '/ai/chat',
    operationId: 'aiChat',
    summary: 'Ask the Zenovix agent team — routing, skills, metering and audit run server-side.',
    tag: 'ai',
    security: 'public' as const,
    body: aiChatRequestSchema,
    response: aiChatResponseSchema,
    status: 200,
  },
  {
    method: 'GET' as const,
    path: '/ai/agents',
    operationId: 'aiAgents',
    summary: 'The 6 Zenovix agents with the skills each one may call.',
    tag: 'ai',
    security: 'public' as const,
    response: aiAgentsListResponseSchema,
    status: 200,
  },
  {
    method: 'GET' as const,
    path: '/ai/skills',
    operationId: 'aiSkills',
    summary: 'The 16 KIA-OS skills with authorization metadata.',
    tag: 'ai',
    security: 'public' as const,
    response: aiSkillsListResponseSchema,
    status: 200,
  },
  {
    method: 'GET' as const,
    path: '/ai/usage',
    operationId: 'aiUsage',
    summary: 'Per-user token usage against the daily cap (spend data is staff-only — admin key required).',
    tag: 'ai',
    security: 'admin' as const,
    query: z.object({ userId: idSchema }),
    response: aiUsageViewSchema,
    status: 200,
  },
];
