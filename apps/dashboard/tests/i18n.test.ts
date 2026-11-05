/**
 * Unit — i18n: fa/en dictionaries must have EXACT key parity (Phase-4 gate:
 * fa/en both complete), interpolation must be total, dirs must be right.
 */

import { describe, expect, it } from 'vitest';
import { DIRS, DICTS, formatMessage, isLang, type I18nKey } from '../src/lib/i18n.js';

describe('i18n parity', () => {
  const faKeys = Object.keys(DICTS.fa).sort();
  const enKeys = Object.keys(DICTS.en).sort();

  it('fa and en have identical key sets', () => {
    expect(enKeys).toEqual(faKeys);
  });

  it('no empty translations', () => {
    for (const [lang, dict] of Object.entries(DICTS)) {
      for (const [k, v] of Object.entries(dict)) {
        expect(`${lang}/${k}: "${v}"`, `${lang}:${k}`).not.toBe('');
      }
    }
  });

  it('RTL for fa, LTR for en', () => {
    expect(DIRS.fa).toBe('rtl');
    expect(DIRS.en).toBe('ltr');
  });

  it('isLang accepts exactly fa/en', () => {
    expect(isLang('fa')).toBe(true);
    expect(isLang('en')).toBe(true);
    expect(isLang('ar')).toBe(false);
    expect(isLang(null)).toBe(false);
  });

  it('status keys cover the 8-state machine', () => {
    const statuses = ['CREATED', 'FUNDED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'REFUNDED', 'CANCELLED', 'EXPIRED'];
    for (const s of statuses) expect(DICTS.fa).toHaveProperty(`status.${s}`);
    for (const s of statuses) expect(DICTS.en).toHaveProperty(`status.${s}`);
  });

  it('hitl status keys cover the queue', () => {
    for (const s of ['PENDING', 'APPROVED', 'REJECTED', 'H_EXPIRED']) {
      expect(DICTS.fa).toHaveProperty(`hstatus.${s}`);
      expect(DICTS.en).toHaveProperty(`hstatus.${s}`);
    }
  });
});

describe('formatMessage', () => {
  it('interpolates named params', () => {
    expect(formatMessage('{amount} Đ minted → {id}', { amount: 100, id: 'u1' })).toBe('100 Đ minted → u1');
  });
  it('keeps unknown placeholders visible (no silent holes)', () => {
    expect(formatMessage('hi {name}', {})).toBe('hi {name}');
  });
  it('interpolates the Persian AI line', () => {
    const key: I18nKey = 'overview.aiEnabled';
    expect(formatMessage(DICTS.fa[key], { model: 'glm-4' })).toContain('glm-4');
  });
});
