import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialize, WorkspaceStore } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { RecoveryStore, RECOVERY_SCHEMA, MAX_RECOVERY_COPIES } from '../server/recovery.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-recovery-'));
  initialize(directory);
  const store = new WorkspaceStore(directory, validateRecord);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const recovery = new RecoveryStore(store);
  const copy = { schema: RECOVERY_SCHEMA, draftId: 'screenplay-draft:new', baseVersion: null, baseSha256: null, data: { schemaVersion: 2, projectId: store.project().id, sourceHash: null, title: 'Unsaved', format: 'FOUNTAIN', body: '\uFEFFINT. ROOM - DAY\r\n\r\nUnsaved 🌠', status: 'DRAFT' }, savedAt: '2026-09-01T12:00:00.000Z' };
  return { directory, store, recovery, copy };
}

test('unsaved recovery persists across database reopen without canonical records or request receipts', t => {
  const { directory, store, recovery, copy } = fixture(t);
  assert.deepEqual(recovery.put(copy.draftId, copy), copy);
  assert.deepEqual(recovery.list(), [copy]);
  assert.deepEqual(store.history(copy.draftId), []);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
  const second = new WorkspaceStore(directory, validateRecord);
  try { assert.deepEqual(new RecoveryStore(second).get(copy.draftId), copy); }
  finally { second.close(); }
  assert.deepEqual(recovery.delete(copy.draftId), { deleted: true });
  assert.deepEqual(recovery.delete(copy.draftId), { deleted: false });
  assert.equal(recovery.get(copy.draftId), null);
});

test('recovery validates project, schema, base hash/version, timestamps, body limits and safe identity', t => {
  const { recovery, copy, store } = fixture(t);
  const invalid = [
    [c => { c.schema = 'wrong'; }, /RECOVERY_IDENTITY_INVALID/],
    [c => { c.draftId = 'screenplay-draft:other'; }, /RECOVERY_IDENTITY_INVALID/],
    [c => { c.data.projectId = 'foreign'; }, /PROJECT_MISMATCH/],
    [c => { c.baseVersion = 1; }, /RECOVERY_BASE_INVALID/],
    [c => { c.baseSha256 = 'f'.repeat(64); }, /RECOVERY_BASE_INVALID/],
    [c => { c.baseVersion = 1; c.baseSha256 = 'f'.repeat(64); }, /RECOVERY_BASE_UNKNOWN/],
    [c => { c.savedAt = '2026-02-30T12:00:00.000Z'; }, /RECOVERY_TIMESTAMP_INVALID/],
    [c => { c.savedAt = '2100-01-01T12:00:00.000Z'; }, /RECOVERY_TIMESTAMP_INVALID/],
    [c => { c.data.body = 'a'.repeat(200001); }, /BODY_INVALID/],
    [c => { c.data.body = '\ud800'; }, /BODY_INVALID/],
    [c => { c.extra = 'credential'; }, /RECOVERY_FIELDS_INVALID/],
  ];
  for (const [change, error] of invalid) {
    const bad = structuredClone(copy); change(bad);
    assert.throws(() => recovery.put(copy.draftId, bad), error);
  }
  for (const id of ['../escape', 'screenplay-draft:../../config.json', 'screenplay-draft:a/b', 'screenplay-draft:a\\b', 'screenplay-draft:%2f', 'screenplay-draft:', 'sync-link:one']) {
    assert.throws(() => recovery.put(id, { ...copy, draftId: id }), /RECOVERY_DRAFT_ID_INVALID/);
    assert.throws(() => recovery.get(id), /RECOVERY_DRAFT_ID_INVALID/);
    assert.throws(() => recovery.delete(id), /RECOVERY_DRAFT_ID_INVALID/);
  }
  const v1 = store.save(copy.draftId, { kind: 'screenplay-draft', expectedVersion: null, requestId: 'v1', data: copy.data });
  const v2 = store.save(copy.draftId, { kind: 'screenplay-draft', expectedVersion: 1, requestId: 'v2', data: { ...copy.data, body: 'Saved twice' } });
  const fromOldBase = { ...copy, baseVersion: 1, baseSha256: v1.sha256 };
  recovery.put(copy.draftId, fromOldBase);
  assert.deepEqual(recovery.get(copy.draftId), fromOldBase);
  assert.deepEqual(store.current(copy.draftId), v2);
});

test('delayed puts and conditional deletes preserve newer unresolved recovery', t => {
  const { recovery, copy } = fixture(t);
  recovery.put(copy.draftId, copy);
  const newer = { ...copy, savedAt: '2026-09-01T12:00:01.000Z', data: { ...copy.data, body: 'More unsaved work' } };
  recovery.put(copy.draftId, newer);
  assert.throws(() => recovery.put(copy.draftId, copy), /RECOVERY_CONFLICT/);
  assert.throws(() => recovery.put(copy.draftId, { ...newer, data: copy.data }), /RECOVERY_CONFLICT/);
  assert.throws(() => recovery.delete(copy.draftId, copy.savedAt), /RECOVERY_CONFLICT/);
  assert.deepEqual(recovery.get(copy.draftId), newer);
  assert.deepEqual(recovery.put(copy.draftId, newer), newer); // exact replay
  assert.deepEqual(recovery.delete(copy.draftId, newer.savedAt), { deleted: true });
});

test('bounded recovery refuses overflow without evicting authored copies, and detects disk corruption', t => {
  const { recovery, copy, store } = fixture(t);
  for (let index = 0; index < MAX_RECOVERY_COPIES; index++) {
    const draftId = `screenplay-draft:${index}`;
    recovery.put(draftId, { ...copy, draftId });
  }
  assert.throws(() => recovery.put(copy.draftId, copy), /RECOVERY_LIMIT_REACHED/);
  assert.equal(recovery.list().length, MAX_RECOVERY_COPIES);
  const first = 'screenplay-draft:0';
  recovery.put(first, { ...copy, draftId: first, savedAt: '2026-09-01T12:00:01.000Z' });
  store.db.prepare('UPDATE recovery SET sha256=? WHERE draft_id=?').run('f'.repeat(64), first);
  assert.throws(() => recovery.get(first), /RECOVERY_CORRUPT/);
});

test('aggregate byte quota rejects a copy before replacing existing content', t => {
  const { recovery, copy } = fixture(t);
  const large = { ...copy, data: { ...copy.data, body: '界'.repeat(200000) } };
  let accepted = 0;
  for (let index = 0; index < MAX_RECOVERY_COPIES; index++) {
    const draftId = `screenplay-draft:large-${index}`;
    try { recovery.put(draftId, { ...large, draftId }); accepted++; }
    catch (error) { assert.equal(error.code, 'RECOVERY_LIMIT_REACHED'); break; }
  }
  assert.ok(accepted > 0 && accepted < MAX_RECOVERY_COPIES);
  assert.equal(recovery.list().length, accepted);
  assert.deepEqual(recovery.get('screenplay-draft:large-0').data, large.data);
});
