# @dropagentx/dashboard — فاز ۴

پنل ادمین DropAgentX v3: **Aurora UI** (دارک + شیشه‌ای + سه هاله)، **RTL پیش‌فرض** با fa/en، فونت **Vazirmatn** self-hosted.

## استک (ADR-007)

- **Vite 6 + React 19 + Tailwind v4** — SPA بدون SSR؛ hash routing بدون وابستگی router
- کلاینت = `createV3Client` تایپ‌دار از `@dropagentx/contracts` (ADR-005) + لایه‌ی نازک تزریق `X-KIA-Key`
- کلید مدیریت فقط در `sessionStorage` — با بستن تب پاک می‌شود
- i18n خودنویس: دو دیکشنری flat؛ برابری کلیدی fa/en در سطح تایپ و تست

## صفحات

| مسیر | دسترسی | محتوا |
| --- | --- | --- |
| `#/overview` | عمومی | شفافیت ماده‌ی ۶: عرضه، خزانه، قفل اسکرو، سقف ضرب (گیج)، سلامت سرور، وضعیت چرخه‌ی AI (ADR-006) |
| `#/accounts` | ادمین | حساب‌ها + ایجاد + ضرب/سوزاندن |
| `#/escrows` | ادمین | ماشین ۸ وضعیته: صافی، چرخه‌ی عمر با idempotency قطعی، ایجاد اسکرو |
| `#/hitl` | ادمین | صف ماده‌ی ۷: تأیید (تسویه‌ی اتمی ۹۰/۱۰)، رد، سوئیپ منقضی‌ها |
| `#/settings` | عمومی | نشست کلید، پیوند OpenAPI 3.1، مقادیر منشور |

## اجرا

```bash
# سرور (پورت 8787) — یک ترمینال
DATABASE_URL="file:./v3.db" KIA_ADMIN_KEY="change-me-16-chars-min" pnpm --filter @dropagentx/server dev

# داشبورد (پورت 5173، پراکسی /api → 8787) — ترمینال دیگر
pnpm --filter @dropagentx/dashboard dev
```

تولید: `pnpm --filter @dropagentx/dashboard build` → `dist/` (فاز ۶: سرو استاتیک توسط Fastify).

معیار پذیرش و نتایج: `docs/ROADMAP.md` → فاز ۴.
