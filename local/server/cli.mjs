#!/usr/bin/env node
// CanIScreenwrite local writer CLI.
//
//   node local/server/cli.mjs init  [--data DIR] [--title "My screenplays"]
//   node local/server/cli.mjs serve [--data DIR] [--port 4318] [--dist dist-local] [--open]
//   node local/server/cli.mjs status [--data DIR]
//   node local/server/cli.mjs backup --data DIR --out FILE
//   node local/server/cli.mjs restore --data NEW_DIR --file FILE
//   node local/server/cli.mjs verify-preservation --file FILE
//
// `--data` defaults to .local-writer in the current directory. The owner token
// lives in DIR/config.json (mode 0600) and is never printed. `serve --open`
// mints a one-time, two-minute login link and opens it in the default browser.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, loadConfig, check, WorkspaceStore } from './storage.mjs';
import { startServer } from './http.mjs';
import { backupWorkspace, restoreWorkspace } from './backup.mjs';
import { PRESERVATION_PACKAGE_SCHEMA, readPreservationFile, verifyPreservationPackage } from './preservation.mjs';

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    check(/^--[a-z][a-z0-9-]*$/.test(arg), 'EXPECTED_NAMED_ARGUMENT', 400, `Unexpected argument: ${arg}`);
    if (['--open', '--print-login-link'].includes(arg)) { options[arg] = true; continue; }
    check(rest[index + 1] !== undefined && (arg === '--title' || !rest[index + 1].startsWith('--')), 'EXPECTED_ARGUMENT_VALUE', 400, `${arg} needs a value`);
    options[arg] = rest[++index];
  }
  return { command, options };
}

function openInBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

export async function main(argv) {
  const { command, options } = parse(argv);
  if (command === 'verify-preservation') {
    check(typeof options['--file'] === 'string' && options['--file'].length > 0, 'PRESERVATION_FILE_REQUIRED');
    return verifyPreservationPackage(readPreservationFile(path.resolve(options['--file'])));
  }
  const directory = path.resolve(options['--data'] ?? '.local-writer');
  if (command === 'backup') {
    check(typeof options['--out'] === 'string' && options['--out'].length > 0, 'BACKUP_OUTPUT_REQUIRED');
    return backupWorkspace(directory, options['--out']);
  }
  if (command === 'restore') {
    check(typeof options['--data'] === 'string' && options['--data'].length > 0 && typeof options['--file'] === 'string' && options['--file'].length > 0, 'RESTORE_ARGUMENTS_REQUIRED');
    const value = readPreservationFile(path.resolve(options['--file']), { allowLegacyBackup: true });
    return restoreWorkspace(directory, value.schema === PRESERVATION_PACKAGE_SCHEMA || value.schema === 'caniscreenwrite-preservation-package/v1' ? value.backup : value);
  }
  if (command === 'init') {
    initialize(directory, { title: options['--title'] ?? 'My screenplays' });
    return { initialized: true, directory, config: path.join(directory, 'config.json'), instruction: 'The owner token is in config.json (mode 0600). Start with `serve --open`, or read the token privately and enter it in the app. Never paste it into a URL.' };
  }
  if (command === 'status') {
    loadConfig(directory);
    const store = new WorkspaceStore(directory);
    try {
      const drafts = store.list('screenplay-draft');
      return { directory, project: store.project(), drafts: drafts.length, links: store.list('sync-link').length, latestDraft: drafts.map(d => ({ id: d.id, version: d.version, title: d.data.title })).slice(0, 5) };
    } finally { store.close(); }
  }
  if (command === 'serve') {
    if (!fs.existsSync(path.join(directory, 'config.json'))) initialize(directory);
    const port = Number(options['--port'] ?? 4318);
    check(Number.isInteger(port) && port >= 0 && port <= 65535, 'INVALID_PORT');
    const loginNonce = options['--open'] || options['--print-login-link'] ? crypto.randomBytes(32).toString('hex') : null;
    const server = await startServer({ directory, port, dist: path.resolve(options['--dist'] ?? 'dist-local'), loginNonce });
    const output = { origin: server.origin, mode: 'LOCAL_OWNER', directory, config: path.join(directory, 'config.json') };
    if (loginNonce) output.loginUrl = server.loginUrl;
    console.log(JSON.stringify(output));
    if (options['--open']) openInBrowser(server.loginUrl);
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await server.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return null;
  }
  check(false, 'UNKNOWN_COMMAND', 400, `Unknown command: ${command ?? '(none)'}. Use init, serve, status, backup, restore or verify-preservation.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => { if (result) console.log(JSON.stringify(result, null, 2)); }).catch(error => {
    console.error(JSON.stringify({ error: error.code ?? 'FAILED', detail: error.message }));
    process.exit(1);
  });
}
