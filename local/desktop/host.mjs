import fs from 'node:fs';
import path from 'node:path';
import { initialize } from '../server/storage.mjs';
import { startServer } from '../server/http.mjs';
const args = process.argv.slice(2), options = {};
if (args.length !== 6) throw new Error('INVALID_DESKTOP_ARGUMENTS');
for (let i = 0; i < args.length; i += 2) {
  if (!['--data', '--dist', '--port'].includes(args[i]) || options[args[i]]) throw new Error('INVALID_DESKTOP_ARGUMENTS');
  options[args[i]] = args[i + 1];
}
const port = Number(options['--port']);
if (!path.isAbsolute(options['--data']) || !path.isAbsolute(options['--dist']) || !/^(0|[1-9][0-9]{0,4})$/.test(options['--port']) || port > 65535) throw new Error('INVALID_DESKTOP_ARGUMENTS');
if (!fs.existsSync(path.join(options['--dist'], 'local.html'))) throw new Error('LOCAL_APP_NOT_BUILT');
const directory = options['--data'];
// Never initialize over unrelated existing files or a partially missing database.
if (!fs.existsSync(directory)) initialize(directory);
else if (!fs.existsSync(path.join(directory, 'config.json')) || !fs.existsSync(path.join(directory, 'workspace.sqlite'))) throw new Error('WORKSPACE_INCOMPLETE');
let server, requested = false;
async function stop() {
  if (requested) return;
  requested = true;
  if (server) { await server.close(); process.exit(0); }
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
process.stdin.once('end', stop); process.stdin.once('close', stop); process.stdin.resume();
try {
  server = await startServer({ directory, dist: options['--dist'], port });
  if (requested) { await server.close(); process.exit(0); }
  process.stdout.write(JSON.stringify({ type: 'ready', origin: server.origin, pid: process.pid }) + '\n');
} catch (error) { process.stderr.write(JSON.stringify({ error: error.code ?? 'DESKTOP_START_FAILED' }) + '\n'); process.exit(1); }
