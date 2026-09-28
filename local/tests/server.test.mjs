import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { initialize, loadConfig, WorkspaceStore } from '../server/storage.mjs';
import { startServer } from '../server/http.mjs';
import { validateBackup } from '../server/backup.mjs';

async function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-server-'));
  initialize(dir);
  const dist = path.join(dir, 'dist'); fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'local.html'), '<!doctype html><title>local</title>');
  fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1)');
  const server = await startServer({ directory: dir, dist, ...extra });
  const token = loadConfig(dir).ownerToken;
  let cookie = '';
  const call = (pathname, { method = 'GET', body, headers = {}, origin = server.origin } = {}) => fetch(server.origin + pathname, {
    method, redirect: 'manual', headers: { ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async response => { const set = response.headers.getSetCookie?.() ?? []; if (set.length) cookie = set[0].split(';')[0]; return { status: response.status, data: await response.json().catch(() => null), response }; });
  return { dir, server, token, call, cookieValue: () => cookie };
}

test('health is public; everything else needs the owner session, exact origin and host', async () => {
  const { server, token, call } = await boot();
  try {
    assert.equal((await call('/api/health')).data.mode, 'LOCAL_OWNER');
    assert.equal((await call('/api/bootstrap')).status, 401);
    assert.equal((await call('/api/session', { method: 'POST', body: { token: 'x'.repeat(64) } })).status, 401);
    assert.equal((await call('/api/session', { method: 'POST', body: { token }, origin: 'http://evil.test' })).status, 403);
    assert.equal((await call('/api/session', { method: 'POST', body: { token }, origin: null })).status, 403);
    const wrongHost = await new Promise(resolve => http.get({ host: '127.0.0.1', port: new URL(server.origin).port, path: '/api/health', headers: { Host: 'example.com' } }, response => { response.resume(); resolve(response.statusCode); }));
    assert.equal(wrongHost, 403);
    const login = await call('/api/session', { method: 'POST', body: { token } });
    assert.equal(login.status, 200); assert.equal(login.data.method, 'OWNER_TOKEN');
    const bootstrap = await call('/api/bootstrap');
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.data.project.profile, 'caniscreenwrite-local-writer/v1');
    assert.deepEqual(bootstrap.data.connectors.qimovi, { configured: false, origin: null, connected: false, project: null });
    assert.equal((await call('/api/session', { method: 'DELETE' })).status, 200);
    assert.equal((await call('/api/bootstrap')).status, 401);
  } finally { await server.close(); }
});

test('records save with CAS over HTTP; links cannot be written by the browser', async () => {
  const { server, token, call } = await boot();
  try {
    await call('/api/session', { method: 'POST', body: { token } });
    const project = (await call('/api/bootstrap')).data.project;
    const data = { schemaVersion: 2, projectId: project.id, sourceHash: null, title: 'Draft', format: 'FOUNTAIN', body: 'FADE IN:', status: 'DRAFT' };
    const first = await call('/api/records/screenplay-draft:abc', { method: 'PUT', body: { kind: 'screenplay-draft', expectedVersion: null, requestId: 'req-1', data } });
    assert.equal(first.status, 200); assert.equal(first.data.version, 1);
    const conflict = await call('/api/records/screenplay-draft:abc', { method: 'PUT', body: { kind: 'screenplay-draft', expectedVersion: null, requestId: 'req-2', data } });
    assert.equal(conflict.status, 409); assert.equal(conflict.data.error, 'VERSION_CONFLICT');
    const second = await call('/api/records/screenplay-draft:abc', { method: 'PUT', body: { kind: 'screenplay-draft', expectedVersion: 1, requestId: 'req-3', data: { ...data, body: 'FADE IN:\n\nINT. ROOM - DAY' } } });
    assert.equal(second.data.version, 2);
    assert.equal((await call('/api/records?kind=screenplay-draft')).data.length, 1);
    assert.deepEqual((await call('/api/records/screenplay-draft:abc/history')).data.map(r => r.version), [1, 2]);
    const link = await call('/api/records/sync-link:qimovi:abc', { method: 'PUT', body: { kind: 'sync-link', expectedVersion: null, requestId: 'req-4', data: {} } });
    assert.equal(link.status, 409); assert.equal(link.data.error, 'SYNC_LINK_REQUIRES_CONNECTOR');
    const disguised = await call('/api/records/sync-link:competition:abc', { method: 'PUT', body: { kind: 'screenplay-draft', expectedVersion: null, requestId: 'req-5', data } });
    assert.equal(disguised.status, 409);
    // The browser performs the hosted save itself, so it records competition links.
    const uuid = '11111111-2222-4333-8444-555555555555';
    const competitionLink = { schemaVersion: 1, projectId: project.id, draftId: 'screenplay-draft:abc', draftVersion: 2, draftSha256: second.data.sha256, target: 'competition', remote: { hostedOrigin: 'https://caniscreenwrite.com', draftId: uuid, userId: uuid }, linkedAt: new Date().toISOString() };
    const recorded = await call('/api/records/sync-link:competition:abc', { method: 'PUT', body: { kind: 'sync-link', expectedVersion: null, requestId: 'req-6', data: competitionLink } });
    assert.equal(recorded.status, 200); assert.equal(recorded.data.version, 1);
    assert.equal((await call('/api/records/sync-link:competition:abc', { method: 'PUT', body: { kind: 'sync-link', expectedVersion: 1, requestId: 'req-7', data: { ...competitionLink, draftVersion: 9 } } })).data.error, 'SYNC_LINK_DRAFT_REVISION_UNKNOWN');
    const notJson = await fetch(server.origin + '/api/records/screenplay-draft:abc', { method: 'PUT', headers: { Origin: server.origin, Cookie: 'writer_owner=nope', 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(notJson.status, 401);
  } finally { await server.close(); }
});

test('one-time login link works once and expires with use', async () => {
  const { server, call } = await boot({ loginNonce: 'n'.repeat(64) });
  try {
    assert.equal(server.loginUrl, `${server.origin}/#login=${'n'.repeat(64)}`);
    const login = await call('/api/session', { method: 'POST', body: { loginNonce: 'n'.repeat(64) } });
    assert.equal(login.status, 200); assert.equal(login.data.method, 'ONE_TIME_LINK');
    assert.equal((await call('/api/bootstrap')).status, 200);
    assert.equal((await call('/api/session', { method: 'POST', body: { loginNonce: 'n'.repeat(64) } })).status, 401);
  } finally { await server.close(); }
});

test('static files are served from dist with an app fallback and no traversal', async () => {
  const { server, dir } = await boot();
  try {
    const page = await fetch(server.origin + '/some/route');
    assert.equal(page.status, 200); assert.match(await page.text(), /<title>local<\/title>/);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https:/);
    assert.equal((await fetch(server.origin + '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(server.origin + '/../config.json')).status, 200); // normalised by URL to /config.json → fallback page
    assert.equal((await fetch(server.origin + '/.hidden')).status, 404);
    assert.equal(fs.existsSync(path.join(dir, 'process.lock')), true);
  } finally { await server.close(); }
  assert.equal(fs.existsSync(path.join(dir, 'process.lock')), false);
});

test('backup is authenticated, origin-checked JSON downloadable via an ordinary link', async () => {
  const { server, token, call, cookieValue, dir } = await boot();
  try {
    assert.equal((await call('/api/backup', { origin: null })).status, 401);
    await call('/api/session', { method: 'POST', body: { token } });
    const project = (await call('/api/bootstrap')).data.project;
    const data = { schemaVersion: 2, projectId: project.id, sourceHash: null, title: 'Backup', format: 'FOUNTAIN', body: 'First', status: 'DRAFT' };
    for (let index = 0; index < 2; index++) {
      assert.equal((await call('/api/records/screenplay-draft:backup', { method: 'PUT', body: { kind: 'screenplay-draft', expectedVersion: index || null, requestId: `backup-${index}`, data: { ...data, body: `${index}` } } })).status, 200);
    }
    assert.equal((await call('/api/backup', { origin: 'http://evil.test' })).status, 403);
    // Navigation carries the HttpOnly cookie but does not need an Origin header
    // or custom authorization header (including native WKDownload navigation).
    const response = await fetch(server.origin + '/api/backup?filename=../../config.json', { headers: { Cookie: cookieValue() } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="caniscreenwrite-workspace-backup.json"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const raw = await response.text();
    assert.equal(raw.includes(token), false);
    const backup = validateBackup(JSON.parse(raw));
    assert.deepEqual(backup.records.map(record => record.version), [1, 2]);
    assert.deepEqual(backup.project, project);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recovery remains discoverable after a server restart on a different origin; canonical history stays untouched', async () => {
  const { server, token, call, dir } = await boot();
  let restarted;
  // Keep the former port occupied after shutdown so this tests an actual origin change.
  let portBlocker;
  try {
    assert.equal((await call('/api/recovery')).status, 401);
    await call('/api/session', { method: 'POST', body: { token } });
    const project = (await call('/api/bootstrap')).data.project;
    const draftId = 'screenplay-draft:never-saved';
    const route = '/api/recovery/' + encodeURIComponent(draftId);
    const copy = { schema: 'caniscreenwrite-local-writer-recovery/v1', draftId, baseVersion: null, baseSha256: null, data: { schemaVersion: 2, projectId: project.id, sourceHash: null, title: 'Recovered after restart', format: 'FOUNTAIN', body: 'Unsaved text', status: 'DRAFT' }, savedAt: new Date().toISOString() };
    assert.equal((await call(route)).data, null);
    assert.equal((await call(route, { method: 'PUT', body: copy, origin: null })).status, 403);
    assert.equal((await call(route, { method: 'PUT', body: copy, origin: 'http://other.test' })).status, 403);
    assert.equal((await call(route, { method: 'PUT', body: { ...copy, data: { ...copy.data, projectId: 'foreign' } } })).status, 422);
    assert.equal((await call('/api/recovery/screenplay-draft%3A..%2Fconfig.json', { method: 'PUT', body: copy })).status, 422);
    const tooLarge = await call(route, { method: 'PUT', body: { ...copy, data: { ...copy.data, body: 'a'.repeat(2 * 1024 * 1024) } } });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual((await call(route, { method: 'PUT', body: copy })).data, copy);
    assert.deepEqual((await call('/api/recovery')).data, [copy]);
    assert.deepEqual((await call('/api/records')).data, []);
    assert.deepEqual((await call('/api/backup')).data.records, []);
    await server.close();
    portBlocker = http.createServer();
    await new Promise((resolve, reject) => { portBlocker.once('error', reject); portBlocker.listen(Number(new URL(server.origin).port), '127.0.0.1', resolve); });
    restarted = await startServer({ directory: dir });
    assert.notEqual(restarted.origin, server.origin);
    const login = await fetch(restarted.origin + '/api/session', { method: 'POST', headers: { Origin: restarted.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const headers = { Origin: restarted.origin, Cookie: cookie };
    assert.deepEqual(await (await fetch(restarted.origin + '/api/recovery', { headers })).json(), [copy]);
    assert.deepEqual(await (await fetch(restarted.origin + route, { headers })).json(), copy);
    assert.equal((await fetch(restarted.origin + route + '?savedAt=2020-01-01T00%3A00%3A00.000Z', { method: 'DELETE', headers })).status, 409);
    assert.deepEqual(await (await fetch(restarted.origin + route, { method: 'DELETE', headers })).json(), { deleted: true });
    assert.deepEqual(await (await fetch(restarted.origin + '/api/recovery', { headers })).json(), []);
    const inspection = new WorkspaceStore(dir);
    try { assert.deepEqual(inspection.list(), []); }
    finally { inspection.close(); }
  } finally {
    await server.close();
    await restarted?.close();
    if (portBlocker?.listening) await new Promise(resolve => portBlocker.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('initializer cannot mutate a live workspace; close is idempotent and failed startup releases its lock', async () => {
  const { server, dir } = await boot();
  const configBefore = fs.readFileSync(path.join(dir, 'config.json'));
  const dbBefore = fs.readFileSync(path.join(dir, 'workspace.sqlite'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-failed-start-'));
  initialize(other);
  try {
    assert.throws(() => initialize(dir, { title: 'Should never happen' }), /LOCAL_WRITER_ALREADY_RUNNING/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'config.json')), configBefore);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'workspace.sqlite')), dbBefore);
    await assert.rejects(startServer({ directory: dir }), /LOCAL_WRITER_ALREADY_RUNNING/);
    await assert.rejects(startServer({ directory: other, port: Number(new URL(server.origin).port) }), /EADDRINUSE/);
    assert.equal(fs.existsSync(path.join(other, 'process.lock')), false);
    const afterFailure = await startServer({ directory: other });
    await Promise.all([afterFailure.close(), afterFailure.close()]);
    assert.equal(fs.existsSync(path.join(other, 'process.lock')), false);
  } finally {
    await Promise.all([server.close(), server.close()]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
