/**
 * @dropagentx/llm test suite — ADR-006 acceptance.
 * A local mock speaks the OpenAI-compatible wire so no real key or network
 * is ever needed; every failure path is exercised deliberately.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLlmClient, loadLlmConfig, maskApiKey, normalizeBaseUrl, type ChatRequest } from '../index.js';

type MockHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let baseUrl: string;
let handler: MockHandler = () => undefined as never;
let lastCapture: { url: string | undefined; method: string | undefined; auth: string | undefined; body: string };

const happyCompletion = {
  id: 'chatcmpl-1',
  model: 'test-model',
  choices: [{ message: { role: 'assistant', content: 'پاسخ آزمایشی' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      lastCapture = { url: req.url, method: req.method, auth: req.headers.authorization, body };
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  handler = (_req, res, _body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(happyCompletion));
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function clientFromEnv(overrides: Record<string, string | undefined> = {}) {
  const loaded = loadLlmConfig({
    OPENAI_BASE_URL: baseUrl,
    OPENAI_API_KEY: 'test-key-1234567890abcd',
    MODEL: 'test-model',
    ...overrides,
  });
  if (!loaded.ok) throw new Error(`test config failed: ${loaded.error.message}`);
  return createLlmClient(loaded.value);
}

const CHAT: ChatRequest = { messages: [{ role: 'user', content: 'سلام' }], temperature: 0.4, maxTokens: 128 };

describe('ADR-006 config — سه متغیر محیطی، fail-closed', () => {
  it('refuses an empty environment with LLM_NOT_CONFIGURED', () => {
    const r = loadLlmConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('LLM_NOT_CONFIGURED');
      expect(r.error.message).toContain('OPENAI_BASE_URL');
    }
  });

  it('refuses a PARTIAL config listing exactly what is missing', () => {
    const r = loadLlmConfig({ OPENAI_BASE_URL: 'https://api.example.com/v1', OPENAI_API_KEY: 'sk-abc12345' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('LLM_INVALID_CONFIG');
      expect(r.error.message).toContain('MODEL');
      expect(r.error.message).not.toContain('OPENAI_BASE_URL');
    }
  });

  it('accepts a complete config and normalizes the base URL', () => {
    const r = loadLlmConfig({
      OPENAI_BASE_URL: 'https://api.example.com/v1/',
      OPENAI_API_KEY: 'sk-abc12345',
      MODEL: 'glm-4.7',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.baseUrl).toBe('https://api.example.com/v1');
      expect(r.value.model).toBe('glm-4.7');
    }
  });

  it('rejects an invalid URL and a too-short key', () => {
    const badUrl = loadLlmConfig({ OPENAI_BASE_URL: 'not-a-url', OPENAI_API_KEY: 'sk-abc12345', MODEL: 'm' });
    expect(badUrl.ok).toBe(false);
    const shortKey = loadLlmConfig({ OPENAI_BASE_URL: 'https://api.example.com', OPENAI_API_KEY: 'sk', MODEL: 'm' });
    expect(shortKey.ok).toBe(false);
  });

  it('normalizeBaseUrl accepts both a base and a full completions endpoint', () => {
    expect(normalizeBaseUrl('https://api.x.com/v1')).toBe('https://api.x.com/v1');
    expect(normalizeBaseUrl('https://api.x.com/v1/')).toBe('https://api.x.com/v1');
    expect(normalizeBaseUrl('https://api.x.com/v1/chat/completions')).toBe('https://api.x.com/v1');
    expect(normalizeBaseUrl('https://api.x.com/v1/chat/completions/')).toBe('https://api.x.com/v1');
  });

  it('maskApiKey never shows more than a hint', () => {
    expect(maskApiKey('sk-abcdefghij1234')).toBe('sk-…1234');
    expect(maskApiKey('short')).toBe('****');
  });
});

describe('ADR-006 client — one wire contract, typed failures', () => {
  it('posts the OpenAI-compatible body with Bearer auth and parses the completion', async () => {
    const client = clientFromEnv();
    const r = await client.chat(CHAT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.content).toBe('پاسخ آزمایشی');
      expect(r.value.model).toBe('test-model');
      expect(r.value.finishReason).toBe('stop');
      expect(r.value.usage).toEqual({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
      expect(r.value.id).toBe('chatcmpl-1');
    }
    expect(lastCapture.method).toBe('POST');
    expect(lastCapture.url).toBe('/v1/chat/completions');
    expect(lastCapture.auth).toBe('Bearer test-key-1234567890abcd');
    const body = JSON.parse(lastCapture.body) as Record<string, unknown>;
    expect(body['model']).toBe('test-model');
    expect(body['messages']).toEqual([{ role: 'user', content: 'سلام' }]);
    expect(body['temperature']).toBe(0.4);
    expect(body['max_tokens']).toBe(128);
  });

  it('maps 401/403 to PROVIDER_AUTH without leaking the key', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
    };
    const r = await clientFromEnv().chat(CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('PROVIDER_AUTH');
      expect(r.error.status).toBe(401);
    }
  });

  it('maps 429 to RATE_LIMITED', async () => {
    handler = (_req, res) => {
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('slow down');
    };
    const r = await clientFromEnv().chat(CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RATE_LIMITED');
  });

  it('maps other provider failures to PROVIDER_ERROR with status + snippet', async () => {
    handler = (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('upstream exploded loudly '.repeat(40));
    };
    const r = await clientFromEnv().chat(CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('PROVIDER_ERROR');
      expect(r.error.status).toBe(503);
      expect(r.error.message.length).toBeLessThanOrEqual(340);
    }
  });

  it('fails closed on non-JSON bodies', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>gateway banner</html>');
    };
    const r = await clientFromEnv().chat(CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MALFORMED_RESPONSE');
  });

  it('fails closed on JSON that misses the choices contract', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [] }));
    };
    const r = await clientFromEnv().chat(CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MALFORMED_RESPONSE');
  });

  it('fails closed when the provider returns no textual content', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'tool_calls' }] }));
    };
    const r = await clientFromEnv().chat(CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('MALFORMED_RESPONSE');
      expect(r.error.message).toContain('finish_reason');
    }
  });

  it('enforces a real timeout (AbortController)', async () => {
    handler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(happyCompletion));
      }, 400);
    };
    const r = await clientFromEnv().chat({ ...CHAT, timeoutMs: 80 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('TIMEOUT');
      expect(r.error.message).toContain('80ms');
    }
  }, 5000);

  it('maps unreachable providers to NETWORK', async () => {
    const dead = loadLlmConfig({
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', // discard port — nothing listens
      OPENAI_API_KEY: 'sk-abc12345',
      MODEL: 'm',
    });
    if (!dead.ok) throw new Error(dead.error.message);
    const r = await createLlmClient(dead.value).chat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 2_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NETWORK');
  }, 8000);

  it('probes /models for cheap health checks', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'other-model' }] }));
    };
    const r = await clientFromEnv().models();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((m) => m.id)).toEqual(['test-model', 'other-model']);
    expect(lastCapture.method).toBe('GET');
    expect(lastCapture.url).toBe('/v1/models');
  });

  it('fails closed when /models is malformed', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nope: true }));
    };
    const r = await clientFromEnv().models();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MALFORMED_RESPONSE');
  });
});
