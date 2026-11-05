/**
 * Dashboard API layer — the SAME typed client the bot uses (ADR-005).
 * The only dashboard-specific concern is injecting the admin key header
 * and translating wire error codes to i18n keys; validation of every
 * response still happens in the contracts schemas.
 *
 * The key never lands anywhere but memory + sessionStorage (see session.tsx)
 * and is only ever attached as the X-KIA-Key header.
 */

import {
  type ApiClientError,
  type ApiClientResult,
  type V3Client,
  createV3Client,
  type FetchLike,
} from '@dropagentx/contracts';
import type { I18nKey } from './i18n.js';

export interface DashboardClientOptions {
  readonly baseUrl: string;
  readonly adminKey: string | null;
  readonly fetchImpl?: FetchLike;
}

export function createDashboardClient(options: DashboardClientOptions): V3Client {
  const headers: Record<string, string> = {};
  if (options.adminKey !== null && options.adminKey !== '') {
    headers['x-kia-key'] = options.adminKey;
  }
  const base: { baseUrl: string; headers: Record<string, string> } = {
    baseUrl: options.baseUrl,
    headers,
  };
  return options.fetchImpl !== undefined
    ? createV3Client({ ...base, fetchImpl: options.fetchImpl })
    : createV3Client(base);
}

/** Wire codes that mean "your session/key is the problem" → show the gate. */
const AUTH_CODES = new Set(['ADMIN_KEY_REQUIRED', 'INVALID_ADMIN_KEY', 'ADMIN_DISABLED']);

export function isAuthError(error: ApiClientError | undefined): boolean {
  return error !== undefined && AUTH_CODES.has(error.code);
}

/** Wire codes that mean "server unreachable" → show the connectivity banner. */
export function isNetworkError(error: ApiClientError | undefined): boolean {
  return error !== undefined && error.code === 'NETWORK';
}

/** Validation failures (422 shape) carry this code on the wire. */
export function isValidationError(error: ApiClientError | undefined): boolean {
  return error !== undefined && error.code === 'INVALID_REQUEST';
}

const ERROR_KEYS: Readonly<Record<string, I18nKey>> = {
  NETWORK: 'err.NETWORK',
  MALFORMED_ERROR_BODY: 'err.MALFORMED_ERROR_BODY',
  RESPONSE_MISMATCH: 'err.RESPONSE_MISMATCH',
  UNKNOWN_ACCOUNT: 'err.UNKNOWN_ACCOUNT',
  DUPLICATE_ACCOUNT: 'err.DUPLICATE_ACCOUNT',
  ACCOUNT_OVERDRAFT: 'err.ACCOUNT_OVERDRAFT',
  INVALID_TRANSITION: 'err.INVALID_TRANSITION',
  ESCROW_NOT_FOUND: 'err.ESCROW_NOT_FOUND',
  ESCROW_ALREADY_EXISTS: 'err.ESCROW_ALREADY_EXISTS',
  REQUIRES_HUMAN_APPROVAL: 'err.REQUIRES_HUMAN_APPROVAL',
  MINT_CAP_EXCEEDED: 'err.MINT_CAP_EXCEEDED',
  HITL_NOT_FOUND: 'err.HITL_NOT_FOUND',
  HITL_NOT_REQUIRED: 'err.HITL_NOT_REQUIRED',
  HITL_ALREADY_DECIDED: 'err.HITL_ALREADY_DECIDED',
  HITL_EXPIRED: 'err.HITL_EXPIRED',
  ADMIN_KEY_REQUIRED: 'err.ADMIN_KEY_REQUIRED',
  INVALID_ADMIN_KEY: 'err.INVALID_ADMIN_KEY',
  ADMIN_DISABLED: 'err.ADMIN_DISABLED',
  RATE_LIMITED: 'err.RATE_LIMITED',
  INVALID_REQUEST: 'err.VALIDATION',
};

/** Map a client error to its i18n key; unknown codes fall back to err.GENERIC. */
export function errorKey(error: ApiClientError): I18nKey {
  return ERROR_KEYS[error.code] ?? 'err.GENERIC';
}

/** True when a code has dedicated friendly copy (used by the error banner). */
export function isMappedErrorCode(code: string): boolean {
  return code in ERROR_KEYS;
}

/** Adapt a wire error into a real Error for the UI banner (code carried along). */
export function bannerError(error: ApiClientError): Error & { code: string } {
  return Object.assign(new Error(error.message), { code: error.code });
}

/** Uniform "load a list or show the error banner" helper for pages.
 *  Accepts either a settled Result or the client promise directly. */
export async function unwrap<T>(result: ApiClientResult<T> | Promise<ApiClientResult<T>>): Promise<T> {
  const r = await result;
  if (r.ok) return r.value;
  throw r.error;
}
