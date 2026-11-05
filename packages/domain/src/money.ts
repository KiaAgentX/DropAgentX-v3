/**
 * ADR-002 — Money is an integer. Always. Never a float.
 *
 * 1 Đ (dinar) = 1 minor unit = 1 integer. Legacy fractional credits
 * (e.g. 187,672.8) are resolved once, during migration, with an explicit
 * per-citizen rounding table (see docs/adr/ADR-002-money-integer.md).
 */

import { err, ok, type Result } from './errors.js';

declare const dinBrand: unique symbol;

/** Non-negative safe integer amount of DNX (dinar). */
export type Din = number & { readonly [dinBrand]: 'DNX' };

export const MAX_DIN: number = Number.MAX_SAFE_INTEGER;

export const DIN_ZERO: Din = 0 as Din;

export function din(n: number): Result<Din> {
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return err('NON_INTEGER_AMOUNT', `Money must be a finite integer, got ${n}`);
  }
  if (n < 0) {
    return err('NEGATIVE_AMOUNT', `Money cannot be negative, got ${n}`);
  }
  if (n > MAX_DIN) {
    return err('AMOUNT_OUT_OF_RANGE', `Money exceeds the safe integer range, got ${n}`);
  }
  return ok(n as Din);
}

export function isDin(n: unknown): n is Din {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

export function addDin(a: Din, b: Din): Result<Din> {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    return err('AMOUNT_OUT_OF_RANGE', `Sum exceeds the safe integer range: ${a}+${b}`);
  }
  return ok(sum as Din);
}

export function subDin(a: Din, b: Din): Result<Din> {
  if (b > a) {
    return err('NEGATIVE_AMOUNT', `Cannot subtract ${b} from ${a}`);
  }
  return ok((a - b) as Din);
}

export function cmpDin(a: Din, b: Din): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDin(a: Din, b: Din): Din {
  return (a <= b ? a : b) as Din;
}

/**
 * Multiply by basis points (1% = 100 bps) with floor rounding.
 * Used by the charter tax engine. Rejects bps outside [0, 10000].
 */
export function mulBps(a: Din, bps: number): Result<Din> {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    return err('BPS_OUT_OF_RANGE', `bps must be an integer in [0, 10000], got ${bps}`);
  }
  const product = a * bps;
  if (!Number.isSafeInteger(product)) {
    return err('AMOUNT_OUT_OF_RANGE', `Overflow computing ${a} * ${bps} / 10000`);
  }
  return ok(Math.floor(product / 10_000) as Din);
}

export function formatDin(a: Din): string {
  return `${a.toLocaleString('en-US')} Đ`;
}
