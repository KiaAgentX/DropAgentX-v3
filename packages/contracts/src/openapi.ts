/**
 * OpenAPI 3.1 generation from zod contracts (ADR-005).
 *
 * zod v4 natively converts schemas to JSON Schema (2020-12) which is exactly
 * what OpenAPI 3.1 consumes — no third-party bridge, no drift, one source of truth.
 */

import { z } from 'zod';

export type HttpMethod = 'get' | 'post';
export type Security = 'admin' | 'public';

export interface ApiRouteDef {
  method: HttpMethod;
  /** OpenAPI-style path with {placeholders}: /escrows/{id}/fund */
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  security: Security;
  /** path parameters as a zod object — each key becomes a path parameter */
  params?: z.ZodObject;
  /** optional query parameters as a zod object (documented as not-required) */
  query?: z.ZodObject;
  body?: z.ZodType;
  response: z.ZodType;
  status?: number;
}

export interface OpenApiInfo {
  title: string;
  version: string;
  description: string;
}

/** Convert /escrows/{id}/fund → /escrows/:id/fund (Fastify style). */
export function toFastifyPath(path: string): string {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  return z.toJSONSchema(schema, { io }) as unknown as Record<string, unknown>;
}

export function buildOpenApiDoc(routes: readonly ApiRouteDef[], info: OpenApiInfo): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const parameters: unknown[] = [];
    if (route.params !== undefined) {
      for (const [name, field] of Object.entries(route.params.shape)) {
        parameters.push({
          name,
          in: 'path',
          required: true,
          schema: jsonSchema(field as z.ZodType, 'input'),
        });
      }
    }
    if (route.query !== undefined) {
      for (const [name, field] of Object.entries(route.query.shape)) {
        parameters.push({
          name,
          in: 'query',
          required: false,
          schema: jsonSchema(field as z.ZodType, 'input'),
        });
      }
    }

    const responses: Record<string, unknown> = {
      [String(route.status ?? 200)]: {
        description: 'Success',
        content: { 'application/json': { schema: jsonSchema(route.response, 'output') } },
      },
      ['4XX']: {
        description: 'Domain or validation failure',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                error: {
                  type: 'object',
                  properties: {
                    code: { type: 'string' },
                    message: { type: 'string' },
                    meta: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
                  },
                  required: ['code', 'message'],
                },
              },
              required: ['error'],
            },
          },
        },
      },
    };

    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      tags: [route.tag],
      responses,
    };
    if (parameters.length > 0) operation.parameters = parameters;
    if (route.body !== undefined) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: jsonSchema(route.body, 'input') } },
      };
    }
    if (route.security === 'admin') {
      operation.security = [{ kiaAdminKey: [] }];
    }

    paths[route.path] ??= {};
    paths[route.path]![route.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: { ...info },
    servers: [{ url: '/api/v1' }],
    tags: [...new Set(routes.map((r) => r.tag))].map((t) => ({ name: t })),
    components: {
      securitySchemes: {
        kiaAdminKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-KIA-Key',
          description: 'Fail-closed admin key (KIA_ADMIN_KEY). Missing key on the server disables admin endpoints entirely.',
        },
      },
    },
    paths,
  };
}
