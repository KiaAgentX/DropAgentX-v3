/**
 * Fastify guards — admin key (fail-closed) + in-memory sliding-window rate limit.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyKiaKey } from './auth.js';
import { HttpFailure } from './errors.js';
import type { Config } from './config.js';

export function requireAdmin(config: Config): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    if (config.adminKey === undefined) {
      // Fail-closed: an unconfigured server refuses admin actions with 503.
      void reply.code(503).send({
        error: { code: 'ADMIN_DISABLED', message: 'KIA_ADMIN_KEY is not configured on this server — admin endpoints are disabled.' },
      });
      return;
    }
    const header = req.headers['x-kia-key'];
    const value = Array.isArray(header) ? header[0] : header;
    if (value === undefined) {
      void reply.code(401).send({ error: { code: 'ADMIN_KEY_REQUIRED', message: 'Send the admin key in the X-KIA-Key header.' } });
      return;
    }
    if (!verifyKiaKey(value, config.adminKey)) {
      void reply.code(401).send({ error: { code: 'INVALID_ADMIN_KEY', message: 'Invalid admin key.' } });
      return;
    }
  };
}

const windows = new Map<string, number[]>();

export function resetRateLimiter(): void {
  windows.clear();
}

export function rateLimit(config: Config): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const windowMs = 60_000;
    const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= config.rateLimitPerMin) {
      void reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: `More than ${config.rateLimitPerMin} requests per minute.`, meta: { limit: config.rateLimitPerMin } },
      });
      return;
    }
    hits.push(now);
    windows.set(key, hits);
    if (windows.size > 10_000) windows.clear(); // crude memory guard
  };
}
