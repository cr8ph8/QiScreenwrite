import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('The native desktop bundle requires macOS and Xcode command-line tools.');
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qiscreenwrite-swift-'));
const options = ['build', '-c', 'release', '--package-path', path.join(root, 'desktop'), '--scratch-path', scratch];
try {
  execFileSync('swift', options, { cwd: root, stdio: 'inherit' });
  const bin = execFileSync('swift', [...options, '--show-bin-path'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync(process.execPath, ['scripts/package-desktop.mjs', path.join(bin, 'QiCanIScreenwrite')], { cwd: root, stdio: 'inherit' });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
