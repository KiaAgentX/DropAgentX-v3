/**
 * Charter engine — منشور پولی کشور دیجیتال (pure policy, no IO).
 *
 * Mirrors docs/economy-charter.md of the v2 empire (10 articles) as a
 * machine-checkable policy module. Sacred invariant: money is conserved —
 * it is never created or destroyed outside mint/burn accounts.
 */

import { err, ok, type Result } from './errors.js';
import { addDin, mulBps, subDin, type Din } from './money.js';

export const CHARTER = {
  /** Article 1 — currency identity */
  currency: 'DNX',
  symbol: 'Đ',
  /** Article 2 — platform tax on marketplace settlement (10%) */
  taxBps: 1_000,
  /** Article 7 — human-in-the-loop threshold: actions ≥ 50,000 Đ need an owner approval */
  hitlThresholdDin: 50_000 as Din,
  /** Article 3 — yearly mint cap */
  yearlyMintCapDin: 1_000_000 as Din,
  /** Measured genesis supply (audit مهر ۱۴۰۵: Σ balances = 187,672 Đ, gap −63 Đ explained) */
  genesisSupplyDin: 187_672 as Din,
} as const;

export interface CharterArticle {
  readonly article: number;
  readonly title: string;
  readonly value: string;
}

export const CHARTER_ARTICLES: readonly CharterArticle[] = [
  { article: 1, title: 'واحد پول', value: 'دینار دیجیتال (Đ / DNX) — عدد صحیح، بدون اعشار' },
  { article: 2, title: 'مالیات بازار', value: '۱۰٪ هر تسویه اسکرو به خزانه می‌رود' },
  { article: 3, title: 'سقف ضرب', value: 'حداکثر ۱٬۰۰۰٬۰۰۰ Đ ضرب در سال' },
  { article: 4, title: 'حفاظت عرضه', value: 'پول فقط از حساب mint صادر و فقط به حساب burn می‌رود' },
  { article: 5, title: 'پایایی دفتر', value: 'هر تراکنش دوطرفه است و مجموع تراز همه حساب‌ها همیشه صفر است' },
  { article: 6, title: 'شفافیت', value: 'هر تراکنش شناسه یکتا و memo دارد' },
  { article: 7, title: 'آستانه HITL', value: 'عملیات ≥ ۵۰٬۰۰۰ Đ نیازمند تایید انسانی است' },
  { article: 8, title: 'اسکرو اجباری', value: 'خرید از مارکت فقط از مسیر اسکرو انجام می‌شود' },
  { article: 9, title: 'بازگشت وجه', value: 'اختلاف اسکرو به نفع خریدار بازگشت می‌شود مگر داوری خلاف آن را تعیین کند' },
  { article: 10, title: 'تعدادیل میراث', value: 'گپ تاریخی −۶۳ Đ با یک ردیف تعدیل شفاف ثبت شده است' },
];

export function taxOf(amount: Din): Result<Din> {
  return mulBps(amount, CHARTER.taxBps);
}

export interface SellerSplit {
  readonly seller: Din;
  readonly tax: Din;
}

/** Split a settlement amount into seller net + treasury tax (seller + tax = amount, always). */
export function splitSellerTax(amount: Din): Result<SellerSplit> {
  const tax = mulBps(amount, CHARTER.taxBps);
  if (!tax.ok) return tax;
  const seller = subDin(amount, tax.value);
  if (!seller.ok) return seller;
  return ok({ seller: seller.value, tax: tax.value });
}

/** Article 7 — HITL gate. */
export function requiresHitl(amount: Din): boolean {
  return amount >= CHARTER.hitlThresholdDin;
}

/** Article 3 — mint cap check against the running yearly total. */
export function assertMintWithinCap(mintedSoFar: Din, amount: Din): Result<true> {
  const next = addDin(mintedSoFar, amount);
  if (!next.ok) return next;
  if (next.value > CHARTER.yearlyMintCapDin) {
    return err(
      'MINT_CAP_EXCEEDED',
      `Yearly mint cap exceeded: ${mintedSoFar} + ${amount} > ${CHARTER.yearlyMintCapDin}`,
    );
  }
  return ok(true);
}
