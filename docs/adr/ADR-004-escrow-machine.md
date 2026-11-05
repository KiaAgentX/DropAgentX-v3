# ADR-004 — اسکرو به‌عنوان ماشین حالت صریح

- **وضعیت**: پذیرفته‌شده
- **تاریخ**: ۱۴۰۵ آبان

## زمینه
در v2 خرید escrow-دار بود ولی وضعیت‌ها ضمنی (فیلد status بدون جدول گذار) بود؛ گذارهای نامعتبر
فقط با شرط‌های پراکنده در کد کنترل می‌شد و TTL رسمی نداشت.

## تصمیم
هشت وضعیت صریح و جدول گذار ماشین‌خوان:

```
CREATED → FUNDED → DELIVERED → RELEASED          (مسیر خوش‌خیم)
                  ↘ DISPUTED → REFUNDED | RELEASED (داوری)
CREATED → CANCELLED                              (پولی جابه‌جا نشده)
FUNDED  → EXPIRED                                (TTL منقضی → بازگشت خودکار)
```

هر گذار در همان لحظه روی دفتر (ADR-003) ثبت می‌شود:
fund: buyer→escrow · release: escrow→seller+treasury(۱۰٪) · refund: escrow→buyer (بدون مالیات).
ماده‌ی ۷ منشور: release مبلغ ≥ ۵۰٬۰۰۰ Đ بدون `approvedByAdmin` رد می‌شود (HITL).

## پیامدها
- ✅ جدول گذار مستقیماً به UI (داشبورد فاز ۴) قابل ارائه است.
- ✅ TTL sweep در فاز ۳ (cron ربات) فقط `findExpired` را صدا می‌زند.
- ❌ مسیر DISPUTED→RELEASED داوری انسانی می‌خواهد — در MVP با HITL حل می‌شود.
