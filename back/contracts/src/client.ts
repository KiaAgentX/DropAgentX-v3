/**
 * Typed v3 API client (ADR-005) — closes the contracts loop:
 * server and clients share THE SAME zod schemas, so a response that drifted
 * from the wire contract fails HERE, at compile time (types) and at runtime
 * (schema validation), never as a silent UI bug.
 *
 * Discipline mirrors the domain: results are Results — no exceptions thrown
 * across the boundary; every failure carries the wire error code verbatim.
 */

import { z } from 'zod';
import {
  type AccountView,
  accountListResponseSchema,
  accountViewSchema,
  balanceResponseSchema,
  type BalanceResponse,
  type CreateAccountRequest,
  createAccountRequestSchema,
} from './accounts.js';
import { type EscrowStatusWire, escrowStatusSchema } from './common.js';
import { type EconomySummary, economySummarySchema } from './economy.js';
import {
  cancelEscrowRequestSchema,
  type CancelEscrowRequest,
  createEscrowRequestSchema,
  type CreateEscrowRequest,
  deliverEscrowRequestSchema,
  type DeliverEscrowRequest,
  disputeEscrowRequestSchema,
  type DisputeEscrowRequest,
  type EscrowActionResponse,
  escrowActionResponseSchema,
  type EscrowView,
  escrowListResponseSchema,
  escrowViewSchema,
  expireEscrowRequestSchema,
  type ExpireEscrowRequest,
  fundEscrowRequestSchema,
  type FundEscrowRequest,
  releaseEscrowRequestSchema,
  type ReleaseEscrowRequest,
  refundEscrowRequestSchema,
  type RefundEscrowRequest,
} from './escrows.js';
import {
  type CreateHitlRequest,
  createHitlRequestSchema,
  type HitlActionResponse,
  hitlActionResponseSchema,
  type HitlDecisionRequest,
  hitlDecisionRequestSchema,
  type HitlListResponse,
  hitlListResponseSchema,
  type HitlSweepResponse,
  hitlSweepResponseSchema,
  hitlStatusSchema,
  type HitlStatusWire,
  type HitlView,
  hitlViewSchema,
} from './hitl.js';
import { type HealthResponse, healthResponseSchema } from './system.js';
import {
  burnRequestSchema,
  type BurnRequest,
  mintRequestSchema,
  type MintRequest,
  type WalletMoveResponse,
  walletMoveResponseSchema,
} from './wallet.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientError {
  /** Wire error code verbatim, or one of: NETWORK, MALFORMED_ERROR_BODY, RESPONSE_MISMATCH. */
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly meta?: Readonly<Record<string, string | number>>;
}

export type ApiClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiClientError };

export interface V3ClientOptions {
  /** API root, e.g. https://host.example/api/v1 */
  readonly baseUrl: string;
  /** Extra headers on every call, e.g. { 'x-kia-key': '…' } for admin routes. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Injectable transport — tests can run the client against app.inject(). */
  readonly fetchImpl?: FetchLike;
}

export interface V3Client {
  economy(): Promise<ApiClientResult<EconomySummary>>;
  health(): Promise<ApiClientResult<HealthResponse>>;
  createAccount(request: CreateAccountRequest): Promise<ApiClientResult<AccountView>>;
  listAccounts(): Promise<ApiClientResult<{ items: AccountView[] }>>;
  balance(accountId: string): Promise<ApiClientResult<BalanceResponse>>;
  mint(request: MintRequest): Promise<ApiClientResult<WalletMoveResponse>>;
  burn(request: BurnRequest): Promise<ApiClientResult<WalletMoveResponse>>;
  createEscrow(request: CreateEscrowRequest): Promise<ApiClientResult<EscrowActionResponse>>;
  listEscrows(status?: EscrowStatusWire): Promise<ApiClientResult<{ items: EscrowView[] }>>;
  getEscrow(id: string): Promise<ApiClientResult<EscrowView>>;
  fundEscrow(id: string, request?: FundEscrowRequest): Promise<ApiClientResult<EscrowActionResponse>>;
  deliverEscrow(id: string, request?: DeliverEscrowRequest): Promise<ApiClientResult<EscrowActionResponse>>;
  releaseEscrow(id: string, request?: ReleaseEscrowRequest): Promise<ApiClientResult<EscrowActionResponse>>;
  disputeEscrow(id: string, request: DisputeEscrowRequest): Promise<ApiClientResult<EscrowActionResponse>>;
  refundEscrow(id: string, request?: RefundEscrowRequest): Promise<ApiClientResult<EscrowActionResponse>>;
  cancelEscrow(id: string, request?: CancelEscrowRequest): Promise<ApiClientResult<EscrowActionResponse>>;
  expireEscrow(id: string, request?: ExpireEscrowRequest): Promise<ApiClientResult<EscrowActionResponse>>;
  createHitlRequest(request: CreateHitlRequest): Promise<ApiClientResult<HitlView>>;
  listHitl(status?: HitlStatusWire): Promise<ApiClientResult<HitlListResponse>>;
  getHitl(id: string): Promise<ApiClientResult<HitlView>>;
  approveHitl(id: string, request: HitlDecisionRequest): Promise<ApiClientResult<HitlActionResponse>>;
  rejectHitl(id: string, request: HitlDecisionRequest): Promise<ApiClientResult<HitlActionResponse>>;
  sweepHitl(): Promise<ApiClientResult<HitlSweepResponse>>;
}

const ESCROW_STATUS_QUERY = z.object({ status: escrowStatusSchema.optional() });
const HITL_STATUS_QUERY = z.object({ status: hitlStatusSchema.optional() });

function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`Missing path parameter: ${key}`);
    return encodeURIComponent(value);
  });
}

export function createV3Client(options: V3ClientOptions): V3Client {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call<Res>(
    method: 'GET' | 'POST',
    path: string,
    args: {
      readonly pathParams?: Record<string, string>;
      readonly query?: Record<string, string>;
      /** Optional wire-contract check on the query BEFORE any network call. */
      readonly queryInput?: z.ZodType;
      readonly body?: unknown;
      /** Optional wire-contract check on the body BEFORE any network call. */
      readonly input?: z.ZodType;
      readonly schema: z.ZodType<Res>;
    },
  ): Promise<ApiClientResult<Res>> {
    if (args.input !== undefined && args.body !== undefined) {
      const checked = args.input.safeParse(args.body);
      if (!checked.success) {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: `Request violated the wire contract — ${checked.error.issues.length} issue(s).` },
        };
      }
    }
    if (args.queryInput !== undefined && args.query !== undefined) {
      const checked = args.queryInput.safeParse(args.query);
      if (!checked.success) {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: `Query violated the wire contract — ${checked.error.issues.length} issue(s).` },
        };
      }
    }
    // NOTE: base path must be preserved — new URL(path, base) would DROP it.
    const search =
      args.query !== undefined && Object.keys(args.query).length > 0
        ? `?${new URLSearchParams(args.query).toString()}`
        : '';
    const url = `${base}${fillPath(path, args.pathParams ?? {})}${search}`;

    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          ...(args.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 200) : 'unknown transport failure';
      return { ok: false, error: { code: 'NETWORK', message: `Could not reach the v3 API — ${reason}` } };
    }

    const text = await res.text();
    if (!res.ok) {
      let parsedError: unknown;
      try {
        parsedError = JSON.parse(text) as unknown;
      } catch {
        return {
          ok: false,
          error: { code: 'MALFORMED_ERROR_BODY', message: text.slice(0, 300) || `HTTP ${res.status}`, status: res.status },
        };
      }
      const envelope = z.object({ error: z.object({ code: z.string(), message: z.string(), meta: z.record(z.string(), z.union([z.string(), z.number()])).optional() }) }).safeParse(parsedError);
      if (!envelope.success) {
        return {
          ok: false,
          error: { code: 'MALFORMED_ERROR_BODY', message: text.slice(0, 300) || `HTTP ${res.status}`, status: res.status },
        };
      }
      return {
        ok: false,
        error: { code: envelope.data.error.code, message: envelope.data.error.message, status: res.status, meta: envelope.data.error.meta },
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, error: { code: 'MALFORMED_ERROR_BODY', message: '2xx response was not JSON', status: res.status } };
    }
    const checked = args.schema.safeParse(payload);
    if (!checked.success) {
      return {
        ok: false,
        error: {
          code: 'RESPONSE_MISMATCH',
          message: `Response violated the wire contract — ${checked.error.issues.length} issue(s).`,
          status: res.status,
        },
      };
    }
    return { ok: true, value: checked.data };
  }

  return {
    economy: () => call('GET', '/economy', { schema: economySummarySchema }),
    health: () => call('GET', '/health', { schema: healthResponseSchema }),
    createAccount: (request) =>
      call('POST', '/accounts', { body: request, input: createAccountRequestSchema, schema: accountViewSchema }),
    listAccounts: () => call('GET', '/accounts', { schema: accountListResponseSchema }),
    balance: (accountId) => call('GET', '/accounts/{id}/balance', { pathParams: { id: accountId }, schema: balanceResponseSchema }),
    mint: (request) => call('POST', '/wallet/mint', { body: request, input: mintRequestSchema, schema: walletMoveResponseSchema }),
    burn: (request) => call('POST', '/wallet/burn', { body: request, input: burnRequestSchema, schema: walletMoveResponseSchema }),
    createEscrow: (request) => call('POST', '/escrows', { body: request, input: createEscrowRequestSchema, schema: escrowActionResponseSchema }),
    listEscrows: (status) =>
      call('GET', '/escrows', {
        ...(status !== undefined ? { query: { status } } : {}),
        queryInput: ESCROW_STATUS_QUERY,
        schema: escrowListResponseSchema,
      }),
    getEscrow: (id) => call('GET', '/escrows/{id}', { pathParams: { id }, schema: escrowViewSchema }),
    fundEscrow: (id, request = {}) =>
      call('POST', '/escrows/{id}/fund', { pathParams: { id }, body: request, input: fundEscrowRequestSchema, schema: escrowActionResponseSchema }),
    deliverEscrow: (id, request = {}) =>
      call('POST', '/escrows/{id}/deliver', { pathParams: { id }, body: request, input: deliverEscrowRequestSchema, schema: escrowActionResponseSchema }),
    releaseEscrow: (id, request = {}) =>
      call('POST', '/escrows/{id}/release', { pathParams: { id }, body: request, input: releaseEscrowRequestSchema, schema: escrowActionResponseSchema }),
    disputeEscrow: (id, request) =>
      call('POST', '/escrows/{id}/dispute', { pathParams: { id }, body: request, input: disputeEscrowRequestSchema, schema: escrowActionResponseSchema }),
    refundEscrow: (id, request = {}) =>
      call('POST', '/escrows/{id}/refund', { pathParams: { id }, body: request, input: refundEscrowRequestSchema, schema: escrowActionResponseSchema }),
    cancelEscrow: (id, request = {}) =>
      call('POST', '/escrows/{id}/cancel', { pathParams: { id }, body: request, input: cancelEscrowRequestSchema, schema: escrowActionResponseSchema }),
    expireEscrow: (id, request = {}) =>
      call('POST', '/escrows/{id}/expire', { pathParams: { id }, body: request, input: expireEscrowRequestSchema, schema: escrowActionResponseSchema }),
    createHitlRequest: (request) =>
      call('POST', '/hitl', { body: request, input: createHitlRequestSchema, schema: hitlViewSchema }),
    listHitl: (status) =>
      call('GET', '/hitl', {
        ...(status !== undefined ? { query: { status } } : {}),
        queryInput: HITL_STATUS_QUERY,
        schema: hitlListResponseSchema,
      }),
    getHitl: (id) => call('GET', '/hitl/{id}', { pathParams: { id }, schema: hitlViewSchema }),
    approveHitl: (id, request) =>
      call('POST', '/hitl/{id}/approve', { pathParams: { id }, body: request, input: hitlDecisionRequestSchema, schema: hitlActionResponseSchema }),
    rejectHitl: (id, request) =>
      call('POST', '/hitl/{id}/reject', { pathParams: { id }, body: request, input: hitlDecisionRequestSchema, schema: hitlActionResponseSchema }),
    sweepHitl: () => call('POST', '/hitl/sweep', { schema: hitlSweepResponseSchema }),
  };
}
