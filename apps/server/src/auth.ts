/**
 * Authentication primitives (pure, unit-testable, no Fastify here).
 *
 * Fail-closed rules:
 *  - admin key check compares in constant time; a missing server-side key
 *    means admin is DISABLED, never open.
 *  - Telegram initData follows the official WebApp HMAC scheme.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function verifyKiaKey(headerValue: string | undefined, serverKey: string | undefined): boolean {
  if (serverKey === undefined || serverKey.length < 16) return false;
  if (headerValue === undefined || headerValue.length === 0) return false;
  const a = Buffer.from(headerValue, 'utf8');
  const b = Buffer.from(serverKey, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface TelegramIdentity {
  userId: string;
  username?: string;
}

/** Official Telegram WebApp initData verification (HMAC-SHA256). */
export function verifyTelegramInitData(initData: string, botToken: string): TelegramIdentity | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = createHash('sha256').update(botToken, 'utf8').digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString, 'utf8').digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;
  try {
    const user = JSON.parse(userRaw) as { id?: unknown; username?: unknown };
    if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id)) return null;
    return {
      userId: String(user.id),
      ...(typeof user.username === 'string' && user.username.length > 0 ? { username: user.username } : {}),
    };
  } catch {
    return null;
  }
}

export function makeTestInitData(botToken: string, user: { id: number; username?: string }): string {
  const params = new URLSearchParams({ user: JSON.stringify(user), auth_date: '1700000000' });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = createHash('sha256').update(botToken, 'utf8').digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString, 'utf8').digest('hex');
  return `${params.toString()}&hash=${hash}`;
}
