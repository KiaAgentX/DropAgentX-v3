/**
 * HTTP error taxonomy — domain codes map to honest status codes.
 */

import type { DomainError } from '@dropagentx/domain';

export class DomainFailure extends Error {
  constructor(readonly error: DomainError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'DomainFailure';
  }
}

export class ValidationFailure extends Error {
  constructor(readonly issues: readonly { path: string; message: string }[]) {
    super(`Invalid request: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    this.name = 'ValidationFailure';
  }
}

export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly meta?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'HttpFailure';
  }
}

const NOT_FOUND_CODES = new Set(['ESCROW_NOT_FOUND', 'UNKNOWN_ACCOUNT']);

const UNPROCESSABLE_CODES = new Set([
  'INVALID_TRANSITION',
  'REQUIRES_HUMAN_APPROVAL',
  'ACCOUNT_OVERDRAFT',
  'UNBALANCED_TRANSACTION',
  'NON_INTEGER_AMOUNT',
  'NEGATIVE_AMOUNT',
  'AMOUNT_OUT_OF_RANGE',
  'BPS_OUT_OF_RANGE',
  'MINT_CAP_EXCEEDED',
  'ESCROW_ALREADY_EXISTS',
  'DUPLICATE_ACCOUNT',
  'INVALID_ACCOUNT_KIND',
  'TOO_FEW_POSTINGS',
  'ESCROW_TTL_NOT_REACHED',
]);

export interface HttpErrorPayload {
  status: number;
  body: { error: { code: string; message: string; meta?: Record<string, string | number> } };
}

export function toHttpError(err: unknown): HttpErrorPayload | null {
  if (err instanceof DomainFailure) {
    const code = err.error.code;
    if (NOT_FOUND_CODES.has(code)) {
      return { status: 404, body: { error: { code, message: err.error.message, meta: err.error.meta } } };
    }
    if (UNPROCESSABLE_CODES.has(code)) {
      return { status: 422, body: { error: { code, message: err.error.message, meta: err.error.meta } } };
    }
    return { status: 500, body: { error: { code, message: err.error.message, meta: err.error.meta } } };
  }
  if (err instanceof ValidationFailure) {
    return {
      status: 400,
      body: {
        error: {
          code: 'INVALID_REQUEST',
          message: err.message,
          meta: { issues: err.issues.length },
        },
      },
    };
  }
  if (err instanceof HttpFailure) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, meta: err.meta } } };
  }
  return null;
}
