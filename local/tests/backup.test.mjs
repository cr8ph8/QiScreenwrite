import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialize, WorkspaceStore, hashCanonical, loadConfig, acquireLock } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { createBackup, restoreWorkspace, validateBackup, backupChecksum, readBackup } from '../server/backup.mjs';
import { RecoveryStore, RECOVERY_SCHEMA } from '../server/recovery.mjs';
import { main } from '../server/cli.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const config = initialize(source);
  const store = new WorkspaceStore(source, validateRecord);
  const project = store.project();
  const data = { schemaVersion: 2, projectId: project.id, sourceHash: null, title: 'Desk', format: 'FOUNTAIN', body: '\uFEFFINT. ROOM - DAY\r\n\r\nFirst.', status: 'DRAFT' };
  store.save('screenplay-draft:one', { kind: 'screenplay-draft', data, requestId: 'save1', expectedVersion: null });
  const latest = store.save('screenplay-draft:one', { kind: 'screenplay-draft', data: { ...data, body: 'Second. 🌠' }, requestId: 'save2', expectedVersion: 1 });
  const link = { schemaVersion: 1, projectId: project.id, draftId: latest.id, draftVersion: latest.version, draftSha256: latest.sha256, target: 'qimovi', remote: { origin: 'http://127.0.0.1:4317', projectId: 'remote:project', projectTitle: 'Remote', projectProfile: 'caniscreenwrite-creative/v1', recordId: latest.id, version: 3, sha256: latest.sha256 }, linkedAt: new Date().toISOString() };
  store.save('sync-link:qimovi:one', { kind: 'sync-link', data: link, requestId: 'link1', expectedVersion: null });
  new RecoveryStore(store).put('screenplay-draft:new', { schema: RECOVERY_SCHEMA, draftId: 'screenplay-draft:new', baseVersion: null, baseSha256: null, data: { ...data, body: 'Unsaved recovery' }, savedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(source, 'connections.json'), JSON.stringify({ ownerToken: 'connector-secret' }), { mode: 0o600 });
  const backup = createBackup(store);
  const history = store.history(latest.id);
  store.close();
  return { root, source, config, project, backup, history };
}

test('backup includes all exact revisions and project; restore keeps hashes/history, rotates credentials and appends', t => {
  const { root, source, config, backup, project, history } = fixture(t);
  assert.equal(backup.records.length, 3);
  assert.deepEqual(backup.project, project);
  const text = JSON.stringify(backup);
  for (const secret of [config.ownerToken, 'connector-secret', 'ownerToken', 'Unsaved recovery', 'requestId']) assert.equal(text.includes(secret), false);
  const target = path.join(root, 'restored');
  assert.equal(restoreWorkspace(target, backup).revisions, 3);
  assert.notEqual(loadConfig(target).ownerToken, config.ownerToken);
  assert.equal(fs.statSync(target).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(target, 'config.json')).mode & 0o077, 0);
  assert.equal(fs.existsSync(path.join(target, 'connections.json')), false);
  const restored = new WorkspaceStore(target, validateRecord);
  try {
    assert.deepEqual(restored.history('screenplay-draft:one'), history);
    assert.deepEqual(restored.project(), project);
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
    assert.deepEqual(new RecoveryStore(restored).list(), []);
    assert.throws(() => restored.db.exec('DELETE FROM records'), /IMMUTABLE_RECORD/);
    assert.equal(restored.save('screenplay-draft:one', { kind: 'screenplay-draft', data: { ...history[1].data, body: 'Third' }, requestId: 'new-save', expectedVersion: 2 }).version, 3);
  } finally { restored.close(); }
  const original = new WorkspaceStore(source, validateRecord);
  try { assert.deepEqual(original.history('screenplay-draft:one'), history); }
  finally { original.close(); }
});

test('tampering, wrong schema, invalid records, duplicate/gapped versions and unknown references are refused before restore', t => {
  const { root, backup } = fixture(t);
  const cases = [
    [b => { b.records[0].data.body = 'tampered'; }, /BACKUP_RECORD_CHECKSUM_MISMATCH/],
    [b => { b.project.title = 'altered'; }, /BACKUP_CHECKSUM_MISMATCH/],
    [b => { b.schema = 'caniscreenwrite-local-writer-backup/v99'; }, /BACKUP_SCHEMA_INVALID/],
    [b => { b.createdAt = 'yesterday'; }, /BACKUP_TIMESTAMP_INVALID/],
    [b => { b.records[1].version = 3; }, /BACKUP_HISTORY_INVALID/],
    [b => { b.records.push(structuredClone(b.records[0])); }, /BACKUP_HISTORY_INVALID/],
    [b => { b.records[0].id = '../outside'; }, /BACKUP_RECORD_ID_INVALID/],
    [b => { b.records[0].version = 1.5; }, /BACKUP_VERSION_INVALID/],
    [b => { b.records[0].data.projectId = 'foreign'; b.records[0].sha256 = hashCanonical(b.records[0].data); }, /PROJECT_MISMATCH/],
    [b => { b.records[0].data.schemaVersion = 3; b.records[0].sha256 = hashCanonical(b.records[0].data); }, /AUTHORITY_INVALID/],
    [b => { b.records[2].data.draftSha256 = 'f'.repeat(64); b.records[2].sha256 = hashCanonical(b.records[2].data); }, /SYNC_LINK_DRAFT_REVISION_UNKNOWN/],
    [b => { b.project.ownerToken = 'secret'; }, /INVALID_PROJECT/],
    [b => { b.credentials = {}; }, /BACKUP_SCHEMA_INVALID/],
  ];
  cases.forEach(([change, error], index) => {
    const bad = structuredClone(backup); change(bad);
    const target = path.join(root, `bad-${index}`);
    assert.throws(() => restoreWorkspace(target, bad), error);
    assert.equal(fs.existsSync(target), false);
  });
  // Re-signing malformed history does not bypass record contract checks.
  const bad = structuredClone(backup);
  bad.records[0].data.extra = true;
  bad.records[0].sha256 = hashCanonical(bad.records[0].data);
  bad.sha256 = backupChecksum(bad);
  assert.throws(() => validateBackup(bad), /SCREENPLAY_DRAFT_FIELDS_INVALID/);
});

test('restore refuses existing directories/files/symlinks without changing original history', t => {
  const { root, source, backup } = fixture(t);
  const empty = path.join(root, 'empty'); fs.mkdirSync(empty);
  const file = path.join(root, 'existing'); fs.writeFileSync(file, 'keep');
  const link = path.join(root, 'link'); fs.symlinkSync(source, link);
  const dangling = path.join(root, 'dangling'); fs.symlinkSync(path.join(root, 'absent'), dangling);
  const original = fs.readFileSync(path.join(source, 'workspace.sqlite'));
  for (const target of [source, empty, file, link, dangling]) assert.throws(() => restoreWorkspace(target, backup), /RESTORE_DESTINATION_EXISTS/);
  assert.deepEqual(fs.readFileSync(path.join(source, 'workspace.sqlite')), original);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(empty), []);
});

test('CLI writes private portable JSON without overwriting and requires an explicit new restore destination', async t => {
  const { root, source, backup } = fixture(t);
  const output = path.join(root, 'backup.json');
  const result = await main(['backup', '--data', source, '--out', output]);
  assert.equal(result.revisions, backup.records.length);
  assert.equal(fs.statSync(output).mode & 0o077, 0);
  assert.equal(readBackup(output).records.length, 3);
  await assert.rejects(main(['backup', '--data', source, '--out', output]), /BACKUP_DESTINATION_EXISTS/);
  assert.equal(readBackup(output).sha256, result.sha256);
  await assert.rejects(main(['restore', '--file', output]), /RESTORE_ARGUMENTS_REQUIRED/);
  const target = path.join(root, 'cli-restored');
  assert.equal((await main(['restore', '--data', target, '--file', output])).restored, true);
  await assert.rejects(main(['restore', '--data', target, '--file', output]), /RESTORE_DESTINATION_EXISTS/);
  const unlock = acquireLock(source);
  try { await assert.rejects(main(['backup', '--data', source, '--out', path.join(root, 'running.json')]), /LOCAL_WRITER_ALREADY_RUNNING/); }
  finally { unlock(); }
  assert.equal(fs.existsSync(path.join(root, 'running.json')), false);
  const malformed = path.join(root, 'bad.json'); fs.writeFileSync(malformed, '{');
  await assert.rejects(main(['restore', '--data', path.join(root, 'invalid'), '--file', malformed]), /BACKUP_JSON_INVALID/);
  assert.equal(fs.existsSync(path.join(root, 'invalid')), false);
});

test('development history validates related drafts and restores every revision regardless of input order', t => {
  const { root, source, project, backup: original } = fixture(t);
  const store = new WorkspaceStore(source, validateRecord);
  const suffix = '11111111-2222-4333-8444-555555555555';
  const draftId = `screenplay-draft:${suffix}`;
  const id = `story-development:${suffix}`;
  let backup;
  let expected;
  try {
    store.save(draftId, { kind: 'screenplay-draft', expectedVersion: null, requestId: 'development-draft', data: original.records[0].data });
    const data = { schemaVersion: 1, projectId: project.id, draftId, concept: 'A recovered concept', logline: '', synopsis: '', outline: '', beats: [], characters: [], worldNotes: '', researchNotes: [] };
    store.save(id, { kind: 'story-development', expectedVersion: null, requestId: 'development-1', data });
    store.save(id, { kind: 'story-development', expectedVersion: 1, requestId: 'development-2', data: { ...data, concept: 'A second concept' } });
    expected = store.history(id);
    backup = createBackup(store);
  } finally { store.close(); }
  backup.records.reverse();
  backup.sha256 = backupChecksum(backup);
  validateBackup(backup);
  const target = path.join(root, 'development-restored');
  restoreWorkspace(target, backup);
  const restored = new WorkspaceStore(target, validateRecord);
  try { assert.deepEqual(restored.history(id), expected); }
  finally { restored.close(); }
  const missingDraft = structuredClone(backup);
  missingDraft.records = missingDraft.records.filter(record => record.id !== draftId);
  missingDraft.sha256 = backupChecksum(missingDraft);
  assert.throws(() => validateBackup(missingDraft), /STORY_DEVELOPMENT_DRAFT_UNKNOWN/);
});

test('a restore transaction failure rolls back every inserted record and removes only its new destination', t => {
  const { root, source, backup } = fixture(t);
  const target = path.join(root, 'failed-transaction');
  const original = fs.readFileSync(path.join(source, 'workspace.sqlite'));
  const exec = DatabaseSync.prototype.exec;
  const close = WorkspaceStore.prototype.close;
  let rolledBack = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql === 'COMMIT') throw new Error('INJECTED_COMMIT_FAILURE');
    return exec.call(this, sql);
  });
  t.mock.method(WorkspaceStore.prototype, 'close', function () {
    if (this.directory === target) {
      assert.equal(this.db.isTransaction, false);
      assert.equal(this.db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 0);
      assert.equal(this.db.prepare('SELECT COUNT(*) AS n FROM metadata').get().n, 0);
      rolledBack = true;
    }
    return close.call(this);
  });
  assert.throws(() => restoreWorkspace(target, backup), /INJECTED_COMMIT_FAILURE/);
  assert.equal(rolledBack, true);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readFileSync(path.join(source, 'workspace.sqlite')), original);
});

test('failed restore cleanup preserves a workspace initialized immediately after its lock is released', t => {
  const { root, backup } = fixture(t);
  const target = path.join(root, 'successor-workspace');
  const exec = DatabaseSync.prototype.exec;
  const unlink = fs.unlinkSync;
  let failed = false;
  let successor = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql === 'COMMIT' && !failed) { failed = true; throw new Error('INJECTED_COMMIT_FAILURE'); }
    return exec.call(this, sql);
  });
  t.mock.method(fs, 'unlinkSync', function (filename) {
    const result = unlink.call(this, filename);
    if (filename === path.join(target, 'process.lock') && !successor) {
      successor = true;
      initialize(target, { title: 'Successor must survive' });
    }
    return result;
  });
  assert.throws(() => restoreWorkspace(target, backup), /INJECTED_COMMIT_FAILURE/);
  assert.equal(successor, true);
  const store = new WorkspaceStore(target, validateRecord);
  try {
    assert.equal(store.project().title, 'Successor must survive');
    assert.deepEqual(store.list(), []);
    assert.equal(loadConfig(target).ownerActorId, 'local-owner');
  } finally { store.close(); }
});
