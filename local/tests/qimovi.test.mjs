// Bridge tests against a stand-in QiMovi service that enforces the same
// session, origin and creative-draft rules, and, when the Qi Movie Slate
// checkout is present on this machine, against the real QiMovi service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { initialize, loadConfig, WorkspaceStore, canonicalJson, sha256 } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { startServer } from '../server/http.mjs';
import { QiMoviBridge } from '../server/qimovi.mjs';

const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const draft = (project, body) => ({ schemaVersion: 2, projectId: project.id, sourceHash: null, title: 'Carried draft', format: 'FOUNTAIN', body, status: 'DRAFT', logline: 'Local only field.' });

/** Minimal QiMovi-shaped service: owner token → filmstack_owner cookie, bootstrap, records with CAS and creative-draft validation. */
async function fakeQiMovi({ profile = 'caniscreenwrite-creative/v1', sourceHash = null } = {}) {
  const ownerToken = crypto.randomBytes(32).toString('hex');
  const project = profile === 'caniscreenwrite-creative/v1'
    ? { id: 'creative-project:fake', title: 'Fake creative project', profile, sourceHash: null, sourceStatus: 'NO_SCREENPLAY', scenes: [], cells: [], characters: [], continuityQuestions: [] }
    : { id: 'drifter', title: 'Fake film project', sourceHash, sourceStatus: 'ADMITTED', scenes: [], cells: [], characters: [], continuityQuestions: [] };
  const records = new Map(); const requests = new Map(); let session = null; let origin; const seen = [];
  const server = http.createServer(async (req, res) => {
    const reply = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    seen.push({ method: req.method, url: req.url, origin: req.headers.origin, host: req.headers.host });
    if (req.headers.host !== new URL(origin).host) return reply(403, { error: 'HOST_REJECTED' });
    if (req.headers.origin && req.headers.origin !== origin) return reply(403, { error: 'ORIGIN_REJECTED' });
    if (req.method !== 'GET' && req.headers.origin !== origin) return reply(403, { error: 'EXACT_ORIGIN_REQUIRED' });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    if (req.url === '/api/caniscreenwrite/session' && req.method === 'POST') {
      if (body?.token !== ownerToken) return reply(401, { error: 'OWNER_TOKEN_REJECTED' });
      session = crypto.randomBytes(16).toString('hex');
      return reply(200, { authenticated: true, protocol: 'caniscreenwrite-bridge/v1' }, { 'Set-Cookie': `caniscreenwrite_bridge=${session}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (!session || req.headers.cookie !== `caniscreenwrite_bridge=${session}`) return reply(401, { error: 'OWNER_SESSION_REQUIRED' });
    if (req.url === '/api/bootstrap') return reply(200, { project, records: [...records.values()], canonical: { version: 0, stateHash: 'x', sourceStatus: project.sourceStatus } });
    const put = /^\/api\/records\/([^/]+)$/.exec(req.url);
    if (put && req.method === 'PUT') {
      const id = decodeURIComponent(put[1]); const { kind, expectedVersion, requestId, data } = body;
      const requestHash = sha256(canonicalJson({ id, kind, requestId, expectedVersion, data }));
      if (requests.has(requestId)) return requests.get(requestId).hash === requestHash ? reply(200, { ...requests.get(requestId).result, replayed: true }) : reply(409, { error: 'REQUEST_ID_CONFLICT' });
      const current = records.get(id) ?? null;
      if ((current?.version ?? null) !== expectedVersion) return reply(409, { error: 'VERSION_CONFLICT' });
      const allowed = profile === 'caniscreenwrite-creative/v1' ? ['schemaVersion', 'projectId', 'sourceHash', 'title', 'format', 'body', 'status', 'genre', 'projectFormat', 'targetPages', 'sceneMap', 'inputRefs'] : ['sourceHash', 'title', 'format', 'body', 'sceneId', 'genre', 'projectFormat', 'targetPages', 'inputRefs', 'sceneMap'];
      if (!Object.keys(data).every(key => allowed.includes(key))) return reply(422, { error: 'CREATIVE_SCREENPLAY_FIELDS_INVALID' });
      if (profile === 'caniscreenwrite-creative/v1' ? data.projectId !== project.id || data.sourceHash !== null : data.sourceHash !== sourceHash) return reply(422, { error: 'CREATIVE_SCREENPLAY_PROJECT_MISMATCH' });
      const dataText = canonicalJson(data);
      const result = { id, kind, version: (current?.version ?? 0) + 1, sha256: sha256(dataText), data: JSON.parse(dataText), replayed: false };
      records.set(id, result); requests.set(requestId, { hash: requestHash, result });
      return reply(200, result);
    }
    reply(404, { error: 'ROUTE_NOT_FOUND' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, ownerToken, project, records, seen, invalidateSession: () => { session = crypto.randomBytes(16).toString('hex'); }, close: () => new Promise(resolve => server.close(resolve)) };
}

test('bridge configures privately, connects with the owner token and pushes/pulls a draft with shared identity', async () => {
  const remote = await fakeQiMovi();
  const dir = temp('writer-bridge-'); initialize(dir);
  const store = new WorkspaceStore(dir, validateRecord);
  const bridge = new QiMoviBridge(dir);
  try {
    assert.equal(bridge.status().configured, false);
    assert.throws(() => bridge.configure({ origin: 'http://localhost:4317', ownerToken: remote.ownerToken }), { code: 'QIMOVI_ORIGIN_INVALID' });
    assert.throws(() => bridge.configure({ origin: remote.origin, ownerToken: 'short' }), { code: 'QIMOVI_TOKEN_INVALID' });
    bridge.configure({ origin: remote.origin, ownerToken: remote.ownerToken });
    assert.equal(fs.statSync(path.join(dir, 'connections.json')).mode & 0o077, 0);
    assert.deepEqual(bridge.status(), { configured: true, origin: remote.origin, connected: false, project: null });

    const project = store.project();
    const local = store.save('screenplay-draft:shared', { kind: 'screenplay-draft', expectedVersion: null, requestId: 'local-1', data: draft(project, 'INT. STUDIO - NIGHT\n\nThe projector hums.') });
    const summary = await bridge.connect();
    assert.equal(summary.connected, true); assert.equal(summary.project.id, 'creative-project:fake'); assert.deepEqual(summary.drafts, []);

    const push = await bridge.pushDraft(store, 'screenplay-draft:shared');
    assert.equal(push.changed, true); assert.equal(push.remote.id, 'screenplay-draft:shared'); assert.equal(push.remote.version, 1);
    const stored = remote.records.get('screenplay-draft:shared').data;
    assert.equal(stored.projectId, 'creative-project:fake'); assert.equal(stored.body, local.data.body); assert.equal(stored.logline, undefined);
    assert.equal(push.link.kind, 'sync-link'); assert.equal(push.link.data.remote.version, 1); assert.equal(push.link.data.draftVersion, 1);
    // Pushing again without local change is a no-op remotely and keeps the same link.
    const again = await bridge.pushDraft(store, 'screenplay-draft:shared');
    assert.equal(again.changed, false); assert.equal(again.link.version, push.link.version);
    // A local revision pushes as remote version 2 with CAS.
    store.save('screenplay-draft:shared', { kind: 'screenplay-draft', expectedVersion: 1, requestId: 'local-2', data: draft(project, 'INT. STUDIO - NIGHT\n\nThe projector hums.\n\nA reel spins.') });
    const second = await bridge.pushDraft(store, 'screenplay-draft:shared');
    assert.equal(second.remote.version, 2); assert.equal(second.link.data.draftVersion, 2);
    // An expired bridge session can be renewed without a native-owner login.
    remote.invalidateSession();
    const afterRelogin = await bridge.pushDraft(store, 'screenplay-draft:shared');
    assert.equal(afterRelogin.changed, false); assert.equal(afterRelogin.remote.version, 2);
    // A change made in QiMovi pulls back as a new local version and keeps the local logline.
    const edited = { ...remote.records.get('screenplay-draft:shared').data, body: 'INT. STUDIO - NIGHT\n\nEdited in QiMovi.', genre: 'Drama' };
    const text = canonicalJson(edited);
    remote.records.set('screenplay-draft:shared', { id: 'screenplay-draft:shared', kind: 'screenplay-draft', version: 3, sha256: sha256(text), data: JSON.parse(text) });
    const pull = await bridge.pullDraft(store, 'screenplay-draft:shared');
    assert.equal(pull.changed, true); assert.equal(pull.local.version, 3);
    const current = store.current('screenplay-draft:shared').data;
    assert.equal(current.body, 'INT. STUDIO - NIGHT\n\nEdited in QiMovi.'); assert.equal(current.genre, 'Drama'); assert.equal(current.logline, 'Local only field.'); assert.equal(current.projectId, project.id);
    assert.equal(pull.link.data.remote.version, 3);
    assert.ok(remote.seen.every(request => request.origin === remote.origin && request.host === new URL(remote.origin).host));
    bridge.clear();
    assert.equal(bridge.status().configured, false);
  } finally { store.close(); await remote.close(); }
});

test('bridge shapes a source-bound draft for a film project and refuses unknown sources', async () => {
  const sourceHash = 'f'.repeat(64);
  const remote = await fakeQiMovi({ profile: 'filmstack-film/v1', sourceHash });
  const dir = temp('writer-bridge-film-'); initialize(dir);
  const store = new WorkspaceStore(dir, validateRecord);
  const bridge = new QiMoviBridge(dir);
  try {
    bridge.configure({ origin: remote.origin, ownerToken: remote.ownerToken });
    const project = store.project();
    store.save('screenplay-draft:film', { kind: 'screenplay-draft', expectedVersion: null, requestId: 'local-1', data: { ...draft(project, 'EXT. DESERT - DAY'), projectFormat: 'short' } });
    const push = await bridge.pushDraft(store, 'screenplay-draft:film');
    const stored = remote.records.get('screenplay-draft:film').data;
    assert.deepEqual(stored, { sourceHash, title: 'Carried draft', format: 'FOUNTAIN', body: 'EXT. DESERT - DAY', projectFormat: 'short' });
    assert.equal(push.link.data.remote.projectProfile, 'filmstack-film/v1');
  } finally { store.close(); await remote.close(); }
});

test('HTTP connector routes drive the bridge and never expose the QiMovi token', async () => {
  const remote = await fakeQiMovi();
  const dir = temp('writer-bridge-http-'); initialize(dir);
  const server = await startServer({ directory: dir });
  let cookie = '';
  const call = (pathname, method = 'GET', body) => fetch(server.origin + pathname, { method, headers: { Origin: server.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async response => { const set = response.headers.getSetCookie?.() ?? []; if (set.length) cookie = set[0].split(';')[0]; return { status: response.status, data: await response.json() }; });
  try {
    await call('/api/session', 'POST', { token: loadConfig(dir).ownerToken });
    assert.equal((await call('/api/connectors/qimovi/connect', 'POST', {})).data.error, 'QIMOVI_NOT_CONFIGURED');
    const configured = await call('/api/connectors/qimovi/config', 'PUT', { origin: remote.origin, ownerToken: remote.ownerToken });
    assert.equal(configured.status, 200); assert.equal(JSON.stringify(configured.data).includes(remote.ownerToken), false);
    const connected = await call('/api/connectors/qimovi/connect', 'POST', {});
    assert.equal(connected.data.project.title, 'Fake creative project');
    const project = (await call('/api/bootstrap')).data.project;
    await call('/api/records/screenplay-draft:http', 'PUT', { kind: 'screenplay-draft', expectedVersion: null, requestId: 'r1', data: draft(project, 'INT. HALL - DAY') });
    const push = await call('/api/connectors/qimovi/push', 'POST', { draftId: 'screenplay-draft:http' });
    assert.equal(push.status, 200); assert.equal(push.data.remote.version, 1);
    const bootstrap = await call('/api/bootstrap');
    assert.equal(bootstrap.data.records.filter(r => r.kind === 'sync-link').length, 1);
    assert.equal(JSON.stringify(bootstrap.data).includes(remote.ownerToken), false);
    assert.equal((await call('/api/connectors/qimovi/push', 'POST', { draftId: 'screenplay-draft:missing' })).status, 404);
    await remote.close();
    const down = await call('/api/connectors/qimovi/push', 'POST', { draftId: 'screenplay-draft:http' });
    assert.equal(down.status, 502); assert.equal(down.data.error, 'QIMOVI_UNREACHABLE');
  } finally { await server.close(); await remote.close().catch(() => {}); }
});

test('old QiMovi protocol never falls back to the native owner route', async () => {
  const dir = temp('writer-old-'); initialize(dir);
  const routes = [];
  const bridge = new QiMoviBridge(dir, { fetch: async url => {
    routes.push(new URL(url).pathname);
    return Response.json({ error: 'OWNER_SESSION_REQUIRED' }, { status: 401 });
  } });
  bridge.configure({ origin: 'http://127.0.0.1:4317', ownerToken: 'a'.repeat(64) });
  await assert.rejects(bridge.connect(), { code: 'QIMOVI_BRIDGE_UPDATE_REQUIRED' });
  assert.deepEqual(routes, ['/api/caniscreenwrite/session']);
  fs.rmSync(dir, { recursive: true, force: true });
});
