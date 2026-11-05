/**
 * Gateway configuration — multi-provider over the SAME wire as ADR-006.
 *
 * Provider 1 ("primary")   = the canonical triplet OPENAI_BASE_URL / OPENAI_API_KEY / MODEL.
 * Provider 2..3            = suffixed triplets: OPENAI_BASE_URL_2 / OPENAI_API_KEY_2 / MODEL_2
 *                            and …_3. Learning from the legacy Hermes 9router,
 *                            but locked to the ADR-006 shape.
 *
 * Fail-closed: every provider must be complete or absent — a partial triplet
 * refuses to boot the gateway (same all-or-nothing rule as the base client).
 * The primary triplet is REQUIRED; secondaries are optional. No secrets are
 * ever echoed — the key appears only as a masked hint.
 */

import { loadLlmConfig, maskApiKey, type LlmConfig } from '@dropagentx/llm';

export const PROVIDER_VARS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'MODEL'] as const;
export const PROVIDER_ORDER = ['primary', 'secondary', 'fallback'] as const;

export type ProviderName = (typeof PROVIDER_ORDER)[number];

const SLOTS: readonly { readonly name: ProviderName; readonly suffix: string }[] = [
  { name: 'primary', suffix: '' },
  { name: 'secondary', suffix: '_2' },
  { name: 'fallback', suffix: '_3' },
];

export type GatewayConfigResult =
  | { readonly ok: true; readonly providers: readonly { readonly name: ProviderName; readonly config: LlmConfig }[] }
  | { readonly ok: false; readonly code: 'LLM_NOT_CONFIGURED' | 'LLM_INVALID_CONFIG'; readonly message: string };

function suffixedEnv(env: NodeJS.ProcessEnv, suffix: string): NodeJS.ProcessEnv {
  if (suffix === '') return env;
  const map: Record<string, string | undefined> = {};
  for (const base of PROVIDER_VARS) {
    map[base] = env[`${base}${suffix}`];
  }
  return map;
}

function missingVars(env: NodeJS.ProcessEnv, suffix: string): string[] {
  return PROVIDER_VARS.filter((v) => {
    const key = `${v}${suffix}`;
    return env[key] === undefined || env[key] === '';
  }).map((v) => `${v}${suffix}`);
}

/** True when AT LEAST ONE suffixed var exists for slot N (partial → error). */
function anySuffixedVar(env: NodeJS.ProcessEnv, suffix: string): boolean {
  return PROVIDER_VARS.some((v) => {
    const key = `${v}${suffix}`;
    return env[key] !== undefined && env[key] !== '';
  });
}

export function loadGatewayConfigs(env: NodeJS.ProcessEnv = process.env): GatewayConfigResult {
  const providers: { name: ProviderName; config: LlmConfig }[] = [];

  for (const slot of SLOTS) {
    const { name, suffix } = slot;
    const slotEnv = suffixedEnv(env, suffix);

    if (suffix !== '' && !anySuffixedVar(env, suffix)) continue; // slot absent → fine

    const result = loadLlmConfig(slotEnv);
    if (!result.ok) {
      if (result.error.code === 'LLM_NOT_CONFIGURED') {
        // Only the PRIMARY slot may be absent; a silent-absent suffixed slot
        // was already skipped above, so reaching here means primary missing.
        return {
          ok: false,
          code: 'LLM_NOT_CONFIGURED',
          message: 'AI gateway not configured — set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL (ADR-006).',
        };
      }
      const missing = missingVars(env, suffix);
      return {
        ok: false,
        code: 'LLM_INVALID_CONFIG',
        message: `Partial LLM configuration for provider "${name}" — missing: ${missing.join(', ')} (all three variables are required together, ADR-006).`,
      };
    }
    providers.push({ name, config: result.value });
  }

  if (providers.length === 0) {
    return {
      ok: false,
      code: 'LLM_NOT_CONFIGURED',
      message: 'AI gateway not configured — set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL (ADR-006).',
    };
  }
  return { ok: true, providers };
}

export interface GatewayEnvOptions {
  /** Per-user daily token cap (default 120,000). */
  readonly dailyTokenCap?: number;
  /** Max tool rounds per ask — FIXED at 2, not configurable (determinism). */
  readonly maxToolRounds: 2;
}

export function loadGatewayOptions(env: NodeJS.ProcessEnv = process.env): GatewayEnvOptions {
  const raw = env.AI_DAILY_TOKEN_CAP;
  let cap: number | undefined;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1000) cap = Math.floor(n);
  }
  return { ...(cap !== undefined ? { dailyTokenCap: cap } : {}), maxToolRounds: 2 };
}

/** Human-safe provider hint for logs — never a full key. */
export function describeProvider(name: ProviderName, config: LlmConfig): string {
  return `${name}=${config.model}@${config.baseUrl} key=${maskApiKey(config.apiKey)}`;
}
