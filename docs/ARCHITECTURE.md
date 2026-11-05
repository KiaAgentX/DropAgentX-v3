# ARCHITECTURE — Hexagonal / Ports & Adapters

```
                        ┌─────────────────────────────────────────────┐
                        │                ADAPTERS (بیرون)             │
                        │  back/server (Fastify+Prisma)               │
                        │  back/bot (grammY)                          │
                        │  front/dashboard (Aurora UI)                 │
                        │  back/ai-gateway                        │
                        │  migrator (legacy DB)                       │
                        └───────────────┬─────────────────────────────┘
                                        │ ports (interface ها)
                        ┌───────────────▼─────────────────────────────┐
                        │              DOMAIN CORE (داخل)             │
                        │  money (Din integer)                        │
                        │  ledger (double-entry, immutable)           │
                        │  escrow (state machine)                     │
                        │  charter (policy پولی)                      │
                        │  events (DomainEvent)                       │
                        └─────────────────────────────────────────────┘
```

## قواعد وابستگی

1. دامنه **هیچ چیز بیرونی را import نمی‌کند** — نه Prisma، نه Fastify، نه Express، هیچ.
2. Adapter ها به دامنه وابسته‌اند، نه برعکس.
3. ارتباط با بیرون فقط از طریق Port ها؛ در فاز ۲ این Port ها به zod/OpenAPI قرارداد تبدیل می‌شوند.
4. رویدادهای دامنه (`DomainEvent`) خروجی استاندارد هر دستور هستند → Outbox در فاز ۲.

## چرا شش‌ضلعی؟ (درس‌های v2 و هرمس)

- v2 یک سرویس ۱۰٬۵۸۴ خطی داشت که منطق پول و HTTP و Telegram در هم تنیده بود → تست پول سخت.
- هرمس فایل‌های ۱۲۱KB داشت (`database.py`) → بازطراحی غیرممکن.
- در v3 منطق پول در ۷ فایل خالص با ۴۰ تست است — هر تغییر قرارداد، خطای کامپایل می‌دهد.

## جریان پول (قانون طلایی)

```
buyer ──fund──▶ escrow ──release──▶ seller (net = amount − tax)
                        └──────▶ treasury (tax = 10%)
        refund: escrow ──▶ buyer (کامل، بدون مالیات)
```

- هر جابه‌جایی = یک `Transaction` با مجموع صفر در `back/domain/src/ledger.ts`
- `mint:genesis` تنها منبع پول، `burn:void` تنها مقصد نابودی (ماده‌ی ۴ منشور)
- ادعاها با `trialBalance(state).balanced` و `circulatingSupply(state)` قابل اثبات‌اند.
