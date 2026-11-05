/**
 * Test bootstrap — a throwaway SQLite file per run, server schema pushed once.
 * The bot tests boot a REAL v3 server on an ephemeral port and talk HTTP.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '..', 'server');
const tmp = mkdtempSync(path.join(tmpdir(), 'v3-bot-test-'));
process.env.DATABASE_URL ??= `file:${path.join(tmp, 'v3-bot-test.db')}`;

execSync('pnpm exec prisma db push --skip-generate', {
  cwd: serverDir,
  env: process.env,
  stdio: 'pipe',
});
