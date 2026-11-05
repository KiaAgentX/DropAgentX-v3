/**
 * DropAgentX v3 server — Fastify assembly (Phase 2).
 * The route registry is the single source of truth: validation, docs, handlers.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import * as C from '@dropagentx/contracts';
import { loadConfig, type Config } from './config.js';
import { V3Store } from './persistence.js';
import { API_ROUTES, type RouteContext } from './api.js';
import { requireAdmin, rateLimit } from './guards.js';
import { toHttpError, ValidationFailure } from './errors.js';

export const OPENAPI_INFO: C.OpenApiInfo = {
  title: 'DropAgentX v3 — Unified Core API',
  version: '0.2.0',
  description:
    'Admin service API over the pure domain core: integer money, immutable double-entry ledger, escrow state machine, 10-article monetary charter. Errors follow { error: { code, message } } — codes are additive.',
};

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly store: V3Store;
  readonly config: Config;
  readonly prisma: PrismaClient;
}

export async function buildApp(config: Config, prisma?: PrismaClient): Promise<BuiltApp> {
  const app = Fastify({ logger: false });
  const prismaClient = prisma ?? new PrismaClient();
  const store = new V3Store(prismaClient);
  await store.ensureSystemAccounts();

  const ctx: RouteContext = { store, config };

  // Meta endpoints (not part of the business registry).
  app.get('/api/v1/openapi.json', async () => C.buildOpenApiDoc(API_ROUTES, OPENAPI_INFO));
  app.get('/api/v1/docs', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<title>DropAgentX v3 API — OpenAPI</title>',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<style>body{margin:0;background:#0a0f14;color:#dbe4ee;font-family:system-ui,sans-serif}</style>',
      '</head><body>',
      '<redoc spec-url="/api/v1/openapi.json"></redoc>',
      '<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>',
      '<noscript>This page needs JavaScript. The raw spec lives at /api/v1/openapi.json</noscript>',
      '</body></html>',
    ].join('');
  });

  // Business endpoints — one loop, one source of truth.
  for (const route of API_ROUTES) {
    app.route({
      method: route.method.toUpperCase() as 'GET' | 'POST',
      url: `/api/v1${C.toFastifyPath(route.path)}`,
      preHandler: [
        rateLimit(config),
        ...(route.security === 'admin' ? [requireAdmin(config)] : []),
      ],
      handler: async (req, reply) => {
        try {
          let params: Record<string, string> = (req.params as Record<string, string>) ?? {};
          if (route.params !== undefined) {
            const parsed = route.params.safeParse(params);
            if (!parsed.success) throw validation(parsed.error.issues);
            params = parsed.data as Record<string, string>;
          }
          let query: Record<string, string> = (req.query as Record<string, string>) ?? {};
          if (route.query !== undefined) {
            const parsed = route.query.safeParse(query);
            if (!parsed.success) throw validation(parsed.error.issues);
            query = parsed.data as Record<string, string>;
          }
          let body: unknown = undefined;
          if (route.body !== undefined) {
            const parsed = route.body.safeParse(req.body);
            if (!parsed.success) throw validation(parsed.error.issues);
            body = parsed.data;
          }
          const data = await route.handler(ctx, { params, query, body });
          return await reply.code(route.status ?? 200).send(data);
        } catch (err) {
          const mapped = toHttpError(err);
          if (mapped !== null) return await reply.code(mapped.status).send(mapped.body);
          return await reply
            .code(500)
            .send({ error: { code: 'INTERNAL', message: 'Unexpected server error.' } });
        }
      },
    });
  }

  return { app, store, config, prisma: prismaClient };
}

function validation(issues: readonly { path: PropertyKey[]; message: string }[]): ValidationFailure {
  return new ValidationFailure(issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })));
}

export { loadConfig };
