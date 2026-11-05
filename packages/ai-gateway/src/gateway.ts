/**
 * The AI gateway — Phase 5 orchestration core.
 *
 * One `ask()` runs the whole cycle, fail-closed at every step:
 *
 *   meter allowance → route intent (deterministic / LLM) → agent loop:
 *     [system prompt + skill manifest + JSON envelope] → provider chain →
 *     parse {"reply"} | {"tool", args} → runSkill (gate → executor port) →
 *     feed result back (max 2 tool rounds, then a forced final answer) →
 *   redact output → record usage → audit event → Result (never throws).
 *
 * The JSON envelope keeps ADR-006 purity: no provider-specific function-calling
 * API, so every OpenAI-compatible endpoint works identically and the whole
 * loop is testable offline with fake clients.
 */

import type { ChatMessage } from '@dropagentx/llm';
import { AGENTS, makeSystemPrompt, type AgentName } from './agents.js';
import { ProviderChain } from './provider.js';
import { redact, redactionCount } from './redact.js';
import { routeWithLlm } from './router.js';
import { manifestForAgent, runSkill, type SkillContext, type SkillExecutor, type SkillOutcome } from './skills.js';
import type { AiAuditEvent, AuditSink, UsageMeter } from './meter.js';

const MAX_TOOL_ROUNDS = 2;

export interface ToolTrace {
  readonly skill: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly pendingApproval: boolean;
  readonly code: string | null;
}

export interface GatewayAskInput {
  readonly userId: string;
  readonly role: 'user' | 'staff';
  readonly text: string;
  readonly language: string;
  readonly history?: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  /** Pre-fetched knowledge context (server-side RAG-lite) — optional. */
  readonly knowledge?: string;
  /** Skip routing (the bot knows the slash command) — uses this agent directly. */
  readonly directAgent?: AgentName;
}

export interface GatewayUsage {
  readonly provider: string | null;
  readonly model: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type GatewayAskResult =
  | {
      readonly ok: true;
      readonly reply: string;
      readonly agent: AgentName;
      readonly via: 'direct' | 'prefilter' | 'llm';
      readonly provider: string;
      readonly toolTraces: readonly ToolTrace[];
      readonly usage: GatewayUsage;
      readonly pendingApproval: boolean;
      readonly redactions: number;
    }
  | { readonly ok: false; readonly code: GatewayFailureCode; readonly message: string };

export type GatewayFailureCode =
  | 'AI_BUDGET_EXCEEDED'
  | 'AI_MALFORMED_OUTPUT'
  | 'AI_PROVIDERS_FAILED'
  | 'AI_INTERNAL';

interface EnvelopeReply {
  readonly kind: 'reply';
  readonly text: string;
}
interface EnvelopeTool {
  readonly kind: 'tool';
  readonly skill: string;
  readonly args: unknown;
}
type Envelope = EnvelopeReply | EnvelopeTool | { readonly kind: 'malformed'; readonly raw: string };

function parseEnvelope(content: string): Envelope {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return { kind: 'malformed', raw: content.slice(0, 200) };
  try {
    const raw = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof raw.reply === 'string' && raw.reply.length > 0) return { kind: 'reply', text: raw.reply };
    if (typeof raw.tool === 'string' && raw.tool.length > 0) {
      return { kind: 'tool', skill: raw.tool, args: raw.args ?? {} };
    }
    return { kind: 'malformed', raw: content.slice(0, 200) };
  } catch {
    return { kind: 'malformed', raw: content.slice(0, 200) };
  }
}

function envelopeInstruction(manifest: readonly unknown[]): string {
  return [
    'SKILLS — you may call marketplace skills by answering with EXACTLY one JSON object and nothing else:',
    '  {"tool": "<skill_id>", "args": {…}}            ← to call a skill, then wait for its result',
    '  {"reply": "<final answer to the user>"}        ← when you have the final answer',
    `Available skills (JSON schema per skill):\n${JSON.stringify(manifest)}`,
    'Call a skill whenever you need live data or an action. Never invent skill results. After you receive a skill result, continue or give the final reply.',
  ].join('\n');
}

function forceFinalInstruction(): string {
  return 'No more skill calls are possible in this turn. From the information you already have, answer with EXACTLY: {"reply": "…"} — be honest about what is missing.';
}

function toolResultMessage(skillId: string, outcome: SkillOutcome): ChatMessage {
  const hasPending = outcome.ok && 'pending' in outcome && outcome.pending !== undefined;
  const body =
    outcome.ok === true
      ? {
          skill: skillId,
          ok: true,
          ...(hasPending ? { pendingApproval: outcome.pending } : {}),
          summary: outcome.summary,
          data: outcome.data,
        }
      : { skill: skillId, ok: false, code: outcome.code, message: outcome.message };
  return {
    role: 'user',
    content: `SKILL_RESULT ${JSON.stringify(body)} — continue, or answer with {"reply": "…"}.`,
  };
}

export interface GatewayDeps {
  readonly chain: ProviderChain;
  readonly executor: SkillExecutor;
  readonly meter: UsageMeter;
  readonly audit: AuditSink;
  readonly now?: () => Date;
}

export class AiGateway {
  private readonly deps: GatewayDeps;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
  }

  async ask(input: GatewayAskInput): Promise<GatewayAskResult> {
    const now = this.deps.now ?? (() => new Date());
    const baseAudit = {
      at: now().toISOString(),
      userId: input.userId,
    } as const;

    // 1) budget gate — BEFORE any provider call.
    const allowance = this.deps.meter.checkAllowance(input.userId);
    if (!allowance.ok) {
      this.audit({
        ...baseAudit,
        agent: input.directAgent ?? 'orchestrator',
        provider: null,
        model: null,
        skill: null,
        outcome: 'refused',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        redactions: 0,
        code: 'AI_BUDGET_EXCEEDED',
        meta: { usedToday: allowance.usedToday, cap: allowance.cap },
      });
      return {
        ok: false,
        code: 'AI_BUDGET_EXCEEDED',
        message: allowance.message,
      };
    }

    // 2) route — direct agent wins, else deterministic prefilter / LLM classify.
    const toolTraces: ToolTrace[] = [];
    let pendingApproval = false;
    const usage: { provider: string | null; model: string | null; promptTokens: number; completionTokens: number; totalTokens: number } = {
      provider: null,
      model: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let agent: AgentName;
    let via: 'direct' | 'prefilter' | 'llm';
    if (input.directAgent !== undefined) {
      agent = input.directAgent;
      via = 'direct';
    } else {
      const routed = await routeWithLlm(this.deps.chain.routingClient, { text: input.text, role: input.role }, input.language);
      agent = routed.agent;
      via = routed.via;
      if (routed.usage.totalTokens > 0) {
        usage.promptTokens += routed.usage.promptTokens;
        usage.completionTokens += routed.usage.completionTokens;
        usage.totalTokens += routed.usage.totalTokens;
        this.deps.meter.record({
          userId: input.userId,
          agent: routed.agent,
          provider: 'primary',
          model: 'routing',
          kind: 'route',
          promptTokens: routed.usage.promptTokens,
          completionTokens: routed.usage.completionTokens,
          totalTokens: routed.usage.totalTokens,
        });
      }
    }
    const def = AGENTS[agent];

    // 3) agent loop with the JSON envelope.
    const ctx: SkillContext = { userId: input.userId, role: input.role, language: input.language };
    const manifest = manifestForAgent(agent);
    const messages: ChatMessage[] = [
      { role: 'system', content: `${makeSystemPrompt(def, input.knowledge ?? '', input.language)}\n\n${envelopeInstruction(manifest)}` },
      ...(input.history ?? []).map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
      { role: 'user', content: input.text },
    ];

    let malformedStrikes = 0;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const isLastRound = round === MAX_TOOL_ROUNDS;
      const callMessages: ChatMessage[] = isLastRound ? [...messages, { role: 'user', content: forceFinalInstruction() }] : messages;
      const result = await this.deps.chain.chat({ messages: callMessages, temperature: 0.4, maxTokens: 1200 });
      if (!result.ok) {
        this.audit({
          ...baseAudit,
          agent,
          provider: null,
          model: null,
          skill: null,
          outcome: 'failed',
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          redactions: 0,
          code: 'AI_PROVIDERS_FAILED',
        });
        return { ok: false, code: 'AI_PROVIDERS_FAILED', message: result.error.message };
      }

      usage.provider = result.provider;
      usage.model = result.value.model;
      if (result.value.usage !== null) {
        usage.promptTokens += result.value.usage.promptTokens;
        usage.completionTokens += result.value.usage.completionTokens;
        usage.totalTokens += result.value.usage.totalTokens;
        this.deps.meter.record({
          userId: input.userId,
          agent,
          provider: result.provider,
          model: result.value.model,
          kind: 'chat',
          promptTokens: result.value.usage.promptTokens,
          completionTokens: result.value.usage.completionTokens,
          totalTokens: result.value.usage.totalTokens,
        });
      }

      const envelope = parseEnvelope(result.value.content);
      if (envelope.kind === 'reply') {
        const reply = redact(envelope.text);
        const redactions = redactionCount(envelope.text);
        this.audit({
          ...baseAudit,
          agent,
          provider: result.provider,
          model: result.value.model,
          skill: null,
          outcome: pendingApproval ? 'pending' : 'ok',
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          redactions,
          code: null,
          ...(toolTraces.length > 0 ? { meta: { toolCalls: toolTraces.length } } : {}),
        });
        return {
          ok: true,
          reply,
          agent,
          via,
          provider: result.provider,
          toolTraces,
          usage,
          pendingApproval,
          redactions,
        };
      }

      if (envelope.kind === 'malformed') {
        malformedStrikes += 1;
        if (malformedStrikes >= 2 || isLastRound) {
          this.audit({
            ...baseAudit,
            agent,
            provider: result.provider,
            model: result.value.model,
            skill: null,
            outcome: 'failed',
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            redactions: 0,
            code: 'AI_MALFORMED_OUTPUT',
          });
          return {
            ok: false,
            code: 'AI_MALFORMED_OUTPUT',
            message: 'The model did not answer in the required JSON envelope — refusing to relay unstructured output.',
          };
        }
        messages.push({ role: 'assistant', content: envelope.raw });
        messages.push({
          role: 'user',
          content: 'FORMAT ERROR — answer with EXACTLY one JSON object: {"reply": "…"} or {"tool": "…", "args": {…}}. No prose.',
        });
        continue;
      }

      // 4) skill call — the fail-closed gate runs inside runSkill.
      const outcome = await runSkill(this.deps.executor, envelope.skill, agent, envelope.args, ctx);
      if (outcome.ok) {
        const isPending = 'pending' in outcome && outcome.pending !== undefined;
        toolTraces.push({
          skill: envelope.skill,
          ok: true,
          summary: outcome.summary,
          pendingApproval: isPending,
          code: null,
        });
        if (isPending) pendingApproval = true;
      } else {
        toolTraces.push({
          skill: envelope.skill,
          ok: false,
          summary: outcome.message,
          pendingApproval: false,
          code: outcome.code,
        });
      }
      messages.push({ role: 'assistant', content: JSON.stringify({ tool: envelope.skill, args: envelope.args ?? {} }) });
      messages.push(toolResultMessage(envelope.skill, outcome));
    }

    // Unreachable (every loop branch returns) — kept for exhaustiveness.
    return { ok: false, code: 'AI_INTERNAL', message: 'Gateway loop exhausted without an answer.' };
  }

  private audit(event: Omit<AiAuditEvent, 'at'> & { readonly at: string }): void {
    void this.deps.audit.record(event);
  }
}
