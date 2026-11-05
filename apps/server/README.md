# apps/server — فاز ۲

سرور Fastify + Prisma. این فایل placeholder است — در فاز ۲ پر می‌شود.

**خواهد داشت**:
- `/api/v1/*` تولیدشده از قراردادهای `packages/contracts` (zod → OpenAPI)
- Prisma روی SQLite (`db/v3.db`)، schema قابل‌انتقال به PostgreSQL
- لایه‌ی امنیت: Telegram initData + `X-KIA-Key` ادمین + rate limit + audit log
- Outbox برای `DomainEvent` های هسته
- اجرای مشترک با bot در یک process برای Railway (DNA یک‌سرویسی v2)

معیار پذیرش: `docs/ROADMAP.md` → فاز ۲.
