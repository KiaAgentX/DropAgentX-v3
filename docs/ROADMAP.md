# ROADMAP — DropAgentX v3 / Unified Core

هر فاز خروجی مستقل دارد، جدا ساخته می‌شود (به درخواست مالک: فرانت و بک‌اند و … جدا)،
و معیار پذیرش (acceptance criteria) صریح دارد. فاز بعدی فقط وقتی شروع می‌شود که فاز قبل سبز باشد.

---

## فاز ۰ — اسکلت Monorepo ✅

- pnpm workspaces + turbo tasks (`build/test/typecheck/lint`)
- TypeScript strict پایه: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- GitHub Actions CI (install → typecheck → test)
- **پذیرش**: `pnpm install && pnpm typecheck && pnpm test` روی ماشین تمیز سبز است.

## فاز ۱ — هسته‌ی دامنه (`back/domain`) ✅

- `money.ts`: نوع `Din` — عدد صحیح برندشده، `mulBps` با floor، گارد سرریز
- `ledger.ts`: دفتر دوطرفه تغییرناپذیر + idempotency key + قوانین جهت حساب (mint/burn/user/escrow/treasury)
- `escrow.ts`: ماشین حالت ۸ وضعیته + ادغام با دفتر + TTL sweep
- `charter.ts`: منشور ۱۰ ماده‌ای به‌صورت policy قابل‌تست (مالیات ۱۰٪، سقف ضرب سالانه، آستانه HITL ۵۰k)
- `events.ts`: رویدادهای دامنه با id قطعی
- **پذیرش (محقق شد)**: ۴۰/۴۰ تست سبز، typecheck تمیز، صفر وابستگی runtime.
  تست‌های کلیدی: پایایی در ۳۰۰ عملیات تصادفی seed-دار، replay با idempotency،
  مسیر‌های غیرمجاز اسکرو رد می‌شوند، مالیات دقیقاً ۱۰٪ با floor.

## فاز ۲ — سرور (`back/server`) ✅

- Fastify v5 + Prisma (SQLite با `schema.prisma` قابل‌انتقال به PG) — `back/server`
- `back/contracts`: قراردادهای zod → تولید OpenAPI 3.1 بومی (بدون پل شخص ثالث، `z.toJSONSchema`)
- **۱۷ endpoint** از یک رجیستری واحد: قرارداد + امنیت + handler + داکیومنت از یک تعریف (realization واقعی ADR-005)
- لایه‌ی امنیت: `X-KIA-Key` با مقایسه‌ی زمان-ثابت و fail-closed (بدون کانفیگ → 503 ADMIN_DISABLED)،
  احراز Telegram initData با HMAC-SHA256 رسمی (آماده‌ی فاز ۳)، rate limit درون-حافظه‌ای، audit log
- آداپتر persistence: دفتر کامل در هر تراکنش تعاملی load → اجرای دامنه‌ی خالص → persist؛
  Outbox برای `DomainEvent`ها + ردیف audit؛ idempotency با unique constraint (مسابقه‌ی retry دوبار پول جابه‌جا نمی‌کند)
- `/api/v1/openapi.json` + صفحه‌ی مرور `/api/v1/docs`
- `back/llm` (**ADR-006**، به انتخاب مالک): کلاینت LLM سازگار با OpenAI بدون SDK شخص ثالث —
  سه متغیر `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `MODEL`، همه با هم یا هیچ‌کدام (کانفیگ ناقص → بوت نمی‌شود)،
  خطاهای Result تایپ‌دار، تایم‌اوت واقعی با AbortController، کلید هرگز در خطاها/لاگ‌ها فاش نمی‌شود
- کلاینت تایپ‌دار `createV3Client` در contracts — حلقه‌ی ADR-005 بسته شد: پاسخ‌ها با همان
  اسکیمای zod اعتبارسنجی می‌شوند و راند-تریپ واقعی روی `app.inject` تست شده است
- health شامل `llmConfigured` / `llmModel` است — بدون کلید و بدون URL (فقط حضور کانفیگ)
- مقادیر خالی در env (مثل `TELEGRAM_BOT_TOKEN=` در فایل .env) = تعریف‌نشده، نه خطا
- **پذیرش (محقق شد)**: ۱۶/۱۶ تست انتگراسیون سبز روی SQLite واقعی — چرخه‌ی کامل escrow از HTTP
  (۱۰۰ → فروشنده ۹۰ + خزانه ۱۰)، retry با idempotency، گیت HITL روی ۶۰٬۰۰۰ Đ، سقف ضرب سالانه،
  رض حساب منفی، 401/404/422/429 درست؛ **۸۴/۸۴ کل monorepo** (domain ۴۰ + llm ۱۷ + contracts ۱۱ + server ۱۶)؛
  tsc strict تمیز؛ بوت واقعی سرور با سه متغیر LLM و کانفیگ ناقص رد شد (curl-تست).

## فاز ۳ — ربات (`back/bot`) ✅

- grammY (webhook روی Railway، polling در توسعه) + **Orchestrator خالص** (بدون grammY — قابل‌تست آفلاین)
- صف HITL روی سرور (`/hitl/*` — ۶ endpoint جدید در contracts و OpenAPI): تایید ادمین، تسویه را **در همان تراکنش** اجرا می‌کند؛ id قطعی `hitl:<id>:approve` → تایید دوباره هرگز دوباره پرداخت نمی‌کند؛ TTL sweep (۲۴h پیش‌فرض)
- Authz fail-closed در orchestrator: خریدار fund/release/dispute/cancel، فروشنده deliver؛ کلیدهای idempotency از message_id تلگرام ساخته می‌شوند → retry وب‌هوک امن است
- i18n fa/en + نگاشت کد خطای وایر به پیام محلی؛ ۱۴ دستور کاربر + ۵ دستور ادمین + کیبورد شیشه‌ای HITL
- **پذیرش (محقق شد)**: `/balance`، `/buy`، `/orders` روی دیتابیس v3 سبز؛ تلاش دوباره‌ی update دوبار پول جابه‌جا نمی‌کند
  (تست replay با همان message_id)؛ HITL ≥ ۵۰٬۰۰۰ Đ از صف می‌گذرد و تاییدش دقیقاً ۹۰/۱۰ تسویه می‌کند؛
  **۱۱۴/۱۱۴ کل monorepo** (domain ۴۰ + llm ۱۷ + contracts ۱۱ + server ۲۶ + bot ۲۰)؛ tsc strict تمیز؛
  بوت دودی سرور: `llmConfigured:true` با سه متغیر ADR-006، ۲۰ مسیر OpenAPI با تگ hitl.

## فاز ۴ — داشبورد (`front/dashboard`) ✅

- **ADR-007**: Vite + React 19 + Tailwind v4 SPA — بدون SSR؛ hash routing بدون وابستگی router؛ در فاز ۶ همان `dist/` توسط Fastify استاتیک سرو می‌شود
- Aurora UI (دارک، شیشه‌ای، سه هاله‌ی ملایم) + RTL پیش‌فرض + fa/en با برابری کلیدی دوطرفه (تست + تایپ) + فونت Vazirmatn self-hosted با `font-display: swap`
- کلاینت = `createV3Client` تایپ‌دار فاز ۲ با لایه‌ی نازک تزریق `X-KIA-Key` — اعتبارسنجی پاسخ‌ها با همان zod قراردادها (حلقه‌ی ADR-005 از سمت داشبورد بسته شد)
- صفحات: نمای کلی عمومی (شفافیت ماده‌ی ۶: عرضه/خزانه/قفل اسکرو/سقف ضرب با گیج + سلامت سرور + وضعیت ADR-006)، حساب‌ها (ایجاد/ضرب/سوزاندن با تأیید)، اسکروها (صافی ۸ وضعیت + دکمه‌های چرخه‌ی عمر **کلیدهای idempotency قطعی** — دابل‌کلیک = replay بی‌اثر)، صف HITL (تأیید/رد با audit trail + سوئیپ منقضی‌ها)، تنظیمات (مدیریت کلید sessionStorage، پیوند OpenAPI، مقادیر منشور)
- گیت ادمین fail-closed: کلید قبل از ذخیره با یک endpoint واقعی ادمین امتحان می‌شود؛ خطاهای سیمی به پیام‌های محلی نگاشت می‌شوند (codes additive — ناشناخته‌ها به پیام عمومی می‌افتند)
- **پذیرش (محقق شد)**: RTL بدون شکستگی (تمام رنگ‌ها/فاصله‌ها با CSS منطقی start/end؛ تست flip خودکار fa↔en)؛
  **۱۴۹/۱۴۹ کل monorepo** (domain ۴۰ + llm ۱۷ + contracts ۱۱ + server ۲۶ + bot ۲۰ + dashboard ۳۵)؛
  roundtrip واقعی: کلاینت داشبورد ↔ Fastify/Prisma/SQLite ↔ هسته‌ی دامنه — mint→escrow→release دقیقاً ۹۰/۱۰،
  replay بدون پرداخت دوباره، overdraft رد، گیت HITL روی ۶۰٬۰۰۰ Đ تسویه‌ی اتمی، مهمان ۴۰۱ می‌گیرد؛
  tsc strict تمیز؛ باندل تولیدی ۱۱۲KB gzip؛ Lighthouse موبایل روی ماشین ادمین اجرا می‌شود (باندل/فونت swap آماده‌ی ≥ ۹۰).

## فاز ۵ — چرخه‌ی AI (`back/ai-gateway`) ✅

- لایه‌ی مدل قفل شد (**ADR-006**): فقط API سازگار با OpenAI؛ کلاینت در `back/llm` از فاز ۲
- **ADR-008**: AI Gateway چندسرویس‌دهنده — سه اسلات با همان شکل ADR-006
  (`OPENAI_BASE_URL/API_KEY/MODEL` + پسوند `_2`/`_3`)، هر اسلات همه‌یا-هیچ؛
  fallback قطعی primary → secondary → fallback، نام برنده در پاسخ و audit ثبت می‌شود
- ۶ ایجنت Zenovix (هماهنگ‌گر/پذیرش/فروش/پشتیبانی/تحلیل‌گر/محتوا) + دقیقاً **۱۶ مهارت KIA-OS**
  با رجیستری واحد: هویت + متادیتا fa/en + zod + مجوز ایجنت — گیت fail-closed **قبل از** اجرا؛
  allowedSkills ایجنت‌ها از همان رجیستری مشتق می‌شود (بدون drift)
- پاکت JSON به‌جای function-calling اختصاصی: `{"reply"}` یا `{"tool","args"}` —
  دو پاکت خراب = شکست تایپ‌دار، متن خام مدل هرگز عبور نمی‌کند
- سنجش مصرف per-user با سقف روزانه (`AI_DAILY_TOKEN_CAP`، پیش‌فرض ۱۲۰٬۰۰۰) روی جدول `AiUsage` —
  گیت **قبل از** هر فراخوانی provider؛ سقف تمام → 429 typed
- پالایش خروجی با ۹ قاعده‌ی جنگ‌آزموده‌ی لجسی (PEM، Bearer، JWT، sk، توکن تلگرام، AWS، کارت، seed phrase، hex) + شمارش در audit
- هر پاسخ ممیز می‌شود: `ai.ok|refused|failed|pending` در `AuditLog` با provider/model/token/redactions
- نقش staff فقط پشت `X-KIA-Key` معتبر معنا دارد (401 وگرنه)؛ `/ai/usage` ادمین-تنها؛
  مسیر پول: ≥ ۵۰٬۰۰۰ Đ فقط ردیف HITL می‌سازد (و دامنه درون `releaseEscrow` دوباره سد می‌گذارد)
- **پذیرش (محقق شد)**: ۲۹/۲۹ تست بسته (fake LLM بدون شبکه) + ۹/۹ تست انتگراسیون سرور
  با provider سازگار-با-OpenAI درون-پردازشی: قطع primary → secondary جواب می‌دهد؛
  escrow_refund ۶۰٬۰۰۰ Đ → ردیف HITL با اسکرو هنوز FUNDED؛ سقف تمام → 429 قبل از provider؛
  redaction روی سیم با شمارش در audit؛ **۱۸۷/۱۸۷ کل monorepo** — tsc strict تمیز روی ۷ پروژه

## فاز ۶ — مهاجرت و انتشار ✅

- `back/server/scripts/migrate-legacy.ts`: ۴۶۶ کاربر → حساب‌های `user:tg:<id>`،
  **یک تراکنش genesis** با idempotency قطعی (`legacy:genesis:v1`) به Σ floor(اعتبارات) هر شهروند؛
  memo همان تراکنش = ردیف تعدیل شفاف گپ −۶۳ Đ (۹×۵۰ خرید بدون ردیف tx = −۴۵۰ + اعتبار دستی مالک +۳۸۷)؛
  ۳۰ محصول → مدل Product؛ اجرای دوباره هرگز دو برابر ضرب نمی‌کند (بازپخش امن)
- `back/server/scripts/genesis-proof.ts`: ممیزی خارجی با SQL خام (بدون Prisma/دامنه) —
  `PROOF OK: Σ کیف‌ها ۱۸۷٬۶۷۲ Đ · Σ پستینگ‌ها 0 · mint منفی/burn مثبت`
- سرویس واحد Railway: `scripts/single-service.ts` — یک پروسه = Fastify + grammY + sweep؛
  webhook روی `/api/v1/bot/webhook` (آداپتور std/http گرام‌وای)؛ Dockerfile چندمرحله‌ای +
  `railway.json` با healthcheck + `.env.example` خالی + `docs/DEPLOY.md`
- `scripts/package-v3.sh` — همان آیین QC بسته‌ی v1.5.0: درخت تمیز، git fsck، ۱۸۷ تست سبز،
  هم‌نسخه‌ی بودن ۸ پکیج، گارد اسرار → `DropAgentX-v3-0.6.0.zip` + SHA256 + HANDOFF
- **پذیرش (محقق شد)**: بعد از مهاجرت Σ کیف‌های کاربران = **۱۸۷٬۶۷۲ Đ** و `trialBalance.balanced === true`؛
  ممیزی خارجی روی دیتابیس جدید همان عدد را می‌دهد؛ خروجی ۰.۶.۰ بسته‌بندی و QC شد.
