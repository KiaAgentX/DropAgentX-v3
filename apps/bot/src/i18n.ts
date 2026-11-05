/**
 * i18n — fa is the primary language (v2 heritage), en is the second.
 * Errors are keyed by WIRE error codes verbatim, so a new server code can
 * never produce a blank message: unknown codes fall back to errGeneric.
 */

export type Locale = 'fa' | 'en';

const LOCALES: readonly Locale[] = ['fa', 'en'];

export function isLocale(v: string): v is Locale {
  return (LOCALES as readonly string[]).includes(v);
}

type Dict = Record<string, string>;

const fa: Dict = {
  welcome: 'سلام {name}! 👋\nکیف پول کشور دیجیتال v3 آماده است.\nحساب شما ساخته شد: {account}\nموجودی: {balance}\n\nراهنما: /help',
  help: 'دستورها:\n/balance — موجودی کیف پول\n/economy — وضعیت اقتصاد ملی\n/buy <مبلغ> <شناسه‌ی فروشنده> [شرح کالا] — خرید با اسکرو\n/orders — سفارش‌های من\n/fund <شناسه اسکرو> — واریز به اسکرو پس از شارژ کیف\n/deliver <شناسه اسکرو> — تایید ارسال (فروشنده)\n/release <شناسه اسکرو> — تسویه (خریدار)\n/dispute <شناسه اسکرو> <دلیل> — اختلاف (خریدار)\n/cancel <شناسه اسکرو> — لغو (خریدار، قبل از واریز)\n/whoami — هویت من\n/lang fa|en — تغییر زبان',
  helpAdmin: '\nدستورهای ادمین:\n/pending — صف تاییدهای انسانی\n/approve <شناسه> — تایید و تسویه\n/reject <شناسه> — رد درخواست\n/mint <حساب> <مبلغ> — ضرب دینار\n/sweep — پاک‌سازی صف‌های منقضی',
  balanceLine: 'موجودی {account}: {balance}',
  economyHeader: 'اقتصاد ملی 🏦',
  economyCirculating: 'عرضه در گردش: {value}',
  economyTreasury: 'خزانه: {value}',
  economyLocked: 'در اسکرو قفل شده: {value}',
  economyBalanced: 'تراز دفتر: ✓ متوازن (Σ = ۰)',
  economyUnbalanced: 'تراز دفتر: ✗ نامتوازن! (Σ = {value})',
  buyUsage: 'فرمت: /buy <مبلغ> <شناسه‌ی فروشنده> [شرح کالا]\nمثال: /buy 2500 2002 لپ‌تاپ دست دوم\nشناسه‌ی فروشنده = آیدی عددی تلگرام او.',
  buyOk: '✅ اسکرو ساخته شد: {escrow}\nمبلغ: {amount}\nفروشنده: {seller}\nوضعیت: FUNDED — پول قفل شد\nدر زمان تسویه ۱۰٪ مالیات به خزانه می‌رود.',
  buyFailed: 'اسکرو {escrow} ساخته شد اما واریز انجام نشد:\n{error}\nپس از شارژ کیف پول: /fund {escrow}',
  fundOk: '✅ اسکرو {escrow} تامین شد ({amount})',
  deliverOk: '📦 اسکرو {escrow} تحویل اعلام شد — منتظر تایید خریدار',
  releaseOk: '🤝 تسویه انجام شد:\nبه فروشنده: {net}\nمالیات خزانه (۱۰٪): {tax}\nشناسه تراکنش: {txId}',
  releasePending: '⏳ مبلغ {amount} بالای آستانه‌ی تایید انسانی (۵۰٬۰۰۰ Đ) است.\nدرخواست #{hitl} ثبت شد و برای ادمین ارسال گردید.\nپس از تایید ادمین تسویه انجام می‌شود.',
  disputeOk: '⚔️ اختلاف روی {escrow} ثبت شد — اسکرو قفل می‌ماند تا داوری',
  cancelOk: '✖️ اسکرو {escrow} لغو شد (هیچ پولی جابه‌جا نشده بود)',
  ordersHeader: 'سفارش‌های شما:',
  ordersEmpty: 'هنوز سفارشی ندارید. با /buy شروع کنید!',
  orderLine: '• {escrow} — {amount} — {status}{product}',
  notYourEscrow: 'این اسکرو متعلق به شما نیست — عملیات فقط برای خریدار/فروشنده‌ی همان اسکرو.',
  whoamiLine: 'آیدی تلگرام: {tg}\nحساب دفتر کل: {account}\nزبان: {locale}\nادمین: {admin}',
  langSwitched: 'زبان به انگلیسی تغییر کرد. /help برای راهنما.',
  pendingHeader: 'صف تایید انسانی (PENDING):',
  pendingEmpty: 'صف خالی است — همه چیز تایید یا رد شده.',
  pendingLine: '#{id} — {escrow} — {amount} — درخواست از: {requester}',
  approved: '✅ تایید شد #{id} — تسویه انجام شد\nبه فروشنده: {net} | مالیات: {tax}',
  rejected: '❌ درخواست #{id} رد شد — پول در اسکرو باقی می‌ماند تا داوری',
  sweepDone: 'پاک‌سازی: {count} درخواست منقضی منقضی شد.',
  minted: '🪙 {amount} به {account} ضرب شد — موجودی جدید: {balance}',
  mintUsage: 'فرمت: /mint <حساب> <مبلغ> — مثال: /mint user:tg:123 1000',
  adminOnly: 'این دستور فقط برای ادمین است.',
  unknownCommand: 'دستور ناشناخته. /help را ببینید.',
  kbApprove: '✅ تایید تسویه',
  kbReject: '❌ رد درخواست',
  hitlNotify: '🔔 درخواست تایید انسانی #{id}\nاسکرو: {escrow}\nمبلغ: {amount}\nدرخواست‌دهنده: {requester}\n\nتایید = تسویه (فروشنده {net} + خزانه {tax})',
  errInsufficientFunds: 'موجودی کافی نیست — دفتر اجازه‌ی منفی شدن حساب را نمی‌دهد.',
  errAccountNotFound: 'حساب پیدا نشد.',
  errEscrowNotFound: 'اسکرو پیدا نشد — شناسه را بررسی کنید.',
  errInvalidTransition: 'این وضعیت اجازه‌ی این عملیات را نمی‌دهد (ماشین حالت اسکرو).',
  errRequiresApproval: 'این عملیات نیازمند تایید انسانی است.',
  errEscrowExists: 'اسکرو تکراری است.',
  errHITLAlreadyDecided: 'این درخواست قبلا تایید یا رد شده است.',
  errHITLExpired: 'این درخواست منقضی شده است. دوباره درخواست دهید.',
  errHITLNotFound: 'درخواست تایید پیدا نشد.',
  errRateLimited: 'سرور شلوغ است — چند لحظه بعد تلاش کنید.',
  errServerAuth: 'احراز سرویس رد شد — کلید ادمین سرور و ربات باید یکی باشد.',
  errNetwork: 'ارتباط با سرور v3 برقرار نشد. بعدا تلاش کنید.',
  errGeneric: 'خطا: {code} — {message}',
  errBadAmount: 'مبلغ باید عدد صحیح مثبت باشد (بدون اعشار — ماده ۱ منشور).',
  errSellerRef: 'شناسه‌ی فروشنده نامعتبر است. آیدی عددی تلگرام یا شناسه‌ی حساب بدهید.',
  errUnknownLang: 'زبان باید fa یا en باشد.',
};

const en: Dict = {
  welcome: 'Hello {name}! 👋\nYour Digital Nation v3 wallet is ready.\nLedger account: {account}\nBalance: {balance}\n\nHelp: /help',
  help: 'Commands:\n/balance — wallet balance\n/economy — national economy\n/buy <amount> <sellerId> [product] — escrowed purchase\n/orders — my orders\n/fund <escrowId> — fund after topping up\n/deliver <escrowId> — confirm delivery (seller)\n/release <escrowId> — settle (buyer)\n/dispute <escrowId> <reason> — open dispute (buyer)\n/cancel <escrowId> — cancel (buyer, before funding)\n/whoami — my identity\n/lang fa|en — switch language',
  helpAdmin: '\nAdmin commands:\n/pending — human-approval queue\n/approve <id> — approve & settle\n/reject <id> — reject the request\n/mint <account> <amount> — mint dinar\n/sweep — expire stale queue entries',
  balanceLine: 'Balance of {account}: {balance}',
  economyHeader: 'National economy 🏦',
  economyCirculating: 'Circulating supply: {value}',
  economyTreasury: 'Treasury: {value}',
  economyLocked: 'Locked in escrow: {value}',
  economyBalanced: 'Trial balance: ✓ balanced (Σ = 0)',
  economyUnbalanced: 'Trial balance: ✗ UNBALANCED! (Σ = {value})',
  buyUsage: 'Format: /buy <amount> <sellerId> [product]\nExample: /buy 2500 2002 used laptop\nsellerId = the seller’s numeric Telegram id.',
  buyOk: '✅ Escrow created: {escrow}\nAmount: {amount}\nSeller: {seller}\nStatus: FUNDED — money locked\nOn settlement 10% goes to the treasury.',
  buyFailed: 'Escrow {escrow} was created but funding failed:\n{error}\nAfter topping up: /fund {escrow}',
  fundOk: '✅ Escrow {escrow} funded ({amount})',
  deliverOk: '📦 Escrow {escrow} marked delivered — awaiting buyer confirmation',
  releaseOk: '🤝 Settled:\nTo seller: {net}\nTreasury tax (10%): {tax}\nTx id: {txId}',
  releasePending: '⏳ {amount} is above the human-approval threshold (50,000 Đ).\nRequest #{hitl} was filed and sent to the admin.\nSettlement happens once the admin approves.',
  disputeOk: '⚔️ Dispute opened on {escrow} — escrow stays locked until arbitration',
  cancelOk: '✖️ Escrow {escrow} cancelled (no money had moved)',
  ordersHeader: 'Your orders:',
  ordersEmpty: 'No orders yet. Start with /buy!',
  orderLine: '• {escrow} — {amount} — {status}{product}',
  notYourEscrow: 'This escrow is not yours — only its buyer/seller may act on it.',
  whoamiLine: 'Telegram id: {tg}\nLedger account: {account}\nLocale: {locale}\nAdmin: {admin}',
  langSwitched: 'Language switched to فارسی. Type /help for commands.',
  pendingHeader: 'Human-approval queue (PENDING):',
  pendingEmpty: 'Queue is empty — everything decided.',
  pendingLine: '#{id} — {escrow} — {amount} — from: {requester}',
  approved: '✅ Approved #{id} — settled\nTo seller: {net} | tax: {tax}',
  rejected: '❌ Request #{id} rejected — money stays in escrow until arbitration',
  sweepDone: 'Sweep: {count} stale request(s) expired.',
  minted: '🪙 Minted {amount} into {account} — new balance: {balance}',
  mintUsage: 'Format: /mint <account> <amount> — e.g. /mint user:tg:123 1000',
  adminOnly: 'This command is admin-only.',
  unknownCommand: 'Unknown command. See /help.',
  kbApprove: '✅ Approve settlement',
  kbReject: '❌ Reject request',
  hitlNotify: '🔔 Human approval needed #{id}\nEscrow: {escrow}\nAmount: {amount}\nRequested by: {requester}\n\nApprove = settle (seller {net} + treasury {tax})',
  errInsufficientFunds: 'Insufficient funds — the ledger refuses negative balances.',
  errAccountNotFound: 'Account not found.',
  errEscrowNotFound: 'Escrow not found — check the id.',
  errInvalidTransition: 'This action is not allowed in the current state (escrow state machine).',
  errRequiresApproval: 'This action requires human approval.',
  errEscrowExists: 'Escrow already exists.',
  errHITLAlreadyDecided: 'This request was already approved or rejected.',
  errHITLExpired: 'This request expired. File it again.',
  errHITLNotFound: 'Approval request not found.',
  errRateLimited: 'Server is busy — retry in a moment.',
  errServerAuth: 'Service auth rejected — the bot and server admin keys must match.',
  errNetwork: 'Could not reach the v3 server. Try again later.',
  errGeneric: 'Error: {code} — {message}',
  errBadAmount: 'Amount must be a positive integer (no decimals — charter Article 1).',
  errSellerRef: 'Invalid seller id. Provide a numeric Telegram id or an account id.',
  errUnknownLang: 'Language must be fa or en.',
};

const DICTS: Record<Locale, Dict> = { fa, en };

export function t(locale: Locale, key: string, params: Record<string, string | number> = {}): string {
  const dict = DICTS[locale];
  const template = dict[key] ?? fa[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? `{${name}}`));
}

/** Integer money display — no floats ever reach this function (ADR-002). */
export function fmtDin(locale: Locale, amount: number): string {
  return `${amount.toLocaleString(locale === 'fa' ? 'fa-IR' : 'en-US')} Đ`;
}

/** Map a wire error code to an i18n key — additive: unknown codes fall back. */
export function errorKey(code: string): string {
  const KNOWN: Record<string, string> = {
    ACCOUNT_OVERDRAFT: 'errInsufficientFunds',
    UNKNOWN_ACCOUNT: 'errAccountNotFound',
    ESCROW_NOT_FOUND: 'errEscrowNotFound',
    INVALID_TRANSITION: 'errInvalidTransition',
    REQUIRES_HUMAN_APPROVAL: 'errRequiresApproval',
    ESCROW_ALREADY_EXISTS: 'errEscrowExists',
    HITL_ALREADY_DECIDED: 'errHITLAlreadyDecided',
    HITL_EXPIRED: 'errHITLExpired',
    HITL_NOT_FOUND: 'errHITLNotFound',
    HITL_NOT_REQUIRED: 'errRequiresApproval',
    RATE_LIMITED: 'errRateLimited',
    ADMIN_DISABLED: 'errServerAuth',
    ADMIN_KEY_REQUIRED: 'errServerAuth',
    INVALID_ADMIN_KEY: 'errServerAuth',
    NETWORK: 'errNetwork',
  };
  return KNOWN[code] ?? 'errGeneric';
}
