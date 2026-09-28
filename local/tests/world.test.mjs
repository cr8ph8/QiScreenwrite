import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, WorkspaceStore, canonicalJson, hashCanonical, MAX_CANONICAL_NODES, MAX_CANONICAL_BYTES, MAX_WORLD_CANONICAL_NODES, MAX_WORLD_CANONICAL_BYTES } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { validateDevelopment } from '../server/development.mjs';
import { createWorld, newWorldElement, newWorldLink, validateWorld, worldError, WORLD_LIMITS } from '../server/world.mjs';
import { createBackup, restoreWorkspace, validateBackup, backupChecksum } from '../server/backup.mjs';
import { DevelopmentRecoveryStore, DEVELOPMENT_RECOVERY_SCHEMA, MAX_RECOVERY_BYTES } from '../server/recovery.mjs';
import { startServer } from '../server/http.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-world-'));
  const directory = path.join(root, 'source');
  const config = initialize(directory);
  const store = new WorkspaceStore(directory, validateRecord);
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });
  const projectId = store.project().id;
  const draftId = `screenplay-draft:${crypto.randomUUID()}`;
  const id = draftId.replace('screenplay-draft:', 'story-development:');
  store.save(draftId, { kind: 'screenplay-draft', expectedVersion: null, requestId: crypto.randomUUID(), data: { schemaVersion: 2, projectId, sourceHash: null, title: 'World fixture', format: 'FOUNTAIN', body: 'INT. HARBOR - DAY\n\nÉ walks in.', status: 'DRAFT' } });
  const legacy = { schemaVersion: 1, projectId, draftId, concept: '  Original concept 🎬  ', logline: '', synopsis: '', outline: '', beats: [], characters: [], worldNotes: 'Legacy world notes', researchNotes: [] };
  const world = createWorld();
  world.elements.push({ ...newWorldElement('location'), name: 'Harbor', description: '  Wet stone\n海 🎬  ', status: 'established' });
  world.elements.push({ ...newWorldElement('prop'), name: 'Compass', continuity: 'Always cracked', order: 1 });
  world.links.push(newWorldLink(world.elements[0].id, 'element', world.elements[1].id, 'Compass'));
  world.links.push(newWorldLink(world.elements[0].id, 'scene', 'opaque:scene/α#12', 'Opening'));
  world.links.push(newWorldLink(world.elements[1].id, 'character', 'external character ref', 'É'));
  const data = { ...legacy, schemaVersion: 2, world };
  const input = (data, expectedVersion = null, requestId = crypto.randomUUID()) => ({ kind: 'story-development', data, expectedVersion, requestId });
  const recoveryCopy = (data, base = null, pendingSave = null) => ({ schema: DEVELOPMENT_RECOVERY_SCHEMA, projectId, draftId, baseVersion: base?.version ?? null, baseSha256: base?.sha256 ?? null, data, pendingSave, savedAt: '2026-09-26T12:00:00.000Z' });
  return { root, directory, config, store, close, id, draftId, legacy, data, input, recoveryCopy };
}

test('v1 and v2 append immutable snapshots with exact replay, ownership and CAS across restart', t => {
  const { directory, store, close, id, draftId, legacy, data, input } = fixture(t);
  const draftBefore = store.history(draftId);
  const originalBytes = canonicalJson(legacy);
  const first = store.save(id, input(legacy));
  assert.equal(first.data.schemaVersion, 1);
  assert.equal(Object.hasOwn(first.data, 'world'), false);
  assert.equal(canonicalJson(first.data), originalBytes);
  const request = input(data, first.version);
  const immutableRequest = structuredClone(request);
  const second = store.save(id, request);
  assert.deepEqual(second.data, data);
  assert.equal(second.sha256, hashCanonical(data));
  data.world.elements[0].description = 'Edits after clicking save';
  data.world.links[0].notes = 'Newer edits';
  assert.deepEqual(store.current(id), second);
  assert.deepEqual(store.save(id, immutableRequest), { ...second, replayed: true });
  assert.throws(() => store.save(id, request), /REQUEST_ID_CONFLICT/);
  assert.throws(() => store.save(id, input(data, 1)), /VERSION_CONFLICT/);
  const third = store.save(id, input(data, second.version));
  assert.deepEqual(store.history(id), [first, second, third]);
  assert.equal(canonicalJson(store.history(id)[0].data), originalBytes);
  assert.throws(() => store.db.prepare('DELETE FROM records WHERE id = ?').run(id), /IMMUTABLE_RECORD/);
  assert.throws(() => store.db.prepare('UPDATE records SET data = ? WHERE id = ?').run('{}', id), /IMMUTABLE_RECORD/);
  const foreign = { ...data, draftId: `screenplay-draft:${crypto.randomUUID()}` };
  assert.throws(() => validateDevelopment(foreign, store.project(), { id, previous: third, store }), /IDENTITY_MISMATCH/);
  assert.deepEqual(store.history(draftId), draftBefore);
  close();
  const reopened = new WorkspaceStore(directory, validateRecord);
  try {
    assert.deepEqual(reopened.history(id), [first, second, third]);
    assert.deepEqual(reopened.current(id), third);
  } finally { reopened.close(); }
});

test('mixed v1/v2 backup restore retains hashes and validates internal references before importing', t => {
  const { root, store, id, legacy, data, input } = fixture(t);
  const first = store.save(id, input(legacy));
  const second = store.save(id, input(data, first.version));
  const backup = createBackup(store);
  assert.equal(validateBackup(backup), backup);
  const destination = path.join(root, 'restored');
  assert.equal(restoreWorkspace(destination, backup).revisions, 3);
  const restored = new WorkspaceStore(destination, validateRecord);
  try {
    assert.deepEqual(restored.history(id), [first, second]);
    const edited = structuredClone(data); edited.world.elements[1].continuity = 'Author revision';
    assert.equal(restored.save(id, input(edited, second.version)).version, 3);
  } finally { restored.close(); }
  const bad = structuredClone(backup);
  const record = bad.records.find(record => record.id === id && record.version === 2);
  record.data.world.links[0].targetRef = crypto.randomUUID();
  record.sha256 = hashCanonical(record.data);
  bad.sha256 = backupChecksum(bad);
  assert.throws(() => validateBackup(bad), error => error.code === 'STORY_WORLD_INVALID');
  const badDestination = path.join(root, 'invalid-restore');
  assert.throws(() => restoreWorkspace(badDestination, bad), error => error.code === 'STORY_WORLD_INVALID');
  assert.equal(fs.existsSync(badDestination), false);
});

test('v2 recovery survives restart and retains the exact pending save separately from newer working edits', t => {
  const { directory, store, close, id, draftId, legacy, data, input, recoveryCopy } = fixture(t);
  const base = store.save(id, input(legacy));
  const pending = { id, ...input(structuredClone(data), base.version) };
  const { id: recordId, ...body } = pending;
  const saved = store.save(recordId, body); // Response may have been lost.
  const working = structuredClone(data);
  working.world.elements[0].description = 'Unsaved after request';
  const copy = recoveryCopy(working, base, pending);
  const recovery = new DevelopmentRecoveryStore(store);
  const history = store.history(id);
  const receipts = store.db.prepare('SELECT * FROM requests').all();
  assert.deepEqual(recovery.put(draftId, copy), copy);
  assert.deepEqual(recovery.list(), [copy]);
  assert.deepEqual(store.history(id), history);
  assert.deepEqual(store.db.prepare('SELECT * FROM requests').all(), receipts);
  for (const field of ['data', 'pendingSave']) {
    const bad = structuredClone(copy);
    const world = field === 'data' ? bad.data.world : bad.pendingSave.data.world;
    world.links[0].targetRef = crypto.randomUUID();
    assert.throws(() => recovery.put(draftId, bad), error => error.code === 'STORY_WORLD_INVALID');
  }
  assert.deepEqual(recovery.get(draftId), copy);
  close();
  const reopened = new WorkspaceStore(directory, validateRecord);
  try {
    const copies = new DevelopmentRecoveryStore(reopened);
    assert.deepEqual(copies.get(draftId), copy);
    assert.deepEqual(reopened.save(recordId, body), { ...saved, replayed: true });
    assert.deepEqual(reopened.history(id), history);
    assert.deepEqual(copies.get(draftId).data.world, working.world);
    const conflict = structuredClone(copy);
    conflict.pendingSave.data.world.elements[0].description = 'Different valid request body';
    assert.throws(() => copies.put(draftId, conflict), /RECOVERY_PENDING_SAVE_CONFLICT/);
    assert.throws(() => copies.delete(draftId, '2026-09-25T12:00:00.000Z'), /RECOVERY_CONFLICT/);
    assert.deepEqual(copies.get(draftId), copy);
  } finally { reopened.close(); }
});

test('v2 working recovery can retain an uncertain v1 request without silently upgrading its replay', t => {
  const { store, id, draftId, legacy, data, input, recoveryCopy } = fixture(t);
  const pending = { id, ...input(legacy) };
  const { id: recordId, ...body } = pending;
  const first = store.save(recordId, body);
  const copy = recoveryCopy(data, null, pending);
  const recovery = new DevelopmentRecoveryStore(store);
  assert.deepEqual(recovery.put(draftId, copy), copy);
  const replay = store.save(recordId, body);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.data, legacy);
  assert.equal(Object.hasOwn(replay.data, 'world'), false);
  assert.equal(store.save(id, input(copy.data, first.version)).data.schemaVersion, 2);
  assert.deepEqual(recovery.get(draftId), copy);
});

test('malformed world and schema payloads never append history or request receipts', t => {
  const { store, id, legacy, data, input } = fixture(t);
  const saved = store.save(id, input(data));
  const before = store.db.prepare('SELECT * FROM requests').all();
  const changes = [
    value => { value.schemaVersion = 1; },
    value => { delete value.world; },
    value => { value.world.elements[0].description = '\uD800'; },
    value => { value.world.links[0].targetRef = '\0'; },
    value => { value.world.elements.push({ ...value.world.elements[0], id: value.world.elements[0].id.toUpperCase() }); },
    value => { value.world.links.push({ ...value.world.links[0], id: value.world.links[0].id.toUpperCase() }); },
    value => { value.world.links[0].elementId = crypto.randomUUID(); },
    value => { value.world.links[0].targetRef = value.world.links[0].elementId.toUpperCase(); },
    value => { Object.defineProperty(value.world, '__proto__', { enumerable: true, value: {} }); },
    value => { value.world.links[0].targetLabel = 'x'.repeat(501); },
    value => { value.world.elements[0].order = -0; },
  ];
  for (const change of changes) {
    const invalid = structuredClone(data); change(invalid);
    assert.throws(() => store.save(id, input(invalid, saved.version)));
    assert.deepEqual(store.history(id), [saved]);
    assert.deepEqual(store.db.prepare('SELECT * FROM requests').all(), before);
  }
  assert.throws(() => validateDevelopment({ ...legacy, world: createWorld() }, store.project()), /FIELDS_INVALID/);
});

function maximumDevelopment(data, character = '界') {
  const result = structuredClone(data);
  for (const key of ['concept', 'logline', 'synopsis', 'outline', 'worldNotes']) result[key] = '';
  result.beats = Array.from({ length: 200 }, (_, index) => ({ id: crypto.randomUUID(), title: '', description: index < 50 ? character.repeat(4000) : '' }));
  result.characters = Array.from({ length: 100 }, () => ({ id: crypto.randomUUID(), name: '', role: '', description: '', arc: '' }));
  result.researchNotes = Array.from({ length: 100 }, () => ({ id: crypto.randomUUID(), title: '', notes: '', source: '' }));
  result.world.elements = Array.from({ length: 300 }, () => newWorldElement('location'));
  result.world.links = Array.from({ length: 1000 }, () => newWorldLink(result.world.elements[0].id, 'element', result.world.elements[1].id, ''));
  // 36,000 reference characters + 164,000 description characters = 200,000.
  let remaining = 164000;
  for (const element of result.world.elements) {
    element.description = character.repeat(Math.min(8000, remaining));
    remaining -= element.description.length;
  }
  return result;
}
const nodeCount = value => 1 + (value && typeof value === 'object' ? Object.values(value).reduce((sum, child) => sum + nodeCount(child), 0) : 0);

test('all advertised world/development maxima save, replay, backup and recover with an independent full pending copy', t => {
  const { root, directory, store, close, id, draftId, legacy, data, input, recoveryCopy } = fixture(t);
  const first = store.save(id, input(legacy));
  const maximum = maximumDevelopment(data);
  assert.equal(validateDevelopment(maximum, store.project(), { id, store }), maximum);
  assert.equal(nodeCount(maximum), 11916);
  assert.equal(nodeCount(maximum.world), 10004);
  assert.deepEqual(JSON.parse(canonicalJson(maximum.world)), maximum.world);
  const pending = { id, ...input(maximum, first.version) };
  const { id: recordId, ...body } = pending;
  assert.deepEqual(JSON.parse(canonicalJson(body)), body);
  const second = store.save(recordId, body);
  assert.deepEqual(second.data, maximum);
  assert.equal(second.sha256, hashCanonical(maximum));
  assert.deepEqual(store.save(recordId, body), { ...second, replayed: true });
  const working = structuredClone(maximum);
  working.world.elements[0].description = '改' + working.world.elements[0].description.slice(1);
  const copy = recoveryCopy(working, first, pending);
  assert.equal(nodeCount(copy), 23844);
  const serialized = canonicalJson(copy);
  assert.ok(Buffer.byteLength(serialized) > MAX_CANONICAL_BYTES);
  assert.ok(Buffer.byteLength(serialized) <= MAX_RECOVERY_BYTES);
  const recovery = new DevelopmentRecoveryStore(store);
  const receipts = store.db.prepare('SELECT * FROM requests').all();
  assert.deepEqual(recovery.put(draftId, copy), copy);
  assert.deepEqual(recovery.put(draftId, copy), copy); // Same timestamp and exact bytes.
  assert.deepEqual(recovery.get(draftId), copy);
  assert.deepEqual(recovery.list(), [copy]);
  assert.deepEqual(store.history(id), [first, second]);
  assert.deepEqual(store.db.prepare('SELECT * FROM requests').all(), receipts);
  const backup = createBackup(store);
  const restoredDirectory = path.join(root, 'maximum-restored');
  restoreWorkspace(restoredDirectory, backup);
  const restored = new WorkspaceStore(restoredDirectory, validateRecord);
  try { assert.deepEqual(restored.history(id), [first, second]); }
  finally { restored.close(); }
  close();
  const reopened = new WorkspaceStore(directory, validateRecord);
  try {
    assert.deepEqual(new DevelopmentRecoveryStore(reopened).get(draftId), copy);
    assert.deepEqual(reopened.save(recordId, body), { ...second, replayed: true });
  } finally { reopened.close(); }
});

test('over-budget worlds and recovery copies reject before records, receipts or recovery mutate', t => {
  const { store, id, draftId, data, input, recoveryCopy } = fixture(t);
  const maximum = maximumDevelopment(data);
  const saved = store.save(id, input(maximum));
  const copy = recoveryCopy(maximum, saved, { id, ...input(structuredClone(maximum), saved.version) });
  const recovery = new DevelopmentRecoveryStore(store);
  recovery.put(draftId, copy);
  const receipts = store.db.prepare('SELECT * FROM requests').all();
  const rows = store.db.prepare('SELECT * FROM development_recovery').all();
  for (const change of [
    value => { value.world.elements.push(newWorldElement('location')); },
    value => { value.world.links.push(newWorldLink(value.world.elements[0].id, 'scene', 'extra', '')); },
    value => { value.beats.push({ ...value.beats[0], id: crypto.randomUUID() }); },
    value => { value.characters.push({ ...value.characters[0], id: crypto.randomUUID() }); },
    value => { value.researchNotes.push({ ...value.researchNotes[0], id: crypto.randomUUID() }); },
    value => { value.concept = 'x'; },
    value => { value.world.elements = Array(MAX_WORLD_CANONICAL_NODES).fill(null); },
    value => { value.concept = '\u0001'.repeat(Math.ceil(MAX_WORLD_CANONICAL_BYTES / 6)); },
  ]) {
    const invalid = structuredClone(maximum); change(invalid);
    assert.throws(() => store.save(id, input(invalid, saved.version)));
    assert.throws(() => recovery.put(draftId, { ...copy, data: invalid }));
    assert.throws(() => recovery.put(draftId, { ...copy, pendingSave: { ...copy.pendingSave, data: invalid } }));
    assert.equal(store.db.isTransaction, false);
    assert.deepEqual(store.history(id), [saved]);
    assert.deepEqual(store.db.prepare('SELECT * FROM requests').all(), receipts);
    assert.deepEqual(store.db.prepare('SELECT * FROM development_recovery').all(), rows);
  }
  // Both snapshots satisfy field/text bounds; JSON escaping pushes their
  // combined envelope above the independent 4 MiB transport/safety ceiling.
  const escaped = maximumDevelopment(data, '\u0001');
  validateDevelopment(escaped, store.project());
  assert.ok(Buffer.byteLength(canonicalJson(escaped)) > MAX_CANONICAL_BYTES);
  const tooLarge = recoveryCopy(escaped, saved, { id, ...input(escaped, saved.version) });
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) > MAX_WORLD_CANONICAL_BYTES);
  assert.throws(() => recovery.put(draftId, tooLarge), error => error.code === 'RECOVERY_TOO_LARGE' && error.status === 413);
  assert.deepEqual(store.db.prepare('SELECT * FROM development_recovery').all(), rows);
});

test('ordinary canonical values retain original budgets and qualified v2 values stay bounded', () => {
  assert.equal(MAX_CANONICAL_NODES, 10000);
  assert.equal(MAX_CANONICAL_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_WORLD_CANONICAL_NODES, 40000);
  assert.equal(MAX_WORLD_CANONICAL_BYTES, 4 * 1024 * 1024);
  assert.doesNotThrow(() => canonicalJson(Array(9999).fill(null)));
  assert.throws(() => canonicalJson(Array(10000).fill(null)), /JSON_TOO_LARGE/);
  assert.doesNotThrow(() => canonicalJson('x'.repeat(MAX_CANONICAL_BYTES - 2)));
  assert.throws(() => canonicalJson('x'.repeat(MAX_CANONICAL_BYTES - 1)), /JSON_TOO_LARGE/);
  assert.throws(() => canonicalJson({ schemaVersion: 2, world: Array(10000).fill(null) }), /JSON_TOO_LARGE/);
});

test('authenticated HTTP accepts a maximum world and pending recovery above 2 MiB, enforcing the 4 MiB ceiling', async t => {
  const { directory, config, close, id, draftId, data, input, recoveryCopy } = fixture(t);
  const maximum = maximumDevelopment(data);
  close();
  const server = await startServer({ directory });
  t.after(() => server.close());
  const session = await fetch(server.origin + '/api/session', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.ownerToken }) });
  assert.equal(session.status, 200);
  const cookie = session.headers.getSetCookie()[0].split(';')[0];
  const call = (route, method = 'GET', body) => fetch(server.origin + route, { method, headers: { Cookie: cookie, Origin: server.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const saveRoute = '/api/records/' + encodeURIComponent(id);
  const recoveryRoute = '/api/development-recovery/' + encodeURIComponent(draftId);
  const pending = { id, ...input(maximum) };
  const { id: recordId, ...body } = pending;
  const savedResponse = await call(saveRoute, 'PUT', body);
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.deepEqual(saved.data, maximum);
  const copy = recoveryCopy(maximum, saved, pending);
  assert.ok(Buffer.byteLength(JSON.stringify(copy)) > 2 * 1024 * 1024);
  const put = await call(recoveryRoute, 'PUT', copy);
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), copy);
  assert.deepEqual(await (await call(recoveryRoute)).json(), copy);
  const tooLarge = { ...copy, data: { ...maximum, concept: 'x'.repeat(MAX_RECOVERY_BYTES) } };
  assert.equal((await call(recoveryRoute, 'PUT', tooLarge)).status, 413);
  assert.deepEqual(await (await call(recoveryRoute)).json(), copy);
  assert.deepEqual(await (await call(saveRoute + '/history')).json(), [saved]);
  const replayed = await call(saveRoute, 'PUT', body);
  assert.equal(replayed.status, 200);
  assert.deepEqual(await replayed.json(), { ...saved, replayed: true });
});
