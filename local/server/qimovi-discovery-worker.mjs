// Inspect only the explicitly known current QiMovi selection, never a home scan.
// This module is forked by qimovi-discovery.mjs, never run on the HTTP event loop.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { check, ID, SHA, sha256 } from './storage.mjs';

const DOMAIN = 'com.hampton.qimovieslate.local';
const HOST = '/Applications/QiMovi.app/Contents/Resources/runtime/local/desktop/host.mjs';
const NODE = '/Applications/QiMovi.app/Contents/Resources/node';
function regular(filename, privateMode = false, max = 65536) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.uid === process.getuid() && (!privateMode || !(stat.mode & 0o077)) && stat.size > 0 && stat.size <= max, 'QIMOVI_DISCOVERY_FILE_INVALID', 409);
    const bytes = fs.readFileSync(fd);
    check(bytes.length <= max, 'QIMOVI_DISCOVERY_FILE_INVALID', 409);
    return bytes;
  } finally { fs.closeSync(fd); }
}
const command = (file, args) => {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    check(error.code !== 'ETIMEDOUT', 'QIMOVI_DISCOVERY_TIMEOUT', 504);
    throw error;
  }
};
let sequence = 0;
const pending = new Map();
const injectedCommand = (file, args) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  process.send({ type: 'command', id, file, args });
});

async function inspect({ workspace, preferences, injectedRun, host = HOST, node = NODE }) {
  const run = injectedRun ? injectedCommand : command;
  if (workspace === undefined) {
    if (preferences !== undefined) {
      regular(preferences, false, 1024 * 1024);
      // Explicit fixture path only: preserve isolated preference injection.
      workspace = await run('/usr/bin/plutil', ['-extract', 'workspacePath', 'raw', '-o', '-', preferences]);
    } else {
      // Ask the supported preferences service for this one key. Directly
      // opening another app's plist can block on macOS privacy mediation.
      workspace = await run('/usr/bin/defaults', ['read', DOMAIN, 'workspacePath']);
    }
    check(typeof workspace === 'string', 'QIMOVI_WORKSPACE_INVALID', 409);
    workspace = workspace.replace(/\r?\n$/, '');
  }
  check(typeof workspace === 'string' && path.isAbsolute(workspace) && workspace !== '/' && !/[\x00-\x1f\x7f]/.test(workspace) && fs.realpathSync(workspace) === workspace && fs.lstatSync(workspace).isDirectory() && fs.lstatSync(workspace).uid === process.getuid(), 'QIMOVI_WORKSPACE_INVALID', 409);
  const candidateId = `qimovi-installed:${sha256(workspace).slice(0, 24)}`;
  const cfg = JSON.parse(regular(path.join(workspace, 'config.json'), true));
  check(cfg.schema_version === 'filmstack-local-config/v1' && cfg.ownerActorId === 'local-owner' && SHA.test(cfg.ownerToken), 'QIMOVI_CONFIG_INVALID', 409);
  const dbPath = path.join(workspace, 'workspace.sqlite');
  const stat = fs.lstatSync(dbPath);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'QIMOVI_WORKSPACE_INVALID', 409);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let project;
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key='project'").get();
    check(row && Buffer.byteLength(row.value) <= 2 * 1024 * 1024, 'QIMOVI_PROJECT_INVALID', 409);
    const p = JSON.parse(row.value);
    check(ID.test(p.id) && typeof p.title === 'string' && p.title.length <= 240 && typeof p.profile === 'string' && (p.sourceHash === null || SHA.test(p.sourceHash)), 'QIMOVI_PROJECT_INVALID', 409);
    project = { id: p.id, title: p.title, profile: p.profile, sourceHash: p.sourceHash, sourceStatus: String(p.sourceStatus ?? 'UNKNOWN') };
  } finally { db.close(); }
  let origin = null;
  try {
    const lock = JSON.parse(regular(path.join(workspace, 'process.lock'), true));
    check(Number.isSafeInteger(lock.pid) && lock.pid > 0, 'QIMOVI_PROCESS_INVALID', 409);
    const invocation = (await run('/bin/ps', ['-p', String(lock.pid), '-o', 'command='])).trim();
    check(invocation === `${node} ${host} --data ${workspace} --dist /Applications/QiMovi.app/Contents/Resources/runtime/dist-local --port 0`, 'QIMOVI_PROCESS_INVALID', 409);
    const sockets = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(lock.pid), '-iTCP', '-sTCP:LISTEN', '-Fn']);
    const ports = [...sockets.matchAll(/^n127\.0\.0\.1:(\d+)$/gm)].map(m => Number(m[1]));
    check(ports.length === 1 && ports[0] >= 1 && ports[0] <= 65535 && !/^n(?!127\.0\.0\.1:)/m.test(sockets), 'QIMOVI_PROCESS_INVALID', 409);
    origin = `http://127.0.0.1:${ports[0]}`;
  } catch (error) {
    if (error.code === 'QIMOVI_DISCOVERY_TIMEOUT') throw error;
    // An absent/stale lock or inaccessible process is not a connection.
  }
  return { candidateId, workspacePath: workspace, project, origin, running: Boolean(origin), ownerToken: cfg.ownerToken };
}

let started = false;
process.on('message', async message => {
  if (message?.type === 'command-result') {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      if (message.reason) entry.reject(Object.assign(new Error('Discovery command unavailable'), { code: message.reason }));
      else entry.resolve(message.output);
    }
  } else if (message?.type === 'inspect' && !started) {
    started = true;
    let result;
    try { result = { type: 'result', candidate: await inspect(message.options) }; }
    catch (error) { result = { type: 'result', reason: /^QIMOVI_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'QIMOVI_DISCOVERY_UNAVAILABLE' }; }
    // IPC carries the private token only to the bridge's parent process. No
    // stdout/stderr, command arguments, exception text, or browser response.
    process.send(result, () => { process.disconnect(); process.exit(0); });
  }
});
process.on('disconnect', () => process.exit(0));
