/**
 * Formatting helpers — money is always displayed from the integer Đ value
 * (ADR-002): no floats anywhere, locale digits via Intl (fa → Persian digits).
 */

import type { Lang } from './i18n.js';

const NUMBER_FMT: Record<Lang, Intl.NumberFormat> = {
  fa: new Intl.NumberFormat('fa-IR', { useGrouping: true }),
  en: new Intl.NumberFormat('en-US', { useGrouping: true }),
};

const DATE_FMT: Record<Lang, Intl.DateTimeFormat> = {
  fa: new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }),
  en: new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
};

export function din(n: number, lang: Lang): string {
  return `${NUMBER_FMT[lang].format(n)} Đ`;
}

export function num(n: number, lang: Lang): string {
  return NUMBER_FMT[lang].format(n);
}

export function pct(part: number, whole: number, lang: Lang): string {
  if (whole <= 0) return '0%';
  return `${NUMBER_FMT[lang].format(Math.floor((part / whole) * 100))}%`;
}

export function dateTime(iso: string, lang: Lang): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return DATE_FMT[lang].format(new Date(t));
}

/** Relative expiry like "in 3h" / "overdue" — used by the HITL queue. */
export function timeLeft(iso: string, lang: Lang, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = t - nowMs;
  if (diff <= 0) return lang === 'fa' ? 'گذشته' : 'overdue';
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (hours >= 1) {
    return lang === 'fa' ? `${num(hours, lang)} ساعت مانده` : `${hours}h left`;
  }
  return lang === 'fa' ? `${num(mins, lang)} دقیقه مانده` : `${mins}m left`;
}

/** Monospace-safe short id for tables: `escrow:o-1:abc123` → tail. */
export function shortId(id: string, max = 22): string {
  return id.length <= max ? id : `…${id.slice(-max + 1)}`;
}
