/**
 * Typed client unit tests — a stub fetch emulates the v3 wire (success,
 * error envelope, garbage). The full round-trip against the real Fastify
 * app lives in apps/server tests (ADR-005 loop closed end-to-end).
 */

import { describe, expect, it, vi } from 'vitest';
import { createV3Client, type FetchLike } from '../client.js';

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const ADMIN = { 'x-kia-key': 'kia-admin-key-0123456789' };

describe('createV3Client — ADR-005 typed client', () => {
  it('sends typed JSON bodies with caller headers and parses typed responses', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse(200, { txId: 'tx_1', accountId: 'user:ali', balance: 500, replayed: false }),
    );
    const client = createV3Client({ baseUrl: 'https://api.test/api/v1/', headers: ADMIN, fetchImpl });

    const r = await client.mint({ accountId: 'user:ali', amount: 500, idempotencyKey: 'mint-ali-1' });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.balance).toBe(500);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? ['?', {}];
    expect(url).toBe('https://api.test/api/v1/wallet/mint');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-kia-key']).toBe('kia-admin-key-0123456789');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['idempotencyKey']).toBe('mint-ali-1');
  });

  it('maps the wire error envelope to a typed failure, verbatim code', async () => {
    const client = createV3Client({
      baseUrl: 'https://api.test/api/v1',
      headers: ADMIN,
      fetchImpl: async () => jsonResponse(422, { error: { code: 'ACCOUNT_OVERDRAFT', message: 'no funds', meta: { needed: 90 } } }),
    });
    const r = await client.mint({ accountId: 'user:x', amount: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ACCOUNT_OVERDRAFT');
      expect(r.error.status).toBe(422);
      expect(r.error.meta).toEqual({ needed: 90 });
    }
  });

  it('survives a non-JSON error body (gateway banners)', async () => {
    const client = createV3Client({
      baseUrl: 'https://api.test/api/v1',
      fetchImpl: async () => new Response('<html>502 gateway</html>', { status: 502 }),
    });
    const r = await client.health();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('MALFORMED_ERROR_BODY');
      expect(r.error.status).toBe(502);
    }
  });

  it('reports transport failures as NETWORK', async () => {
    const client = createV3Client({
      baseUrl: 'https://api.test/api/v1',
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
    });
    const r = await client.economy();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('NETWORK');
      expect(r.error.message).toContain('socket hang up');
    }
  });

  it('rejects 2xx bodies that violate the wire contract (RESPONSE_MISMATCH)', async () => {
    const client = createV3Client({
      baseUrl: 'https://api.test/api/v1',
      fetchImpl: async () => jsonResponse(200, { status: 'ok' /* service + version + llm fields missing */ }),
    });
    const r = await client.health();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESPONSE_MISMATCH');
  });

  it('URL-encodes path parameters while preserving the route shape', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { accountId: 'user:ali', balance: 7 }));
    const client = createV3Client({ baseUrl: 'https://api.test/api/v1', fetchImpl });
    const r = await client.balance('user:ali');
    expect(r.ok).toBe(true);
    const [url] = fetchImpl.mock.calls[0] ?? ['?'];
    expect(url).toBe('https://api.test/api/v1/accounts/user%3Aali/balance');
  });

  it('passes the escrow status query through', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { items: [] }));
    const client = createV3Client({ baseUrl: 'https://api.test/api/v1', fetchImpl });
    await client.listEscrows('FUNDED');
    const [url] = fetchImpl.mock.calls[0] ?? ['?'];
    expect(url).toBe('https://api.test/api/v1/escrows?status=FUNDED');
  });

  it('rejects an invalid status locally, without touching the network', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { items: [] }));
    const client = createV3Client({ baseUrl: 'https://api.test/api/v1', fetchImpl });
    // @ts-expect-error — deliberately wrong wire value
    const r = await client.listEscrows('FLOATING');
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
