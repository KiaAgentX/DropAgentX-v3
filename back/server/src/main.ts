/**
 * Executable entrypoint — `pnpm -F @dropagentx/server start`
 */

import { loadConfig } from './config.js';
import { buildApp } from './index.js';

const config = loadConfig();
const { app } = await buildApp(config);
await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`DropAgentX v3 server listening on :${config.port}`);
console.log(`DropAgentX v3 server listening on :${config.port} — docs at /api/v1/docs`);
