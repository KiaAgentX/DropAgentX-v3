# ROADMAP — DropAgentX v3 / Unified Core

هر فاز خروجی مستقل دارد، جدا ساخته می‌شود (به درخواست مالک: فرانت و بک‌اند و … جدا)،
و معیار پذیرش (acceptance criteria) صریح دارد. فاز بعدی فقط وقتی شروع می‌شود که فاز قبل سبز باشد.

---

## فاز ۰ — اسکلت Monorepo ✅

- pnpm workspaces + turbo tasks (`build/test/typecheck/lint`)
- TypeScript strict پایه: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- GitHub Actions CI (install → typecheck → test)
- **پذیرش**: `pnpm install && pnpm typecheck && pnpm test` روی ماشین تمیز سبز است.

## فاز ۱ — هسته‌ی دامنه (`packages/domain`) ✅

- `money.ts`: نوع `Din` — عدد صحیح برندشده، `mulBps` با floor، گارد سرریز
- `ledger.ts`: دفتر دوطرفه تغییرناپذیر + idempotency key + قوانین جهت حساب (mint/burn/user/escrow/treasury)
- `escrow.ts`: ماشین حالت ۸ وضعیته + ادغام با دفتر + TTL sweep
- `charter.ts`: منشور ۱۰ ماده‌ای به‌صورت policy قابل‌تست (مالیات ۱۰٪، سقف ضرب سالانه، آستانه HITL ۵۰k)
- `events.ts`: رویدادهای دامنه با id قطعی
- **پذیرش (محقق شد)**: ۴۰/۴۰ تست سبز، typecheck تمیز، صفر وابستگی runtime.
  تست‌های کلیدی: پایایی در ۳۰۰ عملیات تصادفی seed-دار، replay با idempotency،
  مسیر‌های غیرمجاز اسکرو رد می‌شوند، مالیات دقیقاً ۱۰٪ با floor.

## فاز ۲ — سرور (`apps/server`) ⏳

- Fastify + Prisma (SQLite، schema قابل‌انتقال به PG)
- `packages/contracts`: قراردادهای zod → تولید OpenAPI + کلاینت تایپ‌دار
- لایه‌ی امنیت: احراز Telegram initData + هدر `X-KIA-Key` برای ادمین + rate limit + audit log
- Outbox pattern برای رویدادهای دامنه (پل بین هسته‌ی خالص و persistence)
- **پذیرش**: `/api/v1/*` با OpenAPI قابل‌مرور؛ هر endpoint از قرارداد zod ساخته می‌شود؛
  تست انتگراسیون ledger→escrow→HTTP سبز؛ هیچ secret ای وارد کد نمی‌شود.

## فاز ۳ — ربات (`apps/bot`) ⏳

- grammY (webhook روی Railway، polling در توسعه) + Orchestrator
- صف HITL با TTL برای عملیات پولی ≥ ۵۰k
- ۲۸ دستور فعلی v2 به فرمت جدید مهاجرت می‌کند؛ i18n fa/en
- **پذیرش**: دستور `/balance`, `/buy`, `/orders` روی دیتابیس v3 کار می‌کند؛
  تلاش دوباره‌ی webhook ها دوبار پول جابه‌جا نمی‌کند (idempotency از فاز ۱).

## فاز ۴ — داشبورد (`apps/dashboard`) ⏳

- Aurora UI + RTL + fa/en + فونت Vazirmatn
- پنل ادمین: تراز‌ها، تراکنش‌ها، صف HITL، محصولات، پارلمان
- **پذیرش**: Lighthouse موبایل ≥ 90؛ RTL بدون شکستگی؛ خروجی از قرارداد OpenAPI فاز ۲.

## فاز ۵ — چرخه‌ی AI (`packages/ai-gateway`) ⏳

- AI Gateway چندسرویس‌دهنده: primary → secondary → fallback قطعی (یادگیری از 9router هرمس)
- ۶ ایجنت Zenovix + ۱۶ مهارت + ابزارهای fail-closed سبک KIA-OS
- سنجش مصرف per-user + سقف هزینه + پالایش خروجی
- **پذیرش**: قطع سرویس‌دهنده‌ی اصلی تست را نمی‌شکند (fallback فعال)؛
  هر پاسخ AI ممیز (audit) و پالایش‌شده است.

## فاز ۶ — مهاجرت و انتشار ⏳

- اسکریپت مهاجرت: ۴۶۶ کاربر، ۱٬۵۵۴ تراکنش، ۳۰ محصول، عرضه genesis ۱۸۷٬۶۷۲ Đ
- گپ تاریخی −۶۳ Đ → ردیف تعدیل صریح `adjustment:legacy-gap`
- changesets + نسخه‌گذاری + ZIP با SHA256 (آیین QC بسته‌ی v1.5.0)
- Railway: سرویس واحد server+bot، بکاپ روزانه db
- **پذیرش**: بعد از مهاجرت، Σ کیف‌های کاربران = ۱۸۷٬۶۷۲ Đ و `trialBalance.balanced === true`؛
  `nation-genesis-proof` روی دیتابیس جدید هم همان عدد را می‌دهد.
