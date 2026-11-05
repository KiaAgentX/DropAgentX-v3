# DropAgentX v3 — Unified Core

> هسته‌ی یکپارچه‌ی امپراتوری: بدنه‌ی DropAgentX + مغز Zenovix + دست‌های Hermit + چسب KIA-OS —
> این بار با معماری دامنه‌محور (Domain-First) و شش‌ضلعی (Hexagonal)، از روز اول.

**English**: DropAgentX v3 is the domain-first rewrite that merges the strengths of
HermesA (rich domain, dual-language UX, skill registry) and DropAgentX v2 (typed
contracts, security pipeline, release discipline) into one flawless core.
Money is integer. The ledger is double-entry and immutable. Escrow is an explicit
state machine. Everything is fail-closed.

## وضعیت فازها (Phase status)

| فاز | محتوا | وضعیت |
|---|---|---|
| ۰ | اسکلت monorepo (pnpm + turbo + TS strict + CI) | ✅ |
| ۱ | `packages/domain` — Money صحیح، دفتر دوطرفه، اسکرو، منشور پولی — **۴۰ تست سبز** | ✅ |
| ۲ | `apps/server` + `packages/contracts` + `packages/llm` — Fastify v5، ۱۷ endpoint، OpenAPI 3.1، امنیت fail-closed، کلاینت LLM سازگار با OpenAI — **۸۴ تست سبز** | ✅ |
| ۳ | `apps/bot` — grammY + Orchestrator + HITL | ⏭ بعدی |
| ۴ | `apps/dashboard` — Aurora UI + RTL + fa/en | ⏳ |
| ۵ | `packages/ai-gateway` — multi-provider + ۶ ایجنت + ۱۶ مهارت | ⏳ |
| ۶ | مهاجرت لجسی (۴۶۶ کاربر / ۱٬۵۵۴ تراکنش / عرضه ۱۸۷٬۶۷۲ Đ) + انتشار روی Railway | ⏳ |

جزئیات پذیرش هر فاز: [`docs/ROADMAP.md`](docs/ROADMAP.md)

## تصمیم‌های قفل‌شده (با مالک پروژه)

1. شروع از اسکلت + هسته‌ی دامنه — نه ربات، نه UI.
2. بک‌اند: **TypeScript strict + Fastify + Prisma**.
3. دیتابیس: **SQLite** با Prisma (schema قابل‌انتقال به PostgreSQL).
4. اسکوپ MVP: **کیف پول Đ + مارکت‌پلیس escrow + چرخه AI + پارلمان** — هر چهار ماژول.
5. داده لجسی: **مهاجرت از روز اول** — گپ −۶۳ Đ به‌صورت ردیف تعدیل شفاف.
6. دیپلوی: **Railway** (سرویس واحد: server + bot در یک process، مثل DNA v2).
7. زبان: **fa/en** دوزبانه از روز اول.
8. قرارداد: **zod → OpenAPI + کلاینت تایپ‌دار** (`createV3Client` — پاسخ‌ها با همان اسکیمای zod).
9. خانه‌ی کد: **ریپوی جدید monorepo** — v2 دست‌نخورده.
10. تحویل: هر فاز **کد واقعی + دموی زنده**.
11. لایه‌ی مدل: **فقط API سازگار با OpenAI** (ADR-006) — سه متغیر محیطی
    `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `MODEL`؛ همه با هم یا هیچ‌کدام، بدون SDK شخص ثالث.

## شروع سریع

```bash
pnpm install
pnpm -F @dropagentx/domain test   # 40/40 سبز
pnpm typecheck                     # strict, بدون خطا
```

## ساختار

```
v3-core/
├── apps/
│   ├── server/        ← ✅ فاز ۲: Fastify v5 + Prisma + ۱۷ endpoint + OpenAPI + امنیت
│   ├── bot/           ← فاز ۳: grammY + Orchestrator + HITL
│   └── dashboard/     ← فاز ۴: Aurora UI (fa/en, RTL)
├── packages/
│   ├── domain/        ← ✅ فاز ۱: هسته‌ی خالص (صفر وابستگی runtime)
│   ├── contracts/     ← ✅ فاز ۲: قراردادهای zod + OpenAPI 3.1 + کلاینت تایپ‌دار
│   └── llm/           ← ✅ فاز ۲: کلاینت LLM سازگار با OpenAI (ADR-006)
└── docs/
    ├── ROADMAP.md
    ├── ARCHITECTURE.md
    ├── PRODUCT-THESIS.md
    └── adr/           ← ADR-001…006
```

## قانون‌های مقدس (non-negotiable)

- پول همیشه **عدد صحیح** است — هیچ float ای وارد دامنه نمی‌شود.
- دفتر **دوطرفه و تغییرناپذیر** است — Σ همه‌ی تراز‌ها همیشه صفر.
- اسکرو یک **ماشین حالت صریح** است — خرید مارکت فقط از مسیر اسکرو.
- عملیات ≥ ۵۰٬۰۰۰ Đ نیازمند **تایید انسانی (HITL)** است.
- خطاها **Result** برمی‌گردانند — هیچ exception از مرز دامنه عبور نمی‌کند.
- اسرار (secrets) هرگز وارد git نمی‌شوند؛ `.env` خالی توزیع می‌شود.

## تز محصول (Market gap)

چرا این موتور قابل فروش است؟ → [`docs/PRODUCT-THESIS.md`](docs/PRODUCT-THESIS.md)

---

MIT © KiaAgentX — «از صفر و یک، تا حکومت.»
