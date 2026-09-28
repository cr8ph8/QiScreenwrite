import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('CLI initializes and reads a private workspace from a checkout with spaces and Unicode', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-cli-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const checkout = path.join(scratch, 'Writer Studio café');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  for (const dir of ['local/server', 'local/contracts', 'shared/creative-services']) fs.cpSync(path.join(root, dir), path.join(checkout, dir), { recursive: true });
  const run = command => JSON.parse(execFileSync(process.execPath, ['local/server/cli.mjs', command, '--data', path.join(scratch, 'Private writing')], { cwd: checkout, encoding: 'utf8' }));
  assert.equal(run('init').initialized, true);
  assert.equal(run('status').drafts, 0);
});
