/**
 * Typed errors + Result pattern — fail-closed domain boundary.
 *
 * Rule: no exceptions cross the domain boundary. Handlers return Result<T>.
 * Exceptions are only for programmer errors (unwrap in tests).
 */

export type DomainErrorCode =
  | 'NON_INTEGER_AMOUNT'
  | 'NEGATIVE_AMOUNT'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'BPS_OUT_OF_RANGE'
  | 'TOO_FEW_POSTINGS'
  | 'UNBALANCED_TRANSACTION'
  | 'UNKNOWN_ACCOUNT'
  | 'INVALID_ACCOUNT_KIND'
  | 'DUPLICATE_ACCOUNT'
  | 'ACCOUNT_OVERDRAFT'
  | 'INVALID_TRANSITION'
  | 'ESCROW_NOT_FOUND'
  | 'ESCROW_ALREADY_EXISTS'
  | 'REQUIRES_HUMAN_APPROVAL'
  | 'MINT_CAP_EXCEEDED';

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly meta?: Readonly<Record<string, string | number>>;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = <T = never>(
  code: DomainErrorCode,
  message: string,
  meta?: Record<string, string | number>,
): Result<T> => ({ ok: false, error: { code, message, meta } });

/** Test/programmer helper only — never use inside domain handlers. */
export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw new Error(`${r.error.code}: ${r.error.message}`);
}
