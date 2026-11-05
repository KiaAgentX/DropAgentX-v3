/**
 * Intent routing — the orchestrator's classifier.
 *
 * Two stages, cheapest and most deterministic first:
 *  1. deterministic pre-filter — explicit commands and unambiguous staff
 *     markers never cost a provider call;
 *  2. LLM classification — one small chat call whose reply must be a strict
 *     JSON object {"agent": "..."}. Anything else is fail-closed to
 *     'receptionist' (never guess a specialist).
 *
 * The analyst agent is STAFF-ONLY: a non-staff caller can never be routed
 * there, regardless of what the model says.
 */

import type { LlmClient } from '@dropagentx/llm';
import type { AgentName } from './agents.js';
import type { CallerRole } from './skills.js';

export interface RouteInput {
  readonly text: string;
  readonly role: CallerRole;
}

/**
 * Routing is total: it ALWAYS returns an agent. The LLM stage failing or
 * producing garbage falls back to 'receptionist' — the front desk can handle
 * anything, so there is no failure variant (fail-closed, never throws).
 * When the LLM classified, its token usage rides along so the gateway can
 * meter the routing call per user (transparent bill).
 */
export interface RouteResult {
  readonly agent: AgentName;
  readonly via: 'prefilter' | 'llm';
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number };
}

const STAFF_COMMANDS = new Set(['/analytics', '/report', '/stats']);

/** Explicit command prefixes → deterministic agent. Unmatched → null. */
export function prefilter(input: RouteInput): AgentName | null {
  const text = input.text.trim().toLowerCase();
  if (text.length === 0) return 'receptionist';
  const command = text.startsWith('/') ? (text.split(/\s+/u)[0] ?? '') : null;
  if (command === '/buy' || command === '/products' || command === '/shop') return 'sales';
  if (command === '/support' || command === '/refund' || command === '/help') return 'support';
  if (command === '/content' || command === '/listing') return 'content';
  if (command !== null && STAFF_COMMANDS.has(command)) return input.role === 'staff' ? 'analyst' : 'receptionist';
  return null;
}

const AGENT_NAMES: readonly string[] = ['receptionist', 'sales', 'support', 'analyst', 'content'];

function classificationMessages(text: string, language: string) {
  return [
    {
      role: 'system' as const,
      content:
        'You are the intent classifier of a Telegram marketplace super-app. Classify the user message into exactly one specialist agent. ' +
        'Agents: receptionist (greetings, FAQs, general chat, orientation), sales (buying, pricing, product offers), ' +
        'support (order issues, refunds, complaints, bugs), analyst (internal business stats — staff only), content (product copywriting). ' +
        'Respond with ONLY a JSON object, no prose: {"agent": "receptionist|sales|support|analyst|content"}.',
    },
    { role: 'user' as const, content: `User language: ${language}\nUser message: ${text}` },
  ];
}

function parseClassification(content: string): AgentName | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const raw = JSON.parse(content.slice(start, end + 1)) as { agent?: unknown };
    if (typeof raw.agent === 'string' && AGENT_NAMES.includes(raw.agent)) return raw.agent as AgentName;
    return null;
  } catch {
    return null;
  }
}

export async function routeWithLlm(
  client: LlmClient,
  input: RouteInput,
  language: string,
): Promise<RouteResult> {
  const pre = prefilter(input);
  if (pre !== null) return { agent: pre, via: 'prefilter', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  const result = await client.chat({ messages: classificationMessages(input.text, language), temperature: 0, maxTokens: 40 });
  if (!result.ok) {
    // Routing call failed — fail-closed to the front desk, never an exception.
    return { agent: 'receptionist', via: 'prefilter', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  const usage = {
    promptTokens: result.value.usage?.promptTokens ?? 0,
    completionTokens: result.value.usage?.completionTokens ?? 0,
    totalTokens: result.value.usage?.totalTokens ?? 0,
  };
  const agent = parseClassification(result.value.content);
  if (agent === null) return { agent: 'receptionist', via: 'prefilter', usage };
  if (agent === 'analyst' && input.role !== 'staff') return { agent: 'receptionist', via: 'prefilter', usage };
  return { agent, via: 'llm', usage };
}
