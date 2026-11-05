# apps/bot — فاز ۳ ✅

ربات تلگرام DropAgentX v3. معماری شش‌ضلعی: **Orchestrator خالص** (بدون grammY، قابل‌تست آفلاین) + لایه‌ی چسب grammy + کلاینت تایپ‌دار contracts به سرور فاز ۲.

## معماری

```
telegram/bot.ts   →  core/orchestrator.ts  →  createV3Client (contracts)
   (grammY glue)      (منطق خالص + authz)        (HTTP به apps/server)
```

- **orchestrator خالص**: هیچ ایمپورتی از grammY ندارد؛ ورودی `BotActor + {text, commandId}`، خروجی `BotOutcome` (متن + کیبورد + notifyAdmin/notifyRequester). در تست‌ها با `bot.handleUpdate` و استاب‌کردن API تلگرام، کل مسیر واقعی (Update → orchestrator → HTTP → server → پاسخ) بدون شبکه تست می‌شود.
- **Authz fail-closed در orchestrator**: سرور admin-keyed است (ربات = سرویس مورد اعتماد با `KIA_ADMIN_KEY` مشترک)؛ اما کاربر فقط روی اسکروهای خودش اثر دارد — خریدار: fund/release/dispute/cancel، فروشنده: deliver. رد شدن → `notYourEscrow`.
- **Idempotency قطعی**: کلیدها از شناسه‌ی پیام تلگرام ساخته می‌شوند (`esc:buy:<tgId>:<chatId>:<msgId>`، `fund:<escrowId>`، `release:<escrowId>`، `hitl:release:<escrowId>:<commandId>`) → retry وب‌هوک هرگز دوباره پول جابه‌جا نمی‌کند. replay مسیر `ESCROW_ALREADY_EXISTS` صادقانه ادامه‌ی کار می‌دهد.

## HITL (ماده ۷ منشور)

- `/release` روی مبالغ ≥ ۵۰٬۰۰۰ Đ → درخواست در صف سرور (`POST /hitl`) + نوتیف به چت ادمین با دکمه‌های شیشه‌ای (callback data مثل `hitl:approve:<id>` — چون id خودش `:` دارد، فقط دو سگمنت اول ساختاری هستند).
- تایید ادمین روی سرور **تسویه را در همان تراکنش تصمیم اجرا می‌کند** (فروشنده ۹۰٪ + خزانه ۱۰٪) و به درخواست‌دهنده پیام می‌دهد. TTL پیش‌فرض ۲۴ ساعت، `/sweep` و interval داخلی صف را منقضی می‌کنند.

## دستورها

کاربر: `/start /help /balance /economy /buy /orders /fund /deliver /release /dispute /cancel /whoami /lang fa|en`
ادمین (چت `TELEGRAM_ADMIN_CHAT_ID`): `/pending /approve /reject /mint /sweep`

i18n: fa پیش‌فرض، en با `/lang en`. خطاهای وایر (کد HTTP) به پیام فارسی/انگلیسی نگاشت می‌شوند؛ کد ناشناخته هرگز پیام خالی نمی‌دهد.

## اجرا

```bash
cp .env.example .env    # SERVER_BASE_URL، KIA_ADMIN_KEY (با سرور یکی)، TELEGRAM_BOT_TOKEN، TELEGRAM_ADMIN_CHAT_ID
pnpm dev                # polling
```
وب‌هوک (Railway، فاز ۶): `BOT_MODE=webhook` + `BOT_WEBHOOK_URL`.

## تست‌ها (۲۰ تست)

- `tests/orchestrator.test.ts` (۱۷): پذیرش فاز ۳ روی سرور واقعی HTTP — `/balance`، `/buy`، `/orders` روی دیتابیس v3؛ retry دوباره پول جابه‌جا نمی‌کند؛ authz؛ مسیر مستقیم و HITL؛ رد/انقضا؛ refund داوری؛ Σ=0 در پایان روز.
- `tests/telegram.test.ts` (۳): Update واقعی grammY → orchestrator → HTTP واقعی؛ sendMessage استاب می‌شود؛ callback دکمه‌ی ادمین تسویه می‌کند.

معیار پذیرش: `docs/ROADMAP.md` → فاز ۳ (✅ محقق شد).
