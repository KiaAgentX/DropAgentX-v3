/**
 * Identity mapping — one Telegram user maps to exactly one ledger account.
 * Deterministic, collision-free against reserved system prefixes
 * (mint:/treasury:/burn:/escrow: — those can never come from a tg id).
 */

export function accountIdForTelegram(telegramId: string): string {
  return `user:tg:${telegramId}`;
}

/** Extract the numeric Telegram id from an account id like user:tg:123. */
export function telegramIdFromAccount(accountId: string): string | null {
  const m = /^user:tg:(\d+)$/.exec(accountId);
  return m === null ? null : m[1] ?? null;
}

/**
 * Parse a seller reference typed by a user:
 *  - `123` (numeric)  → user:tg:123
 *  - `user:tg:123`    → as-is
 *  - `@username`      → null (Telegram does not expose id resolution to bots — honest MVP)
 */
export function resolveAccountRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('@')) return null;
  if (/^\d+$/.test(trimmed)) return `user:tg:${trimmed}`;
  if (/^[A-Za-z0-9:_.-]+$/.test(trimmed)) return trimmed;
  return null;
}
