import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialize, loadConfig, WorkspaceStore, canonicalJson, hashCanonical, acquireLock } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'writer-storage-'));
const draft = (project, body = 'INT. ROOM - DAY\n\nA desk.') => ({ schemaVersion: 2, projectId: project.id, sourceHash: null, title: 'Test', format: 'FOUNTAIN', body, status: 'DRAFT' });

test('initialize creates a private config and default project, idempotently', () => {
  const dir = temp();
  const first = initialize(dir, { title: 'Desk' });
  const second = initialize(dir);
  assert.equal(first.ownerToken, second.ownerToken);
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o077, 0);
  assert.equal(fs.statSync(dir).mode & 0o077, 0);
  const store = new WorkspaceStore(dir);
  assert.equal(store.project().title, 'Desk');
  store.close();
  assert.equal(loadConfig(dir).ownerActorId, 'local-owner');
});

test('canonical JSON sorts keys and rejects non-canonical numbers', () => {
  assert.equal(canonicalJson({ b: [1, { z: 'x', a: null }], a: true }), '{"a":true,"b":[1,{"a":null,"z":"x"}]}');
  assert.throws(() => canonicalJson({ n: 1.5 }), /NON_CANONICAL_NUMBER/);
  assert.equal(hashCanonical({ a: 1 }).length, 64);
});

test('save enforces CAS, replays identical requests and keeps history immutable', () => {
  const dir = temp(); initialize(dir);
  const store = new WorkspaceStore(dir, validateRecord);
  const project = store.project();
  const id = 'screenplay-draft:one';
  const v1 = store.save(id, { kind: 'screenplay-draft', expectedVersion: null, requestId: 'r1', data: draft(project) });
  assert.equal(v1.version, 1); assert.equal(v1.replayed, false);
  const replay = store.save(id, { kind: 'screenplay-draft', expectedVersion: null, requestId: 'r1', data: draft(project) });
  assert.equal(replay.replayed, true); assert.equal(replay.sha256, v1.sha256);
  assert.throws(() => store.save(id, { kind: 'screenplay-draft', expectedVersion: null, requestId: 'r1', data: draft(project, 'changed') }), /REQUEST_ID_CONFLICT/);
  assert.throws(() => store.save(id, { kind: 'screenplay-draft', expectedVersion: null, requestId: 'r2', data: draft(project, 'changed') }), /VERSION_CONFLICT/);
  const v2 = store.save(id, { kind: 'screenplay-draft', expectedVersion: 1, requestId: 'r2', data: draft(project, 'changed') });
  assert.equal(v2.version, 2);
  assert.deepEqual(store.history(id).map(r => r.version), [1, 2]);
  assert.equal(store.list('screenplay-draft').length, 1);
  assert.equal(store.current(id).data.body, 'changed');
  assert.throws(() => store.db.prepare('DELETE FROM records').run(), /IMMUTABLE_RECORD/);
  assert.throws(() => store.db.prepare("UPDATE records SET data='x'").run(), /IMMUTABLE_RECORD/);
  store.close();
});

test('contracts reject foreign fields, wrong project and unsupported kinds', () => {
  const dir = temp(); initialize(dir);
  const store = new WorkspaceStore(dir, validateRecord);
  const project = store.project();
  const put = (id, kind, data) => store.save(id, { kind, expectedVersion: null, requestId: `req-${Math.random()}`, data });
  assert.throws(() => put('screenplay-draft:a', 'screenplay-draft', { ...draft(project), extra: 1 }), /SCREENPLAY_DRAFT_FIELDS_INVALID/);
  assert.throws(() => put('screenplay-draft:b', 'screenplay-draft', { ...draft(project), projectId: 'other' }), /SCREENPLAY_DRAFT_PROJECT_MISMATCH/);
  assert.throws(() => put('screenplay-draft:c', 'screenplay-draft', { ...draft(project), status: 'FINAL' }), /SCREENPLAY_DRAFT_AUTHORITY_INVALID/);
  assert.throws(() => put('note:c', 'note', { x: 1 }), /UNSUPPORTED_RECORD_KIND/);
  assert.throws(() => put('screenplay-draft:d', 'sync-link', { x: 1 }), /RECORD_IDENTITY_MISMATCH/);
  const ok = put('screenplay-draft:e', 'screenplay-draft', { ...draft(project), logline: 'A writer.', projectFormat: 'feature', targetPages: 90 });
  assert.equal(ok.data.logline, 'A writer.');
  // A link must reference a revision the workspace holds.
  const link = { schemaVersion: 1, projectId: project.id, draftId: 'screenplay-draft:e', draftVersion: 1, draftSha256: ok.sha256, target: 'qimovi', remote: { origin: 'http://127.0.0.1:4317', projectId: 'creative-project:x', projectTitle: 'X', projectProfile: 'caniscreenwrite-creative/v1', recordId: 'screenplay-draft:e', version: 1, sha256: ok.sha256 }, linkedAt: new Date().toISOString() };
  assert.throws(() => put('sync-link:qimovi:e', 'sync-link', { ...link, draftSha256: 'a'.repeat(64) }), /SYNC_LINK_DRAFT_REVISION_UNKNOWN/);
  assert.equal(put('sync-link:qimovi:e', 'sync-link', link).kind, 'sync-link');
  store.close();
});

test('process lock excludes a second live writer', () => {
  const dir = temp(); initialize(dir);
  const release = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /LOCAL_WRITER_ALREADY_RUNNING/);
  release();
  acquireLock(dir)();
});

test('initializer refuses an active lock and does not create credentials or a database', t => {
  const dir = temp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const release = acquireLock(dir);
  try {
    assert.throws(() => initialize(dir), /LOCAL_WRITER_ALREADY_RUNNING/);
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'workspace.sqlite')), false);
  } finally { release(); }
  initialize(dir);
});

test('dead-owner lock is reclaimed; malformed and symlink locks fail closed', t => {
  const dir = temp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  const lock = path.join(dir, 'process.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, nonce: 'old' }));
  const release = acquireLock(dir);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  assert.throws(() => acquireLock(dir), /LOCAL_WRITER_ALREADY_RUNNING/);
  release();
  fs.writeFileSync(lock, 'bad');
  assert.throws(() => acquireLock(dir), /PROCESS_LOCK_REQUIRES_INSPECTION/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'bad');
  fs.unlinkSync(lock);
  const target = path.join(dir, 'other-file');
  fs.writeFileSync(target, JSON.stringify({ pid: deadPid, nonce: 'keep' }));
  fs.symlinkSync(target, lock);
  assert.throws(() => acquireLock(dir), /PROCESS_LOCK_REQUIRES_INSPECTION/);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).nonce, 'keep');
});

test('workspace store refuses live and dangling database symlinks', t => {
  const root = temp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'workspace.sqlite');
  const outside = path.join(root, 'outside.sqlite');
  fs.symlinkSync(outside, filename);
  assert.throws(() => new WorkspaceStore(root), /WORKSPACE_FILE_INVALID/);
  assert.equal(fs.existsSync(outside), false);
  fs.writeFileSync(outside, 'preserve');
  assert.throws(() => new WorkspaceStore(root), /WORKSPACE_FILE_INVALID/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
});
