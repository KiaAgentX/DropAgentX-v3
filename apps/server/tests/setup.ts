/**
 * Test bootstrap — a throwaway SQLite file per run, schema pushed once.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = mkdtempSync(path.join(tmpdir(), 'v3-test-'));
process.env.DATABASE_URL ??= `file:${path.join(tmp, 'v3-test.db')}`;

execSync('pnpm exec prisma db push --skip-generate', {
  cwd: serverDir,
  env: process.env,
  stdio: 'pipe',
});
