/**
 * Phase 5 package tests — everything runs offline against scripted fake
 * providers. Covers the acceptance criteria:
 *  - cutting the primary provider does not break the flow (fallback serves);
 *  - every AI response is audited and redacted;
 * plus the fail-closed gates: budget, skills, routing, config.
 */

import { describe, expect, it } from 'vitest';
import type { ChatCompletion, ChatRequest, LlmClient, LlmResult } from '@dropagentx/llm';
import { AGENTS, AGENT_ORDER, makeSystemPrompt } from '../agents.js';
import { AiGateway } from '../gateway.js';
import { createCollectingSink, createInMemoryMeter } from '../meter.js';
import { ProviderChain, type ChainEntry } from '../provider.js';
import { redact, redactionCount } from '../redact.js';
import { prefilter, routeWithLlm } from '../router.js';
import { assertRegistryConsistent, HITL_THRESHOLD_DIN, manifestForAgent, runSkill, SKILL_IDS, SKILLS, gateSkill } from '../skills.js';
import { loadGatewayConfigs, loadGatewayOptions } from '../config.js';

// ── fake providers ───────────────────────────────────────────────────────────

interface FakeCall {
  readonly request: ChatRequest;
}

function fakeClient(
  script: (request: ChatRequest) => LlmResult<ChatCompletion>,
  log?: FakeCall[],
): LlmClient {
  return {
    config: { baseUrl: 'https://fake.provider/v1', apiKey: 'test-key-1234567890', model: 'fake-model' },
    async chat(request) {
      log?.push({ request });
      return script(request);
    },
    async models() {
      return { ok: true, value: [{ id: 'fake-model' }] };
    },
  };
}

function completion(content: string, totalTokens = 100): LlmResult<ChatCompletion> {
  return {
    ok: true,
    value: {
      id: 'chatcmpl-fake',
      model: 'fake-model',
      content,
      finishReason: 'stop',
      usage: { promptTokens: Math.floor(totalTokens * 0.8), completionTokens: Math.ceil(totalTokens * 0.2), totalTokens },
    },
  };
}

function providerError(code: 'NETWORK' | 'TIMEOUT' | 'PROVIDER_AUTH' | 'RATE_LIMITED' | 'PROVIDER_ERROR'): LlmResult<ChatCompletion> {
  return { ok: false, error: { code, message: `fake ${code} failure` } };
}

const replyEnvelope = (text: string, totalTokens = 100) => completion(JSON.stringify({ reply: text }), totalTokens);
const toolEnvelope = (skill: string, args: unknown = {}) => completion(JSON.stringify({ tool: skill, args }));

function chainOf(...entries: readonly ChainEntry[]): ProviderChain {
  return new ProviderChain(entries);
}

type ExecutorFn = (skillId: string, args: unknown, ctx: { userId: string; role: 'user' | 'staff'; language: string }) => Promise<
  | { ok: true; data: unknown; summary: string }
  | { ok: true; pending: { approvalId: string; reason: string }; data: unknown; summary: string }
  | { ok: false; code: string; message: string }
>;

function makeGateway(opts: {
  script: (request: ChatRequest) => LlmResult<ChatCompletion>;
  executor?: ExecutorFn;
  meter?: ReturnType<typeof createInMemoryMeter>;
  sink?: ReturnType<typeof createCollectingSink>;
}) {
  // executor default: a stub that answers every skill with a read summary
  const executor: ExecutorFn =
    opts.executor ??
    (async (skillId: string) => ({
      ok: true as const,
      data: { skill: skillId, note: 'stub' },
      summary: `${skillId} ok`,
    }));
  const chain = chainOf({ name: 'primary', client: fakeClient(opts.script) });
  const meter = opts.meter ?? createInMemoryMeter();
  const sink = opts.sink ?? createCollectingSink();
  const gateway = new AiGateway({ chain, executor, meter, audit: sink });
  return { gateway, meter, sink };
}

const userCtx = { userId: 'u1', role: 'user' as const, language: 'fa' };

// ── 1) redaction ─────────────────────────────────────────────────────────────

describe('redact', () => {
  it('scrubs OpenAI-style keys, bot tokens, JWTs, bearer headers and PEM blocks', () => {
    expect(redact('my key is sk-proj-abcdef123456789012345678 ok')).toBe('my key is [REDACTED] ok');
    expect(redact('token 1234567890:AAFF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toContain('[REDACTED]');
    expect(redact('Bearer abcdef123456')).toBe('[REDACTED]');
    expect(redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c end')).toContain('[REDACTED]');
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----')).toBe('[REDACTED]');
  });

  it('scrubs AWS ids, long hex, seed phrases and card-like numbers', () => {
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
    expect(redact('salt 0123456789abcdef0123456789abcdef')).toContain('[REDACTED]');
    expect(redact('seed alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima')).toBe('[REDACTED]');
    expect(redact('card 4111 1111 1111 1111')).toContain('[REDACTED]');
  });

  it('keeps ordinary text and integer money untouched', () => {
    const clean = 'قیمت 90,000 Đ است و مالیات 10 درصد؛ موجودی 187,672 دینار.';
    expect(redact(clean)).toBe(clean);
    expect(redact('')).toBe('');
    expect(redactionCount(clean)).toBe(0);
  });
});

// ── 2) agents + manifest ─────────────────────────────────────────────────────

describe('agents and skills registry', () => {
  it('holds exactly 6 agents and 16 skills with unique ids', () => {
    assertRegistryConsistent();
    expect(AGENT_ORDER.length).toBe(6);
    expect(SKILL_IDS.length).toBe(16);
    expect(new Set(SKILL_IDS).size).toBe(16);
    for (const name of AGENT_ORDER) expect(AGENTS[name].systemPrompt.length).toBeGreaterThan(100);
  });

  it('every allowedAgent of every skill exists and manifests match allowedAgents', () => {
    for (const def of Object.values(SKILLS)) {
      for (const agent of def.allowedAgents) expect(AGENT_ORDER).toContain(agent);
    }
    let total = 0;
    for (const agent of AGENT_ORDER) {
      const manifest = manifestForAgent(agent);
      const expected = Object.values(SKILLS).filter((d) => d.allowedAgents.includes(agent)).map((d) => d.id);
      expect(manifest.map((e) => e.id)).toEqual(expected); // registry ↔ manifest single source
      total += manifest.length;
    }
    expect(total).toBeGreaterThan(16); // shared skills across agents
  });

  it('money skills are never staff-only reads; staff skills gate the boundary', () => {
    expect(SKILLS.kb_upsert?.staffOnly).toBe(true);
    expect(SKILLS.analytics_report?.staffOnly).toBe(true);
    expect(SKILLS.wallet_get?.staffOnly).toBeUndefined();
    expect(HITL_THRESHOLD_DIN).toBe(50_000);
  });
});

// ── 3) the fail-closed skill gate ────────────────────────────────────────────

describe('skill gate', () => {
  it('refuses unknown skills, wrong agents, staff-only calls and invalid args — executor never called', async () => {
    let called = 0;
    const executor = async () => { called += 1; return { ok: true as const, data: {}, summary: 'x' }; };
    const staffCtx = { userId: 'u1', role: 'staff' as const, language: 'en' };

    expect(gateSkill('nope', 'sales', {}, userCtx).ok).toBe(false);
    const forbidden = gateSkill('analytics_report', 'sales', {}, staffCtx);
    expect(forbidden.ok).toBe(false);
    const staff = gateSkill('analytics_report', 'analyst', {}, userCtx);
    expect(staff.ok).toBe(false);
    const badArgs = gateSkill('wallet_transfer', 'orchestrator', { toAccountId: '', amountDin: -5 }, userCtx);
    expect(badArgs.ok).toBe(false);
    const badAgentSkill = gateSkill('wallet_transfer', 'content', { toAccountId: 'u2', amountDin: 10 }, userCtx);
    expect(badAgentSkill.ok).toBe(false);

    for (const id of ['nope', 'analytics_report', 'analytics_report', 'wallet_transfer', 'wallet_transfer']) {
      await runSkill(executor, id, 'sales', {}, userCtx);
    }
    expect(called).toBe(0); // all refusals happened BEFORE the executor
  });

  it('executes only after the gate passes and relays money/HITL outcomes verbatim', async () => {
    const hits: string[] = [];
    const executor: ExecutorFn = async (skillId, args) => {
      hits.push(skillId);
      if (skillId === 'escrow_refund') return { ok: true, pending: { approvalId: 'hitl_1', reason: 'amount ≥ 50,000 Đ' }, data: { amountDin: 60_000 }, summary: 'refund filed' };
      return { ok: true, data: args, summary: `${skillId} done` };
    };
    const okOutcome = await runSkill(executor, 'wallet_get', 'receptionist', {}, userCtx);
    expect(okOutcome.ok).toBe(true);
    expect(hits).toEqual(['wallet_get']);

    const pending = await runSkill(executor, 'escrow_refund', 'support', { escrowId: 'e1', reason: 'broken item' }, userCtx);
    expect(pending.ok).toBe(true);
    if (pending.ok) expect('pending' in pending && pending.pending.approvalId).toBe('hitl_1');
  });

  it('executor exceptions become typed failures — nothing escapes', async () => {
    const executor = async () => { throw new Error('boom'); };
    const outcome = await runSkill(executor, 'wallet_get', 'receptionist', {}, userCtx);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('SKILL_FAILED');
  });
});

// ── 4) provider chain — deterministic fallback ───────────────────────────────

describe('provider chain', () => {
  it('primary failure falls through to secondary deterministically (acceptance criterion)', async () => {
    const primary = fakeClient(() => providerError('PROVIDER_AUTH'));
    const secondary = fakeClient(() => replyEnvelope('from secondary'));
    const chain = chainOf({ name: 'primary', client: primary }, { name: 'secondary', client: secondary });
    const result = await chain.chat({ messages: [{ role: 'user', content: 'hi' }] });
    if (!result.ok) throw new Error('chain should have served from secondary');
    expect(result.provider).toBe('secondary');
    expect(result.attempts.map((a) => a.provider)).toEqual(['primary', 'secondary']);
    expect(result.attempts[0]?.code).toBe('PROVIDER_AUTH');
  });

  it('all providers failing yields one typed error with an ordered summary — no secrets', async () => {
    const chain = chainOf(
      { name: 'primary', client: fakeClient(() => providerError('TIMEOUT')) },
      { name: 'secondary', client: fakeClient(() => providerError('RATE_LIMITED')) },
    );
    const result = await chain.chat({ messages: [{ role: 'user', content: 'hi' }] });
    if (result.ok) throw new Error('chain should have failed');
    expect(result.error.code).toBe('RATE_LIMITED');
    expect(result.error.message).toContain('primary:TIMEOUT → secondary:RATE_LIMITED');
    expect(result.error.message).not.toContain('test-key');
  });

  it('an empty chain is a constructor error (fail-closed boot)', () => {
    expect(() => chainOf()).toThrow();
  });
});

// ── 5) routing ───────────────────────────────────────────────────────────────

describe('routing', () => {
  it('prefilter is deterministic and free', () => {
    expect(prefilter({ text: '/buy i want the bundle', role: 'user' })).toBe('sales');
    expect(prefilter({ text: '/refund my order', role: 'user' })).toBe('support');
    expect(prefilter({ text: '/content new listing', role: 'user' })).toBe('content');
    expect(prefilter({ text: '/analytics', role: 'staff' })).toBe('analyst');
    expect(prefilter({ text: '/analytics', role: 'user' })).toBe('receptionist');
    expect(prefilter({ text: 'سلام!', role: 'user' })).toBe(null);
  });

  it('parses the classification envelope; garbage and failure fall back to receptionist', async () => {
    const good = fakeClient(() => completion('{"agent": "sales"}'));
    const routed = await routeWithLlm(good, { text: 'how much for the bundle?', role: 'user' }, 'en');
    expect(routed.agent).toBe('sales');
    expect(routed.via).toBe('llm');
    expect(routed.usage.totalTokens).toBeGreaterThan(0);

    const garbage = fakeClient(() => completion('I think sales!'));
    expect((await routeWithLlm(garbage, { text: 'hello?', role: 'user' }, 'en')).agent).toBe('receptionist');

    const broken = fakeClient(() => providerError('NETWORK'));
    expect((await routeWithLlm(broken, { text: 'hello?', role: 'user' }, 'en')).agent).toBe('receptionist');
  });

  it('never routes a non-staff caller to the analyst even if the model says so', async () => {
    const pushy = fakeClient(() => completion('{"agent": "analyst"}'));
    expect((await routeWithLlm(pushy, { text: 'show me internal stats', role: 'user' }, 'en')).agent).toBe('receptionist');
    expect((await routeWithLlm(pushy, { text: 'show me internal stats', role: 'staff' }, 'en')).agent).toBe('analyst');
  });
});

// ── 6) metering ──────────────────────────────────────────────────────────────

describe('meter', () => {
  it('enforces the daily cap before any provider call and rolls over by UTC day', () => {
    let day = 0;
    const now = () => new Date(Date.UTC(2026, 10, 5 + day, 12));
    const meter = createInMemoryMeter({ dailyTokenCap: 1000, now });
    meter.record({ userId: 'u1', agent: 'sales', provider: 'primary', model: 'm', kind: 'chat', promptTokens: 600, completionTokens: 400, totalTokens: 1000 });
    const blocked = meter.checkAllowance('u1');
    expect(blocked.ok).toBe(false);
    day = 1;
    expect(meter.checkAllowance('u1').ok).toBe(true);
    expect(meter.usedToday('u1')).toBe(0);
  });
});

// ── 7) config ────────────────────────────────────────────────────────────────

describe('gateway config', () => {
  const tri = { OPENAI_BASE_URL: 'https://a.example/v1', OPENAI_API_KEY: 'key-1234567890', MODEL: 'm1' };

  it('requires the primary triplet; partial slots refuse; complete slots chain up', () => {
    expect(loadGatewayConfigs({}).ok).toBe(false);
    const partial = loadGatewayConfigs({ ...tri, OPENAI_API_KEY_2: 'key-0987654321' });
    expect(partial.ok).toBe(false);
    const two = loadGatewayConfigs({
      ...tri,
      OPENAI_BASE_URL_2: 'https://b.example/v1',
      OPENAI_API_KEY_2: 'key-0987654321',
      MODEL_2: 'm2',
    });
    expect(two.ok).toBe(true);
    if (two.ok) expect(two.providers.map((p) => p.name)).toEqual(['primary', 'secondary']);
    expect(loadGatewayOptions({ AI_DAILY_TOKEN_CAP: '5000' }).dailyTokenCap).toBe(5000);
    expect(loadGatewayOptions({}).maxToolRounds).toBe(2);
  });
});

// ── 8) the full gateway cycle ────────────────────────────────────────────────

describe('AiGateway', () => {
  it('routes, answers and audits a plain chat (no tools needed)', async () => {
    const sink = createCollectingSink();
    const script = (req: ChatRequest) => {
      const sys = req.messages[0]?.content ?? '';
      if (sys.includes('intent classifier')) return completion('{"agent": "receptionist"}');
      return replyEnvelope('سلام! چطور می‌توانم کمک کنم؟');
    };
    const { gateway } = makeGateway({ script, sink });
    const result = await gateway.ask({ userId: 'u1', role: 'user', text: 'سلام', language: 'fa' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agent).toBe('receptionist');
      expect(result.via).toBe('llm');
      expect(result.reply).toContain('سلام');
      expect(result.provider).toBe('primary');
      expect(result.pendingApproval).toBe(false);
      expect(result.usage.totalTokens).toBeGreaterThan(0);
    }
    expect(sink.events.length).toBe(1);
    expect(sink.events[0]?.outcome).toBe('ok');
  });

  it('runs a tool round: sales searches products, then answers with the result', async () => {
    const seenSkillResults: string[] = [];
    const script = (req: ChatRequest) => {
      const last = req.messages.at(-1)?.content ?? '';
      if (last.startsWith('SKILL_RESULT')) {
        seenSkillResults.push(last);
        return replyEnvelope('این بسته 120,000 Đ است — موجود در انبار.');
      }
      return toolEnvelope('product_search', { query: 'bundle' });
    };
    let executed: string | null = null;
    const executor: ExecutorFn = async (skillId, args) => {
      executed = `${skillId}:${JSON.stringify(args)}`;
      return { ok: true, data: { products: [{ title: 'Bundle', priceDin: 120_000 }] }, summary: '1 product found' };
    };
    const sink = createCollectingSink();
    const { gateway } = makeGateway({ script, executor, sink });
    const result = await gateway.ask({ userId: 'u1', role: 'user', text: '/buy bundle', language: 'fa' });
    expect(executed).toBe('product_search:{"query":"bundle"}');
    expect(seenSkillResults.length).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agent).toBe('sales'); // prefilter
      expect(result.toolTraces).toEqual([{ skill: 'product_search', ok: true, summary: '1 product found', pendingApproval: false, code: null }]);
      expect(result.reply).toContain('120,000');
    }
    expect(sink.events[0]?.meta?.toolCalls).toBe(1);
  });

  it('surfaces HITL: refund over 50,000 Đ becomes pendingApproval and is audited as pending', async () => {
    const script = (req: ChatRequest) => {
      const sys = req.messages[0]?.content ?? '';
      if (sys.includes('intent classifier')) return completion('{"agent": "support"}', 60);
      const last = req.messages.at(-1)?.content ?? '';
      if (last.startsWith('SKILL_RESULT')) return replyEnvelope('درخواست بازگشت وجه ثبت شد و نیاز به تایید انسانی دارد.');
      return toolEnvelope('escrow_refund', { escrowId: 'e1', reason: 'damaged delivery' });
    };
    const executor: ExecutorFn = async () => ({
      ok: true,
      pending: { approvalId: 'hitl_9', reason: 'amount 60,000 Đ ≥ 50,000 Đ' },
      data: { hitlId: 'hitl_9' },
      summary: 'refund filed for approval',
    });
    const { gateway, sink } = makeGateway({ script, executor });
    const result = await gateway.ask({ userId: 'u1', role: 'user', text: 'می‌خواهم پولم را پس بگیرم', language: 'fa' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pendingApproval).toBe(true);
      expect(result.toolTraces[0]?.pendingApproval).toBe(true);
    }
    expect(sink.events[0]?.outcome).toBe('pending');
  });

  it('blocks a skill the agent is not allowed to call — and the model recovers to a refusal', async () => {
    const script = (req: ChatRequest) => {
      const sys = req.messages[0]?.content ?? '';
      if (sys.includes('intent classifier')) return completion('{"agent": "receptionist"}');
      // after the forced-final instruction the model stops calling tools
      if (req.messages.some((m) => m.content.includes('No more skill calls'))) {
        return replyEnvelope('این گزارش فقط برای مدیران است.');
      }
      return toolEnvelope('analytics_report', {});
    };
    const { gateway, sink } = makeGateway({ script });
    const result = await gateway.ask({ userId: 'u1', role: 'user', text: 'گزارش داخلی بده', language: 'fa' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolTraces[0]?.ok).toBe(false);
      expect(result.toolTraces[0]?.code).toBe('SKILL_FORBIDDEN');
      expect(result.pendingApproval).toBe(false);
    }
    expect(sink.events[0]?.outcome).toBe('ok');
  });

  it('redacts secrets in the final reply and counts them in the audit event', async () => {
    const { gateway, sink } = makeGateway({ script: () => replyEnvelope('here is your token sk-abcdef123456789012345678, enjoy') });
    const result = await gateway.ask({ userId: 'u1', role: 'user', text: 'hi', language: 'en' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toContain('[REDACTED]');
      expect(result.reply).not.toContain('sk-abcdef');
      expect(result.redactions).toBe(1);
    }
    expect(sink.events[0]?.redactions).toBe(1);
  });

  it('fails closed on two malformed envelopes instead of relaying raw model text', async () => {
    const { gateway, sink } = makeGateway({ script: () => completion('I am just going to talk like a human, no JSON today') });
    const result = await gateway.ask({ userId: 'u1', role: 'user', text: 'hi', language: 'en' });
    if (!result.ok) {
      expect(result.code).toBe('AI_MALFORMED_OUTPUT');
    } else {
      expect.unreachable('expected a malformed-output refusal');
    }
    expect(sink.events[0]?.outcome).toBe('failed');
    expect(sink.events[0]?.code).toBe('AI_MALFORMED_OUTPUT');
  });

  it('exhausted budget refuses BEFORE any provider call (acceptance: capped spend)', async () => {
    let providerCalls = 0;
    const script = () => { providerCalls += 1; return replyEnvelope('x'); };
    const meter = createInMemoryMeter({ dailyTokenCap: 10 });
    meter.record({ userId: 'u1', agent: 'sales', provider: 'p', model: 'm', kind: 'chat', promptTokens: 0, completionTokens: 0, totalTokens: 10 });
    const { gateway, sink } = makeGateway({ script, meter });
    const result = await gateway.ask({ userId: 'u1', role: 'user', text: 'hi', language: 'en' });
    if (!result.ok) {
      expect(result.code).toBe('AI_BUDGET_EXCEEDED');
    } else {
      expect.unreachable('expected a budget refusal');
    }
    expect(providerCalls).toBe(0);
    expect(sink.events[0]?.outcome).toBe('refused');
  });

  it('provider dies mid-loop: the chain falls over and the answer still arrives (acceptance)', async () => {
    let primaryCalls = 0;
    const primary = fakeClient(() => { primaryCalls += 1; return providerError('NETWORK'); });
    const secondary = fakeClient(() => replyEnvelope('answered by fallback provider'));
    const sink = createCollectingSink();
    const meter = createInMemoryMeter();
    const gateway = new AiGateway({
      chain: chainOf({ name: 'primary', client: primary }, { name: 'secondary', client: secondary }),
      executor: async (skillId) => ({ ok: true as const, data: {}, summary: `${skillId} ok` }),
      meter,
      audit: sink,
    });
    const result = await gateway.ask({ userId: 'u1', role: 'user', text: 'hello', language: 'en' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('secondary');
      expect(result.reply).toContain('fallback provider');
    }
    expect(primaryCalls).toBeGreaterThan(0);
    expect(sink.events[0]?.provider).toBe('secondary');
  });

  it('routing and chat usage both feed the meter (transparent per-user bill)', async () => {
    const meter = createInMemoryMeter();
    const script = (req: ChatRequest) => {
      const sys = req.messages[0]?.content ?? '';
      if (sys.includes('intent classifier')) return completion('{"agent": "sales"}', 50);
      return replyEnvelope('offer', 150);
    };
    const { gateway } = makeGateway({ script, meter });
    await gateway.ask({ userId: 'u1', role: 'user', text: 'buy?', language: 'en' });
    expect(meter.usedToday('u1')).toBe(200);
  });

  it('direct agent skips routing; staff callers may use staff skills end-to-end', async () => {
    const script = (req: ChatRequest) => {
      const last = req.messages.at(-1)?.content ?? '';
      if (last.startsWith('SKILL_RESULT')) return replyEnvelope('Snapshot: GMV 5,360 Đ, 108 purchases.');
      return toolEnvelope('analytics_report', {});
    };
    let staffSeen = false;
    const executor: ExecutorFn = async (_skillId, _args, ctx) => {
      staffSeen = ctx.role === 'staff';
      return { ok: true, data: { gmvDin: 5360, purchases: 108 }, summary: 'snapshot ready' };
    };
    const { gateway } = makeGateway({ script, executor });
    const result = await gateway.ask({ userId: 'owner', role: 'staff', text: 'وضعیت کسب‌وکار؟', language: 'fa', directAgent: 'analyst' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agent).toBe('analyst');
      expect(result.via).toBe('direct');
    }
    expect(staffSeen).toBe(true);
  });

  it('never leaks the provider key in any error or audit path', async () => {
    const chain = chainOf({ name: 'primary', client: fakeClient(() => providerError('PROVIDER_AUTH')) });
    const gateway = new AiGateway({
      chain,
      executor: async (skillId) => ({ ok: true as const, data: {}, summary: skillId }),
      meter: createInMemoryMeter(),
      audit: createCollectingSink(),
    });
    const result = await gateway.ask({ userId: 'u1', role: 'user', text: 'hi', language: 'en' });
    if (!result.ok) {
      expect(JSON.stringify(result)).not.toContain('test-key-1234567890');
    }
    expect(result.ok).toBe(false);
  });

  it('system prompt embeds the manifest and the Đ integer-money rule', async () => {
    const calls: FakeCall[] = [];
    const script = (req: ChatRequest) => {
      calls.push({ request: req });
      return replyEnvelope('ok');
    };
    const { gateway } = makeGateway({ script });
    await gateway.ask({ userId: 'u1', role: 'user', text: 'hello', language: 'en', directAgent: 'sales' });
    const sys = calls[0]?.request.messages[0]?.content ?? '';
    expect(sys).toContain('"product_search"');
    expect(sys).toContain('integer');
    expect(sys).toContain('User language tag: "en"');
    expect(makeSystemPrompt(AGENTS.sales, '', 'en')).toContain('KNOWLEDGE CONTEXT');
  });
});
