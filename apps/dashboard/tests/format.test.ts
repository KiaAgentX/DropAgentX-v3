/**
 * Unit — formatting helpers (integer money display, locales, relative time).
 */

import { describe, expect, it } from 'vitest';
import { din, num, pct, timeLeft, shortId, dateTime } from '../src/lib/format.js';

describe('format.din', () => {
  it('formats integers with locale digits and the Đ suffix', () => {
    expect(din(187_672, 'en')).toBe('187,672 Đ');
    expect(din(0, 'en')).toBe('0 Đ');
    // fa uses Extended Arabic-Indic digits and ٬ group separator
    expect(din(187_672, 'fa')).toBe('۱۸۷٬۶۷۲ Đ');
  });
});

describe('format.num / pct', () => {
  it('formats plain integers', () => {
    expect(num(42, 'en')).toBe('42');
    expect(num(42, 'fa')).toBe('۴۲');
  });
  it('computes floor percentages', () => {
    expect(pct(100_000, 1_000_000, 'en')).toBe('10%');
    expect(pct(0, 1_000_000, 'en')).toBe('0%');
    expect(pct(5, 0, 'en')).toBe('0%');
    expect(pct(1, 3, 'en')).toBe('33%');
  });
});

describe('format.timeLeft', () => {
  it('counts down hours and minutes', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(timeLeft('2026-01-01T03:30:00Z', 'en', now)).toBe('3h left');
    expect(timeLeft('2026-01-01T00:42:00Z', 'en', now)).toBe('42m left');
  });
  it('reports overdue for past timestamps', () => {
    const now = Date.parse('2026-01-02T00:00:00Z');
    expect(timeLeft('2026-01-01T00:00:00Z', 'en', now)).toBe('overdue');
    expect(timeLeft('2026-01-01T00:00:00Z', 'fa', now)).toBe('گذشته');
  });
});

describe('format.misc', () => {
  it('shortens long ids from the tail', () => {
    expect(shortId('escrow:o-1', 22)).toBe('escrow:o-1');
    const long = 'escrow:hitl-2026-01-01-abcd-efgh-ijkl';
    const out = shortId(long, 22);
    expect(out.startsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(22);
  });
  it('passes unknown dates through untouched', () => {
    expect(dateTime('not-a-date', 'en')).toBe('not-a-date');
  });
});
