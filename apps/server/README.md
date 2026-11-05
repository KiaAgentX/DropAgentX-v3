# @dropagentx/server — فاز ۲ ✅

Fastify v5 + Prisma روی هسته‌ی خالص دامنه. سرویس واحد server+bot آماده‌ی Railway (DNA یک‌سرویسی v2).

## آنچه در فاز ۲ ساخته شد

- **رجیستری تک‌منبع** (`src/api.ts`): هر endpoint = قرارداد zod + سطح امنیت + handler + داکیومنت OpenAPI از یک تعریف
- **۱۷ endpoint** زیر `/api/v1`: health · economy · accounts (create/list/balance) · wallet (mint/burn) · escrows (create/list/get/fund/deliver/release/dispute/refund/cancel/expire)
- **آداپتر persistence** (`src/persistence.ts`): در هر تراکنش تعاملی → load کامل دفتر (مطابق ADR-003 ترازها مشتق‌اند) → اجرای دامنه‌ی خالص → persist تراکنش+postings+escrow+Outbox+Audit
- **امنیت fail-closed**: `X-KIA-Key` (زمان-ثابت، بدون کانفیگ = 503) · Telegram initData HMAC · rate limit per-IP · audit log
- **OpenAPI**: `/api/v1/openapi.json` (3.1 از zod v4) + مرورگر `/api/v1/docs`

## اجرا

```bash
pnpm -F @dropagentx/server db:generate
pnpm -F @dropagentx/server db:push          # DATABASE_URL از .env
pnpm -F @dropagentx/server dev              # tsx watch src/main.ts
pnpm -F @dropagentx/server test             # 13/13 انتگراسیون روی SQLite واقعی
```

`.env` را از `.env.example` بسازید و خالی توزیع کنید — secret فقط در محیط اجرا.

## یادداشت کشف فنی (برای ایجنت بعدی)

Fastify v5 با **preHandler سنکرون** زنجیره‌ی lifecycle را می‌شکند (درخواست بدون پاسخ می‌ماند).
همه‌ی guard ها async تعریف شده‌اند — این قانون را نشکن.
