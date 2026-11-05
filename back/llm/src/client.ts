/**
 * OpenAI-compatible LLM client (ADR-006) — no third-party SDK.
 *
 * One wire contract for every provider that speaks the de-facto standard:
 *   POST {OPENAI_BASE_URL}/chat/completions   (Bearer auth)
 *   GET  {OPENAI_BASE_URL}/models             (cheap health probe)
 *
 * Fail-closed discipline:
 *  - every failure is a typed Result — no exceptions escape the client;
 *  - real timeouts via AbortController (a hanging provider cannot wedge a bot);
 *  - provider error bodies are truncated before they ever reach a caller,
 *    and the Authorization header is never echoed anywhere.
 */

import { z } from 'zod';
import type { LlmConfig } from './config.js';

export type LlmFailureCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'PROVIDER_AUTH'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'MALFORMED_RESPONSE';

export interface LlmError {
  readonly code: LlmFailureCode;
  readonly message: string;
  readonly status?: number;
  readonly meta?: Readonly<Record<string, string | number>>;
}

export type LlmResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LlmError };

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
  /** Per-call timeout override; default LLM_TIMEOUT_MS or 30s. */
  readonly timeoutMs?: number;
}

export interface ChatCompletion {
  readonly id: string | null;
  readonly model: string;
  readonly content: string;
  readonly finishReason: string | null;
  readonly usage:
    | { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number }
    | null;
}

export interface LlmClient {
  readonly config: LlmConfig;
  chat(request: ChatRequest): Promise<LlmResult<ChatCompletion>>;
  models(): Promise<LlmResult<{ readonly id: string }[]>>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30_000;
const BODY_SNIPPET = 300;

/** OpenAI chat-completion response — the minimal surface v3 depends on. */
const completionSchema = z.object({
  id: z.string().nullish(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string(),
          content: z.string().nullish(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int(),
      completion_tokens: z.number().int(),
      total_tokens: z.number().int(),
    })
    .nullish(),
});

const modelsSchema = z.object({
  data: z.array(z.object({ id: z.string() })).min(1),
});

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > BODY_SNIPPET ? `${flat.slice(0, BODY_SNIPPET)}…` : flat;
}

function mapHttpStatus(status: number, bodyText: string): LlmError {
  const message = snippet(bodyText) || `provider responded ${status}`;
  if (status === 401 || status === 403) {
    return { code: 'PROVIDER_AUTH', message: `Provider rejected the credentials — ${message}`, status };
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', message: `Provider rate limit — ${message}`, status };
  }
  return { code: 'PROVIDER_ERROR', message: `Provider error — ${message}`, status };
}

export function createLlmClient(
  config: LlmConfig,
  deps: { readonly fetchImpl?: FetchLike; readonly env?: NodeJS.ProcessEnv } = {},
): LlmClient {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  const defaultTimeout =
    deps.env !== undefined && deps.env.LLM_TIMEOUT_MS !== undefined
      ? Number(deps.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS;

  async function send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<LlmResult<Response>> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: timeoutSignal,
      });
      return { ok: true, value: res };
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return { ok: false, error: { code: 'TIMEOUT', message: `Provider did not respond within ${timeoutMs}ms.` } };
      }
      const reason = err instanceof Error ? err.message.slice(0, 200) : 'unknown fetch failure';
      return { ok: false, error: { code: 'NETWORK', message: `Could not reach the provider — ${reason}` } };
    }
  }

  async function readJson(res: Response): Promise<LlmResult<unknown>> {
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 200) : 'body read failed';
      return { ok: false, error: { code: 'NETWORK', message: `Provider body could not be read — ${reason}` } };
    }
    if (!res.ok) return { ok: false, error: mapHttpStatus(res.status, text) };
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return {
        ok: false,
        error: { code: 'MALFORMED_RESPONSE', message: `Provider returned non-JSON body — ${snippet(text)}`, status: res.status },
      };
    }
  }

  return {
    config,

    async chat(request): Promise<LlmResult<ChatCompletion>> {
      const timeout = request.timeoutMs ?? defaultTimeout;
      const body = {
        model: config.model,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.stop !== undefined ? { stop: request.stop } : {}),
      };
      const sent = await send('POST', '/chat/completions', body, timeout);
      if (!sent.ok) return sent;
      const parsed = await readJson(sent.value);
      if (!parsed.ok) return parsed;

      const checked = completionSchema.safeParse(parsed.value);
      if (!checked.success) {
        return {
          ok: false,
          error: {
            code: 'MALFORMED_RESPONSE',
            message: `Provider response does not match the OpenAI-compatible shape — ${checked.error.issues.length} issue(s).`,
            status: sent.value.status,
          },
        };
      }
      const first = checked.data.choices[0];
      if (first === undefined) {
        return { ok: false, error: { code: 'MALFORMED_RESPONSE', message: 'Provider returned an empty choices array.', status: sent.value.status } };
      }
      const content = first.message.content;
      if (content === null || content === undefined) {
        return {
          ok: false,
          error: {
            code: 'MALFORMED_RESPONSE',
            message: `Provider returned no content (finish_reason: ${first.finish_reason ?? 'unknown'}) — tool-only responses are not supported yet.`,
            status: sent.value.status,
          },
        };
      }
      const usage = checked.data.usage;
      return {
        ok: true,
        value: {
          id: checked.data.id ?? null,
          model: checked.data.model ?? config.model,
          content,
          finishReason: first.finish_reason ?? null,
          usage:
            usage !== null && usage !== undefined
              ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens }
              : null,
        },
      };
    },

    async models(): Promise<LlmResult<{ readonly id: string }[]>> {
      const sent = await send('GET', '/models', undefined, defaultTimeout);
      if (!sent.ok) return sent;
      const parsed = await readJson(sent.value);
      if (!parsed.ok) return parsed;
      const checked = modelsSchema.safeParse(parsed.value);
      if (!checked.success) {
        return { ok: false, error: { code: 'MALFORMED_RESPONSE', message: 'Provider /models response does not match the OpenAI shape.', status: sent.value.status } };
      }
      return { ok: true, value: checked.data.data.map((m) => ({ id: m.id })) };
    },
  };
}
