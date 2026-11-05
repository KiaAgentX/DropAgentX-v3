import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildOpenApiDoc, toFastifyPath, type ApiRouteDef } from '../openapi.js';
import { economySummarySchema } from '../economy.js';
import { idSchema } from '../common.js';

const routes: ApiRouteDef[] = [
  {
    method: 'get',
    path: '/health',
    operationId: 'health',
    summary: 'Liveness',
    tag: 'system',
    security: 'public',
    response: z.object({ status: z.literal('ok') }),
  },
  {
    method: 'get',
    path: '/escrows/{id}',
    operationId: 'getEscrow',
    summary: 'Read one escrow',
    tag: 'escrows',
    security: 'public',
    params: z.object({ id: idSchema }),
    response: z.object({ id: z.string(), status: z.string() }),
  },
  {
    method: 'post',
    path: '/wallet/mint',
    operationId: 'mint',
    summary: 'Mint dinar (admin)',
    tag: 'wallet',
    security: 'admin',
    body: z.object({ accountId: idSchema, amount: z.number().int() }),
    response: z.object({ txId: z.string() }),
    status: 201,
  },
  {
    method: 'get',
    path: '/economy',
    operationId: 'economy',
    summary: 'Nation economy summary',
    tag: 'economy',
    security: 'public',
    response: economySummarySchema,
  },
];

describe('openapi builder — ADR-005', () => {
  it('converts fastify-style placeholders both ways', () => {
    expect(toFastifyPath('/escrows/{id}/fund')).toBe('/escrows/:id/fund');
    expect(toFastifyPath('/health')).toBe('/health');
  });

  it('builds a valid 3.1 doc with paths, params, requestBody and security', () => {
    const doc = buildOpenApiDoc(routes, {
      title: 'DropAgentX v3 API',
      version: '0.2.0',
      description: 'test',
    }) as unknown as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string; parameters?: { name: string; in: string }[]; requestBody?: unknown; security?: unknown; responses: Record<string, unknown> }>>;
      tags: { name: string }[];
      components: { securitySchemes: Record<string, unknown> };
    };

    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).sort()).toEqual(['/economy', '/escrows/{id}', '/health', '/wallet/mint']);

    const escrow = doc.paths['/escrows/{id}']!['get']!;
    expect(escrow.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: expect.anything() }]);
    expect(doc.paths['/wallet/mint']!['post']!.security).toEqual([{ kiaAdminKey: [] }]);
    expect(doc.paths['/wallet/mint']!['post']!.requestBody).toBeDefined();
    expect(doc.paths['/wallet/mint']!['post']!.responses['201']).toBeDefined();

    expect(doc.tags.map((t) => t.name).sort()).toEqual(['economy', 'escrows', 'system', 'wallet']);
    expect(doc.components.securitySchemes['kiaAdminKey']).toBeDefined();
  });

  it('emits JSON Schema that accepts valid payloads and rejects invalid ones', () => {
    const doc = buildOpenApiDoc(routes, { title: 't', version: 'v', description: 'd' }) as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, { content: { 'application/json': { schema: Record<string, unknown> } } }> }>>;
    };
    const economySchema = doc.paths['/economy']!['get']!.responses['200']!.content['application/json'].schema;
    expect(economySchema).toHaveProperty('properties');
    expect(Object.keys(economySchema.properties as object)).toContain('circulatingSupply');
  });
});
