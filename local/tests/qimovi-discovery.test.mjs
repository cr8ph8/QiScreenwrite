import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { fork, execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createQiMoviDiscovery } from '../server/qimovi-discovery.mjs';
import { QiMoviBridge } from '../server/qimovi.mjs';
import { initialize, loadConnections } from '../server/storage.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qimovi-discovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preferences = path.join(root, 'known-preferences.plist'); fs.writeFileSync(preferences, 'test-plist', { mode: 0o600 });
  const ownerToken = crypto.randomBytes(32).toString('hex');
  const make = name => {
    const directory = path.join(root, name); fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ schema_version: 'filmstack-local-config/v1', ownerActorId: 'local-owner', ownerToken }), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'process.lock'), JSON.stringify({ pid: 1234 }), { mode: 0o600 });
    const db = new DatabaseSync(path.join(directory, 'workspace.sqlite'));
    const project = { id: `creative-project:${name}`, title: name, profile: 'caniscreenwrite-creative/v1', sourceHash: null, sourceStatus: 'NO_SCREENPLAY' };
    db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)'); db.prepare('INSERT INTO metadata VALUES(?,?)').run('project', JSON.stringify(project)); db.close();
    fs.chmodSync(path.join(directory, 'workspace.sqlite'), 0o600);
    return { directory, project };
  };
  const a = make('one'), b = make('two'); let selected = a, port = 54321, wrongProcess = false;
  const run = (file, args) => {
    if (file === '/usr/bin/plutil') { assert.equal(args.at(-1), preferences); assert.deepEqual(args.slice(0, 3), ['-extract', 'workspacePath', 'raw']); return selected.directory + '\n'; }
    if (file === '/bin/ps') return wrongProcess ? 'unrelated process' : `/Applications/QiMovi.app/Contents/Resources/node /Applications/QiMovi.app/Contents/Resources/runtime/local/desktop/host.mjs --data ${selected.directory} --dist /Applications/QiMovi.app/Contents/Resources/runtime/dist-local --port 0\n`;
    if (file === '/usr/sbin/lsof') return `p1234\nn127.0.0.1:${port}\n`;
    throw new Error('Unexpected process call');
  };
  return { root, a, b, ownerToken, run, discovery: createQiMoviDiscovery({ preferences, run }), select: value => { selected = value; }, port: value => { port = value; }, wrongProcess: () => { wrongProcess = true; } };
}

test('discovery follows only the native selection and privately binds project/port across restart', async t => {
  const f = fixture(t), directory = path.join(f.root, 'writer'); initialize(directory);
  const origins = [];
  const bridge = new QiMoviBridge(directory, { discovery: f.discovery, fetch: async (url, options) => {
    origins.push(new URL(url).origin);
    if (url.endsWith('/api/caniscreenwrite/session')) return Response.json({ authenticated: true, protocol: 'caniscreenwrite-bridge/v1' }, { headers: { 'Set-Cookie': 'caniscreenwrite_bridge=test-session; HttpOnly; Path=/' } });
    assert.equal(options.headers.Cookie, 'caniscreenwrite_bridge=test-session');
    return Response.json({ project: f.a.project, records: [] });
  } });
  const found = await bridge.discover();
  assert.deepEqual(found, { available: true, origin: 'http://127.0.0.1:54321', project: { id: f.a.project.id, title: 'one' }, directory: f.a.directory });
  assert.equal(JSON.stringify(found).includes(f.ownerToken), false);
  await assert.rejects(bridge.configureInstalled({ projectId: f.b.project.id }), { code: 'QIMOVI_PROJECT_CHANGED' });
  const status = await bridge.configureInstalled({ projectId: f.a.project.id });
  assert.equal(status.connected, false); assert.equal(status.project.id, f.a.project.id);
  const privateConfig = loadConnections(directory).qimovi;
  assert.equal(privateConfig.ownerToken, f.ownerToken);
  assert.equal(privateConfig.binding.project.id, f.a.project.id);
  assert.equal(fs.statSync(path.join(directory, 'connections.json')).mode & 0o077, 0);
  assert.equal(JSON.stringify(status).includes(f.ownerToken), false);
  await bridge.connect(); f.port(54322); await bridge.connect();
  assert.equal(bridge.status().origin, 'http://127.0.0.1:54322');
  assert.ok(origins.includes('http://127.0.0.1:54322'));
  f.select(f.b);
  await assert.rejects(bridge.connect(), { code: 'QIMOVI_SELECTION_CHANGED' });
  assert.equal((await bridge.discover()).project.id, f.b.project.id);
  await bridge.configureInstalled({ projectId: f.b.project.id });
  assert.equal(bridge.status().project.id, f.b.project.id);
});

test('discovery refuses mismatched processes and symlink/permissive credentials without leaking them', async t => {
  const f = fixture(t);
  f.wrongProcess();
  assert.equal((await f.discovery.discover()).candidates[0].running, false);
  const candidate = (await f.discovery.discover()).candidates[0];
  await assert.rejects(f.discovery.resolve({ candidateId: candidate.candidateId, expectedProjectId: candidate.project.id }), { code: 'QIMOVI_NOT_RUNNING' });
  const config = path.join(f.a.directory, 'config.json');
  fs.chmodSync(config, 0o644);
  assert.deepEqual(await f.discovery.discover(), { candidates: [], reason: 'QIMOVI_DISCOVERY_FILE_INVALID' });
  fs.chmodSync(config, 0o600); fs.renameSync(config, config + '.private'); fs.symlinkSync(config + '.private', config);
  const unavailable = await f.discovery.discover();
  assert.deepEqual(unavailable.candidates, []); assert.equal(JSON.stringify(unavailable).includes(f.ownerToken), false);
});

test('bridge request timeout aborts transport and reports no secret details', async t => {
  const f = fixture(t), directory = path.join(f.root, 'writer'); initialize(directory);
  let aborted = false;
  const bridge = new QiMoviBridge(directory, { timeoutMs: 15, fetch: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error(f.ownerToken)); }, { once: true });
  }) });
  bridge.configure({ origin: 'http://127.0.0.1:54321', ownerToken: f.ownerToken });
  await assert.rejects(bridge.connect(), error => error.code === 'QIMOVI_TIMEOUT' && !error.message.includes(f.ownerToken));
  assert.equal(aborted, true);
});

test('production preference selection uses only defaults; explicit workspace bypasses preference reads', async t => {
  const f = fixture(t), calls = [];
  const discovery = createQiMoviDiscovery({ run: (file, args) => {
    calls.push(file);
    if (file === '/usr/bin/defaults') {
      assert.deepEqual(args, ['read', 'com.hampton.qimovieslate.local', 'workspacePath']);
      return f.a.directory + '\n';
    }
    return f.run(file, args);
  } });
  const found = await discovery.discover();
  assert.equal(found.candidates[0].workspacePath, f.a.directory);
  assert.equal(found.candidates[0].running, true);
  assert.equal(JSON.stringify(found).includes(f.ownerToken), false);
  assert.deepEqual(calls, ['/usr/bin/defaults', '/bin/ps', '/usr/sbin/lsof']);
  const direct = createQiMoviDiscovery({ workspace: f.a.directory, run: f.run });
  assert.equal((await direct.discover()).candidates[0].project.id, f.a.project.id);
});

test('isolated discovery still rejects non-loopback, ambiguous ports, and workspace symlinks', async t => {
  const f = fixture(t);
  for (const sockets of ['p1234\nn*:54321\n', 'p1234\nn127.0.0.1:54321\nn[::1]:54321\n', 'p1234\nn127.0.0.1:54321\nn127.0.0.1:54322\n']) {
    const discovery = createQiMoviDiscovery({ workspace: f.a.directory, run: (file, args) => file === '/usr/sbin/lsof' ? sockets : f.run(file, args) });
    assert.equal((await discovery.discover()).candidates[0].running, false);
  }
  const link = path.join(f.root, 'workspace-link'); fs.symlinkSync(f.a.directory, link);
  const discovery = createQiMoviDiscovery({ workspace: link });
  assert.deepEqual(await discovery.discover(), { candidates: [], reason: 'QIMOVI_WORKSPACE_INVALID' });
});

test('blocked file open times out, coalesces concurrent requests, keeps HTTP responsive, and reaps helper', { timeout: 5000 }, async t => {
  const f = fixture(t), preferences = path.join(f.root, 'blocked-preferences');
  execFileSync('/usr/bin/mkfifo', [preferences]);
  const children = [], exits = [];
  const discovery = createQiMoviDiscovery({ preferences, timeoutMs: 400, fork: (...args) => {
    const child = fork(...args); children.push(child); exits.push(once(child, 'exit')); return child;
  } });
  t.after(() => children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }));
  const server = http.createServer((_request, response) => { response.writeHead(200); response.end('healthy'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const started = performance.now();
  const requests = Promise.all(Array.from({ length: 24 }, () => discovery.discover()));
  const resolution = assert.rejects(discovery.resolve({ candidateId: 'qimovi-installed:fixture', expectedProjectId: f.a.project.id }), { code: 'QIMOVI_DISCOVERY_TIMEOUT', status: 504 });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(await response.text(), 'healthy');
  assert.equal(children.length, 1);
  const results = await requests; await resolution;
  assert.ok(performance.now() - started < 2000);
  for (const result of results) assert.deepEqual(result, { candidates: [], reason: 'QIMOVI_DISCOVERY_TIMEOUT' });
  await exits[0];
  assert.equal(children[0].signalCode, 'SIGKILL');
  assert.throws(() => process.kill(children[0].pid, 0), { code: 'ESRCH' });
  fs.unlinkSync(preferences); // A subsequent retry is allowed after child exit.
  assert.deepEqual(await discovery.discover(), { candidates: [], reason: 'QIMOVI_DISCOVERY_UNAVAILABLE' });
  assert.equal(children.length, 2);
  await exits[1];
});

test('timeout retains one worker slot until exit even when termination is delayed', async () => {
  let starts = 0, kills = 0, unrefs = 0;
  const child = new EventEmitter();
  Object.assign(child, { connected: true, send: (_message, callback) => callback(), kill: signal => { assert.equal(signal, 'SIGKILL'); kills++; }, unref: () => { unrefs++; }, channel: { unref() {} } });
  const discovery = createQiMoviDiscovery({ timeoutMs: 20, fork: () => { starts++; return child; } });
  assert.deepEqual(await discovery.discover(), { candidates: [], reason: 'QIMOVI_DISCOVERY_TIMEOUT' });
  for (let i = 0; i < 20; i++) assert.deepEqual(await discovery.discover(), { candidates: [], reason: 'QIMOVI_DISCOVERY_TIMEOUT' });
  assert.equal(starts, 1); assert.equal(kills, 1); assert.equal(unrefs, 1);
  child.emit('exit', null, 'SIGKILL');
});

test('helper startup and command errors remain sanitized and allow retries', async t => {
  const f = fixture(t); let starts = 0;
  const unavailable = createQiMoviDiscovery({ fork: () => { starts++; throw new Error(f.ownerToken); } });
  assert.deepEqual(await unavailable.discover(), { candidates: [], reason: 'QIMOVI_DISCOVERY_UNAVAILABLE' });
  assert.deepEqual(await unavailable.discover(), { candidates: [], reason: 'QIMOVI_DISCOVERY_UNAVAILABLE' });
  assert.equal(starts, 2);
  const commandFailure = createQiMoviDiscovery({ run: () => { throw new Error(f.ownerToken); } });
  assert.deepEqual(await commandFailure.discover(), { candidates: [], reason: 'QIMOVI_DISCOVERY_UNAVAILABLE' });
});

test('command timeouts retain a meaningful code during preference and process lookup', async t => {
  const f = fixture(t);
  for (const workspace of [undefined, f.a.directory]) {
    const discovery = createQiMoviDiscovery({ workspace, run: () => { throw Object.assign(new Error(f.ownerToken), { code: 'QIMOVI_DISCOVERY_TIMEOUT' }); } });
    assert.deepEqual(await discovery.discover(), { candidates: [], reason: 'QIMOVI_DISCOVERY_TIMEOUT' });
    await assert.rejects(discovery.resolve({ candidateId: 'qimovi-installed:fixture', expectedProjectId: f.a.project.id }), error => error.code === 'QIMOVI_DISCOVERY_TIMEOUT' && error.status === 504 && !error.message.includes(f.ownerToken));
  }
});
