/**
 * Unit — the dashboard API wrapper: header injection, error-key mapping,
 * and banner adaptation. Transport is a stub FetchLike — the REAL server
 * round-trip lives in roundtrip.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { createV3Client, type FetchLike } from '@dropagentx/contracts';
import { bannerError, createDashboardClient, errorKey, isAuthError, isMappedErrorCode } from '../src/lib/api.js';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createDashboardClient', () => {
  it('injects the admin key as the X-KIA-Key header on every call', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return jsonRes(200, { items: [] });
    };
    const client = createDashboardClient({ baseUrl: 'http://t/api/v1', adminKey: 'kia-secret-123', fetchImpl });
    await client.listAccounts();
    expect(seen[0]!['x-kia-key']).toBe('kia-secret-123');
  });

  it('sends no admin header for guest sessions', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return jsonRes(200, { items: [] });
    };
    const client = createDashboardClient({ baseUrl: 'http://t/api/v1', adminKey: null, fetchImpl });
    await client.economy();
    expect(seen[0]!['x-kia-key']).toBeUndefined();
  });
});

describe('error mapping', () => {
  it('maps known wire codes to dedicated i18n keys', () => {
    expect(errorKey({ code: 'ACCOUNT_OVERDRAFT', message: 'x' })).toBe('err.ACCOUNT_OVERDRAFT');
    expect(errorKey({ code: 'REQUIRES_HUMAN_APPROVAL', message: 'x' })).toBe('err.REQUIRES_HUMAN_APPROVAL');
    expect(errorKey({ code: 'INVALID_ADMIN_KEY', message: 'x' })).toBe('err.INVALID_ADMIN_KEY');
  });
  it('falls back to err.GENERIC for unknown (additive) codes', () => {
    expect(errorKey({ code: 'SOME_FUTURE_CODE', message: 'x' })).toBe('err.GENERIC');
    expect(isMappedErrorCode('SOME_FUTURE_CODE')).toBe(false);
    expect(isMappedErrorCode('MINT_CAP_EXCEEDED')).toBe(true);
  });
  it('flags auth codes for the gate', () => {
    expect(isAuthError({ code: 'ADMIN_KEY_REQUIRED', message: 'x' })).toBe(true);
    expect(isAuthError({ code: 'ACCOUNT_OVERDRAFT', message: 'x' })).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
  it('bannerError produces a real Error carrying the code', () => {
    const e = bannerError({ code: 'UNKNOWN_ACCOUNT', message: 'nope' });
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('nope');
    expect(e.code).toBe('UNKNOWN_ACCOUNT');
  });
});

describe('client surfaces wire errors as Results', () => {
  it('a 401 comes back ok:false with the exact code — never a throw', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonRes(401, { error: { code: 'ADMIN_KEY_REQUIRED', message: 'Send the admin key in the X-KIA-Key header.' } });
    const client = createV3Client({ baseUrl: 'http://t/api/v1', fetchImpl });
    const res = await client.listAccounts();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('ADMIN_KEY_REQUIRED');
      expect(res.error.status).toBe(401);
    }
  });
});
