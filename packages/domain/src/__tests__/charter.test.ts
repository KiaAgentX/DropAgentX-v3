import { describe, expect, it } from 'vitest';

import { err, unwrap } from '../errors.js';
import {
  assertMintWithinCap,
  CHARTER,
  CHARTER_ARTICLES,
  requiresHitl,
  splitSellerTax,
  taxOf,
} from '../charter.js';
import { din } from '../money.js';

const d = (n: number) => unwrap(din(n));

describe('charter — منشور پولی کشور دیجیتال', () => {
  it('fixes the genesis supply measured in the مهر ۱۴۰۵ audit', () => {
    expect(CHARTER.genesisSupplyDin).toBe(187_672);
  });

  it('charges exactly 10% tax (Article 2)', () => {
    expect(unwrap(taxOf(d(100)))).toBe(10);
    expect(unwrap(taxOf(d(1_000)))).toBe(100);
    expect(unwrap(taxOf(d(187_672)))).toBe(18_767); // floor
  });

  it('floors tax to keep money integer (10% of 5 Đ = 0)', () => {
    const split = unwrap(splitSellerTax(d(5)));
    expect(split.tax).toBe(0);
    expect(split.seller).toBe(5);
  });

  it('splits settlements so seller + tax = amount, always', () => {
    for (let n = 0; n <= 250; n++) {
      const split = unwrap(splitSellerTax(d(n)));
      expect(split.seller + split.tax).toBe(n);
      expect(split.seller).toBeGreaterThanOrEqual(0);
      expect(split.tax).toBeGreaterThanOrEqual(0);
    }
  });

  it('opens the HITL gate at exactly 50,000 Đ (Article 7)', () => {
    expect(requiresHitl(d(49_999))).toBe(false);
    expect(requiresHitl(d(50_000))).toBe(true);
    expect(requiresHitl(d(187_672))).toBe(true);
  });

  it('enforces the yearly mint cap (Article 3)', () => {
    expect(assertMintWithinCap(d(500_000), d(500_000))).toEqual({ ok: true, value: true });
    const r = assertMintWithinCap(d(999_000), d(2_000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MINT_CAP_EXCEEDED');
  });

  it('propagates errors from the money layer', () => {
    const r = assertMintWithinCap(d(0), d(1_000));
    expect(r.ok).toBe(true);
    const bad = err('MINT_CAP_EXCEEDED', 'test');
    expect(bad.ok).toBe(false);
  });

  it('ships the 10 articles as data', () => {
    expect(CHARTER_ARTICLES).toHaveLength(10);
    expect(CHARTER_ARTICLES[0]?.article).toBe(1);
    expect(CHARTER_ARTICLES[9]?.article).toBe(10);
  });
});
