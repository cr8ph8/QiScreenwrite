import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { initialize, WorkspaceStore } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { DevelopmentRecoveryStore, RecoveryStore, DEVELOPMENT_RECOVERY_SCHEMA, MAX_RECOVERY_COPIES } from '../server/recovery.mjs';
import { startServer } from '../server/http.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-development-recovery-'));
  const config = initialize(directory);
  const store = new WorkspaceStore(directory, validateRecord);
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(() => { close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const draftId = `screenplay-draft:${crypto.randomUUID()}`;
  const id = draftId.replace('screenplay-draft:', 'story-development:');
  const projectId = store.project().id;
  const screenplay = { schemaVersion: 2, projectId, sourceHash: null, title: 'Development recovery', format: 'FOUNTAIN', body: 'FADE IN:', status: 'DRAFT' };
  store.save(draftId, { kind: 'screenplay-draft', requestId: 'draft-save', expectedVersion: null, data: screenplay });
  const data = { schemaVersion: 1, projectId, draftId, concept: 'Unsaved concept', logline: '', synopsis: '', outline: '', beats: [], characters: [], worldNotes: '', researchNotes: [] };
  const copy = { schema: DEVELOPMENT_RECOVERY_SCHEMA, projectId, draftId, baseVersion: null, baseSha256: null, data, pendingSave: null, savedAt: '2026-09-01T12:00:00.000Z' };
  const pending = { id, kind: 'story-development', expectedVersion: null, requestId: 'development-save', data: structuredClone(data) };
  return { directory, config, store, close, draftId, id, copy, pending, screenplay, recovery: new DevelopmentRecoveryStore(store) };
}

test('development recovery stores complete envelope separately without adding history or changing receipts', t => {
  const { store, recovery, copy, pending, id } = fixture(t);
  const beforeRecords = store.list();
  const beforeRequests = store.db.prepare('SELECT * FROM requests').all();
  const working = { ...copy, pendingSave: pending, data: { ...copy.data, concept: 'Newer edits after clicking save' } };
  assert.deepEqual(recovery.put(copy.draftId, working), working);
  assert.deepEqual(recovery.list(), [working]);
  assert.deepEqual(recovery.get(copy.draftId), working);
  assert.deepEqual(store.list(), beforeRecords);
  assert.deepEqual(store.history(id), []);
  assert.deepEqual(store.db.prepare('SELECT * FROM requests').all(), beforeRequests);
  assert.deepEqual(new RecoveryStore(store).list(), []);
});

test('development recovery rejects wrong project/draft/schema, unknown base and inconsistent pending requests', t => {
  const { store, recovery, copy, pending, id } = fixture(t);
  const saved = store.save(id, { kind: pending.kind, data: copy.data, expectedVersion: null, requestId: 'base' });
  const based = { ...copy, baseVersion: saved.version, baseSha256: saved.sha256 };
  recovery.put(copy.draftId, based);
  const cases = [
    [c => { c.schema = 'wrong'; }, /RECOVERY_IDENTITY_INVALID/],
    [c => { c.projectId = 'foreign'; }, /RECOVERY_PROJECT_MISMATCH/],
    [c => { c.data.projectId = 'foreign'; }, /STORY_DEVELOPMENT_PROJECT_MISMATCH/],
    [c => { c.data.draftId = `screenplay-draft:${crypto.randomUUID()}`; }, /RECORD_IDENTITY_MISMATCH/],
    [c => { c.baseSha256 = 'f'.repeat(64); }, /RECOVERY_BASE_UNKNOWN/],
    [c => { c.baseVersion = 10; }, /RECOVERY_BASE_UNKNOWN/],
    [c => { c.baseVersion = null; }, /RECOVERY_BASE_INVALID/],
    [c => { c.savedAt = 'not-a-date'; }, /RECOVERY_TIMESTAMP_INVALID/],
    [c => { c.data.concept = 'x'.repeat(4001); }, /STORY_DEVELOPMENT_TEXT_INVALID/],
    [c => { c.pendingSave = { ...pending, id: 'story-development:wrong' }; }, /RECOVERY_PENDING_SAVE_INVALID/],
    [c => { c.pendingSave = { ...pending, kind: 'screenplay-draft' }; }, /RECOVERY_PENDING_SAVE_INVALID/],
    [c => { c.pendingSave = { ...pending, requestId: '../bad' }; }, /RECOVERY_PENDING_SAVE_INVALID/],
    [c => { c.pendingSave = { ...pending, expectedVersion: 1.5 }; }, /NON_CANONICAL_NUMBER/],
    [c => { c.pendingSave = { ...pending, expectedVersion: 10 }; }, /RECOVERY_BASE_UNKNOWN/],
    [c => { c.pendingSave = { ...pending, data: { ...pending.data, projectId: 'foreign' } }; }, /STORY_DEVELOPMENT_PROJECT_MISMATCH/],
    [c => { c.pendingSave = { ...pending, data: { ...pending.data, draftId: `screenplay-draft:${crypto.randomUUID()}` } }; }, /RECORD_IDENTITY_MISMATCH/],
    [c => { c.pendingSave = { ...pending, data: { ...pending.data, concept: '\0' } }; }, /STORY_DEVELOPMENT_TEXT_INVALID/],
    [c => { c.pendingSave = { ...pending, extra: 'unexpected' }; }, /RECOVERY_PENDING_SAVE_INVALID/],
    [c => { delete c.pendingSave; }, /RECOVERY_FIELDS_INVALID/],
  ];
  for (const [change, error] of cases) {
    const bad = structuredClone(based); change(bad);
    assert.throws(() => recovery.put(copy.draftId, bad), error);
  }
  assert.deepEqual(recovery.get(copy.draftId), based);
  const missing = `screenplay-draft:${crypto.randomUUID()}`;
  assert.throws(() => recovery.put(missing, { ...copy, draftId: missing, data: { ...copy.data, draftId: missing } }), /STORY_DEVELOPMENT_DRAFT_UNKNOWN/);
  for (const draftId of ['../outside', 'screenplay-draft:../config.json', 'screenplay-draft:a/b', 'screenplay-draft:nonuuid']) {
    assert.throws(() => recovery.get(draftId), /RECOVERY_DRAFT_ID_INVALID/);
    assert.throws(() => recovery.delete(draftId), /RECOVERY_DRAFT_ID_INVALID/);
  }
});

test('uncertain development saves retain exact request replay and newer edits; conflicting receipt bodies are rejected', t => {
  const { store, recovery, copy, pending, id } = fixture(t);
  const { id: recordId, ...input } = pending;
  const saved = store.save(recordId, input); // response may have been lost
  const working = { ...copy, pendingSave: pending, data: { ...copy.data, concept: 'Typed after save began' } };
  recovery.put(copy.draftId, working);
  assert.deepEqual(recovery.get(copy.draftId), working);
  const replay = store.save(recordId, input);
  assert.equal(replay.replayed, true);
  assert.equal(store.history(id).length, 1);
  assert.equal(replay.sha256, saved.sha256);
  const bad = { ...working, pendingSave: { ...pending, data: working.data } };
  assert.throws(() => recovery.put(copy.draftId, bad), /RECOVERY_PENDING_SAVE_CONFLICT/);
  assert.deepEqual(recovery.get(copy.draftId), working);
  // A reviewed newer base can coexist with the original replayable request.
  const latest = { ...working, baseVersion: 1, baseSha256: saved.sha256, savedAt: '2026-09-01T12:00:01.000Z' };
  assert.deepEqual(recovery.put(copy.draftId, latest), latest);
});

test('development recovery keeps newer copies on stale put/delete and enforces its copy quota', t => {
  const { store, recovery, copy, screenplay } = fixture(t);
  recovery.put(copy.draftId, copy);
  const newer = { ...copy, savedAt: '2026-09-01T12:00:01.000Z', data: { ...copy.data, concept: 'Newer' } };
  recovery.put(copy.draftId, newer);
  assert.throws(() => recovery.put(copy.draftId, copy), /RECOVERY_CONFLICT/);
  assert.throws(() => recovery.put(copy.draftId, { ...newer, data: copy.data }), /RECOVERY_CONFLICT/);
  assert.throws(() => recovery.delete(copy.draftId, copy.savedAt), /RECOVERY_CONFLICT/);
  assert.deepEqual(recovery.put(copy.draftId, newer), newer);
  for (let index = 1; index <= MAX_RECOVERY_COPIES; index++) {
    const draftId = `screenplay-draft:${crypto.randomUUID()}`;
    store.save(draftId, { kind: 'screenplay-draft', data: screenplay, expectedVersion: null, requestId: `draft-${index}` });
    const another = { ...copy, draftId, data: { ...copy.data, draftId } };
    if (index === MAX_RECOVERY_COPIES) assert.throws(() => recovery.put(draftId, another), /RECOVERY_LIMIT_REACHED/);
    else recovery.put(draftId, another);
  }
  assert.equal(recovery.list().length, MAX_RECOVERY_COPIES);
  assert.deepEqual(recovery.get(copy.draftId), newer);
  assert.deepEqual(recovery.delete(copy.draftId, newer.savedAt), { deleted: true });
  assert.equal(recovery.get(copy.draftId), null);
});

test('development recovery survives an authenticated changed-origin restart with pending body intact', async t => {
  const { directory, config, store, close, copy, pending, id } = fixture(t);
  const original = store.history(copy.draftId);
  close();
  let server = await startServer({ directory });
  let blocker;
  t.after(async () => { await server.close(); if (blocker?.listening) await new Promise(resolve => blocker.close(resolve)); });
  const login = async () => {
    const response = await fetch(server.origin + '/api/session', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.ownerToken }) });
    assert.equal(response.status, 200);
    return response.headers.getSetCookie()[0].split(';')[0];
  };
  const route = '/api/development-recovery/' + encodeURIComponent(copy.draftId);
  assert.equal((await fetch(server.origin + route)).status, 401);
  let cookie = await login();
  const call = (url, method = 'GET', value) => fetch(server.origin + url, { method, headers: { Cookie: cookie, Origin: server.origin, 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const working = { ...copy, pendingSave: pending, data: { ...copy.data, concept: 'Newest unsaved development' } };
  assert.equal(await (await call(route)).json(), null);
  assert.equal((await fetch(server.origin + route, { method: 'PUT', headers: { Cookie: cookie, Origin: 'http://foreign.test', 'Content-Type': 'application/json' }, body: JSON.stringify(working) })).status, 403);
  const put = await call(route, 'PUT', working);
  assert.equal(put.status, 200); assert.deepEqual(await put.json(), working);
  assert.deepEqual(await (await call('/api/development-recovery')).json(), [working]);
  assert.deepEqual(await (await call('/api/recovery')).json(), []);
  assert.equal((await call(route, 'PUT', { ...working, data: { ...working.data, concept: 'x'.repeat(2 * 1024 * 1024) } })).status, 413);
  const oldOrigin = server.origin;
  await server.close();
  blocker = http.createServer();
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(Number(new URL(oldOrigin).port), '127.0.0.1', resolve); });
  server = await startServer({ directory });
  assert.notEqual(server.origin, oldOrigin);
  cookie = await login();
  assert.deepEqual(await (await call(route)).json(), working);
  assert.deepEqual(await (await call('/api/development-recovery')).json(), [working]);
  const replay = await call('/api/records/' + encodeURIComponent(id), 'PUT', { kind: pending.kind, expectedVersion: pending.expectedVersion, requestId: pending.requestId, data: pending.data });
  assert.equal(replay.status, 200);
  const replayedAgain = await call('/api/records/' + encodeURIComponent(id), 'PUT', { kind: pending.kind, expectedVersion: pending.expectedVersion, requestId: pending.requestId, data: pending.data });
  assert.equal((await replayedAgain.json()).replayed, true);
  assert.deepEqual(await (await call(route)).json(), working); // save does not discard newer edits
  assert.equal((await call(route + '?savedAt=2026-08-01T00%3A00%3A00.000Z', 'DELETE')).status, 409);
  assert.deepEqual(await (await call(route + '?savedAt=' + encodeURIComponent(copy.savedAt), 'DELETE')).json(), { deleted: true });
  assert.deepEqual(await (await call('/api/development-recovery')).json(), []);
  assert.deepEqual(await (await call('/api/records/' + encodeURIComponent(copy.draftId) + '/history')).json(), original);
});
