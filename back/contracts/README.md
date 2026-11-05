# @dropagentx/contracts — فاز ۲ ✅

تک‌منبع حقیقتِ قراردادهای سیم (ADR-005): اسکیماهای zod + سازنده‌ی OpenAPI 3.1.

- `common.ts` — پول صحیح روی سیم (`DNX`)، id، idempotencyKey، خطای استاندارد، وضعیت‌های اسکرو
- `accounts.ts` / `wallet.ts` / `escrows.ts` / `economy.ts` / `system.ts` — قرارداد هر endpoint
- `openapi.ts` — `buildOpenApiDoc(routes)` با `z.toJSONSchema` بومی zod v4 (بدون پل شخص ثالث)

قانون: سرور با همین اسکیماها validate می‌کند، داشبورد با همین‌ها type می‌گیرد، داکیومنت از همین‌ها تولید می‌شود — امکان drift صفر.
