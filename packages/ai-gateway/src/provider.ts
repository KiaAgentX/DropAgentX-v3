/**
 * Deterministic provider chain — the Phase 5 fallback rule.
 *
 * An ordered list of ADR-006-shaped clients (primary → secondary → fallback).
 * The SAME chat request goes down the list in the SAME order every time — no
 * randomness, no health caching, no stickiness: one decisive walk per call.
 * The winner is labeled, so every audit event names the provider that served.
 */

import type { ChatCompletion, ChatRequest, LlmClient, LlmError, LlmFailureCode } from '@dropagentx/llm';

export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T; readonly provider: string; readonly attempts: readonly ProviderAttempt[] }
  | { readonly ok: false; readonly error: LlmError; readonly attempts: readonly ProviderAttempt[] };

export interface ProviderAttempt {
  readonly provider: string;
  readonly ok: boolean;
  readonly code: LlmFailureCode | null;
  readonly message: string;
}

export interface ChainEntry {
  readonly name: string;
  readonly client: LlmClient;
}

export class ProviderChain {
  private readonly entries: readonly ChainEntry[];

  constructor(entries: readonly ChainEntry[]) {
    if (entries.length === 0) {
      throw new Error('ProviderChain requires at least one provider (fail-closed: an empty chain boots nothing).');
    }
    this.entries = entries;
  }

  get names(): readonly string[] {
    return this.entries.map((e) => e.name);
  }

  /** The head of the chain — used for cheap routing/classification calls. */
  get routingClient(): LlmClient {
    const head = this.entries[0];
    if (head === undefined) throw new Error('ProviderChain has no providers.');
    return head.client;
  }

  async chat(request: ChatRequest): Promise<ProviderResult<ChatCompletion>> {
    const attempts: ProviderAttempt[] = [];
    for (const entry of this.entries) {
      const result = await entry.client.chat(request);
      if (result.ok) {
        attempts.push({ provider: entry.name, ok: true, code: null, message: 'served' });
        return { ok: true, value: result.value, provider: entry.name, attempts };
      }
      attempts.push({
        provider: entry.name,
        ok: false,
        code: result.error.code,
        message: result.error.message,
      });
      // Deterministic next hop: every failure code falls through — auth, rate
      // limit, provider error, timeout, network, malformed. A provider that
      // cannot serve is skipped; the chain never retries the same provider.
    }
    const last = attempts[attempts.length - 1];
    const summary = attempts.map((a) => `${a.provider}:${a.code ?? 'ok'}`).join(' → ');
    return {
      ok: false,
      error: {
        code: last?.code ?? 'PROVIDER_ERROR',
        message: `All ${this.entries.length} provider(s) failed — ${summary}.`,
        meta: { providers: this.entries.length, attempts: attempts.length },
      },
      attempts,
    };
  }

  /** Cheap health probe across all providers (for /health and diagnostics). */
  async probe(): Promise<readonly ProviderAttempt[]> {
    const attempts: ProviderAttempt[] = [];
    for (const entry of this.entries) {
      const result = await entry.client.models();
      attempts.push({
        provider: entry.name,
        ok: result.ok,
        code: result.ok ? null : result.error.code,
        message: result.ok ? `reachable — ${result.value.length} model(s)` : result.error.message,
      });
    }
    return attempts;
  }
}
