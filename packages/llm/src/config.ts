/**
 * LLM provider config (ADR-006) — exactly three environment variables:
 *
 *   OPENAI_BASE_URL   e.g. https://api.provider.com/v1
 *   OPENAI_API_KEY    sent as the Bearer credential
 *   MODEL             the model name, passed verbatim in the request body
 *
 * Fail-closed rules:
 *  - all three together, or nothing (a partial config is an ERROR, never a fallback);
 *  - the base URL is normalized (trailing slash stripped; a full
 *    …/chat/completions endpoint is accepted and reduced to its base);
 *  - the API key never appears in error messages, only in a masked hint.
 */

import { z } from 'zod';

const LLM_VARS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'MODEL'] as const;

const llmEnvSchema = z.object({
  OPENAI_BASE_URL: z.string().trim().url(),
  OPENAI_API_KEY: z.string().trim().min(8),
  MODEL: z.string().trim().min(1).max(200),
});

export interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface LlmConfigError {
  readonly code: 'LLM_NOT_CONFIGURED' | 'LLM_INVALID_CONFIG';
  readonly message: string;
  readonly meta?: Readonly<Record<string, string | number>>;
}

export type LlmConfigResult =
  | { readonly ok: true; readonly value: LlmConfig }
  | { readonly ok: false; readonly error: LlmConfigError };

/** Accepts a base URL (https://api.x.com/v1) or a full endpoint (…/v1/chat/completions). */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const suffix = '/chat/completions';
  return trimmed.endsWith(suffix) ? trimmed.slice(0, trimmed.length - suffix.length) : trimmed;
}

/** Strict loader — for services whose core feature IS the AI cycle (Phase 5). */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfigResult {
  const present = LLM_VARS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (present.length === 0) {
    return {
      ok: false,
      error: {
        code: 'LLM_NOT_CONFIGURED',
        message: 'LLM is not configured — set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL (ADR-006).',
      },
    };
  }
  if (present.length < LLM_VARS.length) {
    const missing = LLM_VARS.filter((k) => !present.includes(k));
    return {
      ok: false,
      error: {
        code: 'LLM_INVALID_CONFIG',
        message: `Partial LLM configuration — missing: ${missing.join(', ')} (ADR-006). All three variables are required together.`,
        meta: { missing: missing.length },
      },
    };
  }
  const parsed = llmEnvSchema.safeParse({
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    MODEL: env.MODEL,
  });
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return {
      ok: false,
      error: { code: 'LLM_INVALID_CONFIG', message: `Invalid LLM configuration — ${details}` },
    };
  }
  return {
    ok: true,
    value: {
      baseUrl: normalizeBaseUrl(parsed.data.OPENAI_BASE_URL),
      apiKey: parsed.data.OPENAI_API_KEY,
      model: parsed.data.MODEL,
    },
  };
}

/**
 * Safe loader for services that only OPTIONALLY expose AI features:
 * a complete config wins, a partial one is surfaced as an error,
 * an empty environment simply means "AI disabled" (undefined).
 */
export function loadLlmConfigSafe(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: LlmConfig | undefined } | { ok: false; error: LlmConfigError } {
  const present = LLM_VARS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (present.length === 0) return { ok: true, value: undefined };
  return loadLlmConfig(env);
}

/** Human-safe hint — never the full key. */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
