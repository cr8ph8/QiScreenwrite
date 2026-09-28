import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, WorkspaceStore, canonicalJson, hashCanonical } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { validateSharedWorld } from '../server/shared-world.mjs';
import { newWorldElement, newWorldLink, worldTextLength } from '../server/world.mjs';
import { createBackup, restoreWorkspace, validateBackup, backupChecksum } from '../server/backup.mjs';
import { startServer } from '../server/http.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-shared-world-'));
  const directory = path.join(root, 'source');
  const config = initialize(directory);
  const store = new WorkspaceStore(directory, validateRecord);
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });
  const id = `shared-world:${crypto.randomUUID()}`;
  const input = (data, expectedVersion = null, requestId = crypto.randomUUID()) => ({ kind: 'shared-world', data, expectedVersion, requestId });
  return { root, directory, config, store, close, id, input };
}

function maximum(projectId) {
  const elements = Array.from({ length: 300 }, (_, order) => ({ ...newWorldElement('location'), order }));
  const links = Array.from({ length: 1000 }, () => newWorldLink(elements[0].id, 'element', elements[1].id, ''));
  let remaining = 164000; // 1000 UUID references take the remaining 36,000 characters.
  for (const element of elements) { element.description = '界'.repeat(Math.min(8000, remaining)); remaining -= element.description.length; }
  return { schemaVersion: 1, projectId, name: 'N'.repeat(160), description: '界'.repeat(24000), world: { schemaVersion: 1, elements, links } };
}

test('maximum shared world saves and replays with immutable history, CAS, restart and backup restore', t => {
  const { root, directory, store, close, id, input } = fixture(t);
  const data = maximum(store.project().id);
  assert.equal(worldTextLength(data.world), 200000);
  assert.equal(validateSharedWorld('shared-world', data, store.project(), id), data);
  const request = input(data);
  for (const value of [data, request, { id, ...request }]) assert.deepEqual(JSON.parse(canonicalJson(value)), value);
  const first = store.save(id, request);
  assert.equal(first.sha256, hashCanonical(data));
  for (const value of [first, { ...first, replayed: true }]) assert.deepEqual(JSON.parse(canonicalJson(value)), value);
  const second = store.save(id, input({ ...data, name: 'Changed name' }, first.version));
  assert.throws(() => store.save(id, input(data, first.version)), /VERSION_CONFLICT/);
  assert.throws(() => store.save(id, { ...request, data: { ...data, name: 'Different request' } }), /REQUEST_ID_CONFLICT/);
  assert.deepEqual(store.save(id, request), { ...first, replayed: true });
  const backup = createBackup(store);
  assert.equal(validateBackup(backup), backup);
  const restoredDirectory = path.join(root, 'restored');
  assert.equal(restoreWorkspace(restoredDirectory, backup).revisions, 2);
  const restored = new WorkspaceStore(restoredDirectory, validateRecord);
  try { assert.deepEqual(restored.history(id), [first, second]); assert.equal(restored.save(id, input(data, second.version)).version, 3); }
  finally { restored.close(); }
  close();
  const reopened = new WorkspaceStore(directory, validateRecord);
  try { assert.deepEqual(reopened.history(id), [first, second]); assert.deepEqual(reopened.save(id, request), { ...first, replayed: true }); }
  finally { reopened.close(); }
});

test('invalid shared worlds fail without changing history or request receipts, including valid-hash corrupt backups', t => {
  const { root, store, id, input } = fixture(t);
  const data = maximum(store.project().id);
  const saved = store.save(id, input(data));
  const receipts = store.db.prepare('SELECT * FROM requests').all();
  for (const mutate of [
    value => { value.world.elements.push(newWorldElement('prop')); },
    value => { value.world.links.push(newWorldLink(value.world.elements[0].id, 'element', value.world.elements[1].id, '')); },
    value => { value.world.elements[0].name = 'x'; },
    value => { value.description += 'x'; },
    value => { value.name += 'x'; },
    value => { value.world.links[0].targetType = 'scene'; },
    value => { value.world.links[0].targetRef = crypto.randomUUID(); },
    value => { value.projectId = 'local-project:foreign'; },
    value => { value.authority = 'CANONICAL'; },
  ]) {
    const invalid = structuredClone(data); mutate(invalid);
    assert.throws(() => store.save(id, input(invalid, saved.version)));
    assert.deepEqual(store.history(id), [saved]);
    assert.deepEqual(store.db.prepare('SELECT * FROM requests').all(), receipts);
  }
  const backup = createBackup(store);
  backup.records[0].data.world.links[0].targetType = 'scene';
  backup.records[0].sha256 = hashCanonical(backup.records[0].data);
  backup.sha256 = backupChecksum(backup);
  assert.throws(() => validateBackup(backup), /SHARED_WORLD_SOURCE_LINK_FORBIDDEN/);
  const destination = path.join(root, 'invalid-restore');
  assert.throws(() => restoreWorkspace(destination, backup), /SHARED_WORLD_SOURCE_LINK_FORBIDDEN/);
  assert.equal(fs.existsSync(destination), false);
});

test('authenticated API saves a maximum shared world and exposes it in bootstrap, history and backup', async t => {
  const { directory, config, store, close, id, input } = fixture(t);
  const data = maximum(store.project().id);
  close();
  const server = await startServer({ directory });
  t.after(() => server.close());
  const session = await fetch(`${server.origin}/api/session`, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.ownerToken }) });
  assert.equal(session.status, 200);
  const cookie = session.headers.getSetCookie()[0].split(';')[0];
  const call = (route, method = 'GET', body, origin = server.origin) => fetch(server.origin + route, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const route = `/api/records/${encodeURIComponent(id)}`;
  const request = input(data);
  assert.equal((await call(route, 'PUT', request, 'http://foreign.test')).status, 403);
  const response = await call(route, 'PUT', request);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(saved.data, data);
  assert.equal(saved.sha256, hashCanonical(data));
  assert.deepEqual(await (await call(route, 'PUT', request)).json(), { ...saved, replayed: true });
  assert.equal((await call(route, 'PUT', input({ ...data, name: 'stale' }))).status, 409);
  assert.equal((await call(route, 'PUT', input({ ...data, description: 'x'.repeat(24001) }, 1))).status, 422);
  assert.deepEqual((await (await call('/api/bootstrap')).json()).records, [saved]);
  assert.deepEqual(await (await call(`${route}/history`)).json(), [saved]);
  const backup = await (await call('/api/backup')).json();
  validateBackup(backup);
  const { replayed: _transportReceipt, ...revision } = saved;
  assert.deepEqual(backup.records, [revision]);
});
