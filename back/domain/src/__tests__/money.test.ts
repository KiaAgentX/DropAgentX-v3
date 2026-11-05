import { describe, expect, it } from 'vitest';

import { unwrap } from '../errors.js';
import { addDin, din, DIN_ZERO, formatDin, isDin, mulBps, subDin } from '../money.js';

describe('money — ADR-002 (integer money, no floats ever)', () => {
  it('accepts safe non-negative integers', () => {
    expect(unwrap(din(0))).toBe(0);
    expect(unwrap(din(1))).toBe(1);
    expect(unwrap(din(187_672))).toBe(187_672);
    expect(DIN_ZERO).toBe(0);
  });

  it('rejects floats', () => {
    const r = din(1.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NON_INTEGER_AMOUNT');
  });

  it('rejects NaN and Infinity', () => {
    expect(din(Number.NaN).ok).toBe(false);
    expect(din(Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it('rejects negative amounts', () => {
    const r = din(-1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NEGATIVE_AMOUNT');
  });

  it('rejects amounts beyond the safe integer range', () => {
    const r = din(9_007_199_254_740_992);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('AMOUNT_OUT_OF_RANGE');
  });

  it('adds and subtracts', () => {
    const a = unwrap(din(2));
    const b = unwrap(din(3));
    expect(unwrap(addDin(a, b))).toBe(5);
    expect(unwrap(subDin(b, a))).toBe(1);
  });

  it('rejects subtraction underflow', () => {
    const r = subDin(unwrap(din(2)), unwrap(din(3)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NEGATIVE_AMOUNT');
  });

  it('rejects addition overflow', () => {
    const a = unwrap(din(9_007_199_254_740_000));
    const b = unwrap(din(1_000));
    expect(addDin(a, b).ok).toBe(false);
  });

  it('mulBps floors (10% of 55 = 5, not 5.5)', () => {
    expect(unwrap(mulBps(unwrap(din(55)), 1_000))).toBe(5);
    expect(unwrap(mulBps(unwrap(din(100)), 1_000))).toBe(10);
    expect(unwrap(mulBps(unwrap(din(0)), 1_000))).toBe(0);
  });

  it('mulBps rejects out-of-range bps', () => {
    expect(mulBps(unwrap(din(10)), 10_001).ok).toBe(false);
    expect(mulBps(unwrap(din(10)), -1).ok).toBe(false);
    expect(mulBps(unwrap(din(10)), 1.5).ok).toBe(false);
  });

  it('isDin is a sound type guard', () => {
    expect(isDin(5)).toBe(true);
    expect(isDin(0)).toBe(true);
    expect(isDin(-5)).toBe(false);
    expect(isDin(1.5)).toBe(false);
    expect(isDin('5')).toBe(false);
  });

  it('formats with the Đ symbol', () => {
    expect(formatDin(unwrap(din(187_672)))).toBe('187,672 Đ');
  });
});
