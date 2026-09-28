import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, WorkspaceStore, loadConfig, canonicalJson, hashCanonical } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { createBackup, backupChecksum, MAX_BACKUP_BYTES } from '../server/backup.mjs';
import { RecoveryStore, DevelopmentRecoveryStore, RECOVERY_SCHEMA, DEVELOPMENT_RECOVERY_SCHEMA } from '../server/recovery.mjs';
import { createWorld, newWorldElement, newWorldLink } from '../server/world.mjs';
import { PRESERVATION_PREVIEW_SCHEMA, PRESERVATION_PACKAGE_SCHEMA, MAX_PRESERVATION_BYTES,
  preservationPreview, createPreservationPackage, verifyPreservationPackage, readPreservationFile } from '../server/preservation.mjs';
import { main } from '../server/cli.mjs';

const cli = fileURLToPath(new URL('../server/cli.mjs', import.meta.url));
const input = (kind, data, expectedVersion = null) => ({ kind, data, expectedVersion, requestId: crypto.randomUUID() });
const save = (store, id, data, version = null) => store.save(id, input(id.split(':')[0], data, version));
const code = (code, status = 422) => ({ code, status });
function fixture(t, { empty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-preservation-'));
  const directory = path.join(root, 'source'), config = initialize(directory, { title: 'Saved stories 海' });
  const store = new WorkspaceStore(directory, validateRecord);
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = store.project();
  if (empty) return { root, directory, config, store, project, close };
  const draftId = `screenplay-draft:${crypto.randomUUID()}`;
  const developmentId = draftId.replace('screenplay-draft:', 'story-development:');
  const draft = { schemaVersion: 2, projectId: project.id, sourceHash: null, title: 'Harbor 🌊', format: 'FOUNTAIN', body: '\uFEFFINT. ROOM - DAY\r\n\r\n  First.  ', status: 'DRAFT' };
  save(store, draftId, draft);
  const latestDraft = save(store, draftId, { ...draft, title: 'Harbor, revised 🌊', body: 'Second.\n  Keep spacing.\n' }, 1);
  const elements = [newWorldElement('location'), newWorldElement('prop')];
  elements[0].name = 'Harbor 海'; elements[1].name = 'Compass';
  const world = { schemaVersion: 1, elements, links: [newWorldLink(elements[0].id, 'element', elements[1].id, 'Compass')] };
  const worldId = `shared-world:${crypto.randomUUID()}`;
  const base = save(store, worldId, { schemaVersion: 1, projectId: project.id, name: 'Shared harbor', description: '', world });
  const development = { schemaVersion: 3, projectId: project.id, draftId,
    concept: 'Saved concept', logline: '', synopsis: '', outline: '', beats: [], characters: [], worldNotes: '', researchNotes: [],
    world: structuredClone(world), worldSources: [{ worldId, version: base.version, sha256: base.sha256,
      elements: world.elements.map(item => ({ sourceId: item.id, localId: item.id })),
      links: world.links.map(item => ({ sourceId: item.id, localId: item.id })) }] };
  save(store, developmentId, development);
  save(store, worldId, { ...base.data, name: 'Harbor library, revised', world: { ...world, elements: [...elements, newWorldElement('character')] } }, 1);
  const latestDevelopment = save(store, developmentId, { ...development, concept: 'Second saved concept' }, 1);
  const linkId = `sync-link:qimovi:${draftId.split(':')[1]}`;
  save(store, linkId, { schemaVersion: 1, projectId: project.id, draftId, draftVersion: latestDraft.version, draftSha256: latestDraft.sha256,
    target: 'qimovi', remote: { origin: 'http://127.0.0.1:4317', projectId: 'remote:project', projectTitle: 'Remote reference', projectProfile: 'caniscreenwrite-creative/v1', recordId: draftId, version: 3, sha256: latestDraft.sha256 }, linkedAt: '2026-09-27T12:00:00.000Z' });
  const screenplayRecovery = { schema: RECOVERY_SCHEMA, draftId, baseVersion: latestDraft.version, baseSha256: latestDraft.sha256,
    data: { ...draft, body: 'UNSAVED_SCREENPLAY_SECRET' }, savedAt: '2026-09-27T12:00:00.000Z' };
  new RecoveryStore(store).put(draftId, screenplayRecovery);
  new DevelopmentRecoveryStore(store).put(draftId, { schema: DEVELOPMENT_RECOVERY_SCHEMA, projectId: project.id, draftId,
    baseVersion: latestDevelopment.version, baseSha256: latestDevelopment.sha256,
    data: { ...development, concept: 'UNSAVED_DEVELOPMENT_SECRET' },
    pendingSave: { id: developmentId, ...input('story-development', { ...development, concept: 'PENDING_SAVE_SECRET' }, 2) }, savedAt: '2026-09-27T12:00:00.000Z' });
  fs.writeFileSync(path.join(directory, 'connections.json'), JSON.stringify({ ownerToken: 'CONNECTOR_SECRET' }), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'unrelated-owner-file'), 'UNRELATED_OWNER_SECRET');
  return { root, directory, config, store, project, close, draftId, developmentId, worldId, linkId, draft, screenplayRecovery };
}

// Independent wire-format implementation lets tests rehash dishonest metadata,
// rather than merely demonstrating that stale checksums fail.
function frames(domain, values) {
  const hash = crypto.createHash('sha256').update(domain + '\n');
  for (const value of values) {
    const text = canonicalJson(value);
    hash.update(String(Buffer.byteLength(text)) + ':'); hash.update(text);
  }
  return hash.digest('hex');
}
function rehash(value) {
  value.sha256 = frames(PRESERVATION_PACKAGE_SCHEMA, [{ schema: value.schema, scope: value.scope, createdAt: value.createdAt,
    sourceSha256: value.sourceSha256, exclusions: value.exclusions, readme: value.readme,
    inventoryCount: value.inventory.length, backupSha256: value.backup.sha256 }, ...value.inventory]);
  return value;
}
function rebind(value) {
  const records = [...value.backup.records].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version);
  for (const record of records) record.sha256 = hashCanonical(record.data);
  value.backup.sha256 = backupChecksum(value.backup);
  value.sourceSha256 = frames('caniscreenwrite-preservation-source/v1', [{ project: value.backup.project, revisionCount: records.length },
    ...records.map(({ id, kind, version, sha256 }) => ({ id, kind, version, sha256 }))]);
  const latest = new Map(records.map(record => [record.id, record]));
  value.inventory = [...latest.values()].map(({ id, kind, version, sha256, data }) => ({ id, kind, version, sha256,
    title: kind === 'screenplay-draft' ? data.title : kind === 'shared-world' ? data.name : latest.get(data.draftId)?.data.title ?? id }));
  return rehash(value);
}
const writePackage = (f, value, name = 'preservation.json') => {
  const filename = path.join(f.root, name); fs.writeFileSync(filename, JSON.stringify(value)); return filename;
};

test('preview describes only saved latest records, counts both recovery tables and never reads private files', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.directory, 'workspace.sqlite'));
  const files = fs.readdirSync(f.directory);
  t.mock.method(fs, 'readFileSync', () => { throw new Error('Unexpected filesystem read'); });
  const preview = preservationPreview(f.store);
  const value = createPreservationPackage(f.store, preview.sourceSha256);
  assert.deepEqual(Object.keys(preview).sort(), ['schema', 'project', 'sourceSha256', 'inventory', 'revisionCount', 'recoveryCounts', 'exclusions'].sort());
  assert.equal(preview.schema, PRESERVATION_PREVIEW_SCHEMA);
  assert.deepEqual(preview.project, { id: f.project.id, title: f.project.title });
  assert.deepEqual(preview.recoveryCounts, { screenplay: 1, development: 1 });
  assert.equal(preview.revisionCount, 7);
  assert.deepEqual(preview.inventory, f.store.list().map(record => ({ id: record.id, kind: record.kind, version: record.version, sha256: record.sha256,
    title: record.kind === 'shared-world' ? record.data.name : f.store.current(f.draftId).data.title })));
  assert.deepEqual(value.inventory, preview.inventory);
  assert.equal(value.scope, 'SAVED_WRITER_WORKSPACE');
  const text = JSON.stringify({ preview, value, summary: verifyPreservationPackage(value) });
  for (const secret of [f.config.ownerToken, 'CONNECTOR_SECRET', 'UNSAVED_SCREENPLAY_SECRET', 'UNSAVED_DEVELOPMENT_SECRET', 'PENDING_SAVE_SECRET', 'UNRELATED_OWNER_SECRET', 'ownerToken', 'requestId', f.directory]) assert.equal(text.includes(secret), false, secret);
  assert.match(value.readme, /verify-preservation --file/);
  assert.match(value.readme, /restore --data NEW_DIR/);
  assert.equal(verifyPreservationPackage(value).limitations.length, 3);
  assert.equal(rehash(structuredClone(value)).sha256, value.sha256);
  t.mock.restoreAll();
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'workspace.sqlite')), before);
  assert.deepEqual(fs.readdirSync(f.directory), files);
});

test('package CLI restore roundtrips exact history, bytes, project identity and old v3 world bases', async t => {
  const f = fixture(t), preview = preservationPreview(f.store);
  const value = createPreservationPackage(f.store, preview.sourceSha256), before = fs.readFileSync(path.join(f.directory, 'workspace.sqlite'));
  const filename = writePackage(f, value), target = path.join(f.root, 'restored');
  assert.deepEqual(readPreservationFile(filename), value);
  const summary = await main(['verify-preservation', '--file', filename]);
  assert.deepEqual(summary, { valid: true, schema: PRESERVATION_PACKAGE_SCHEMA, project: preview.project,
    sourceSha256: preview.sourceSha256, packageSha256: value.sha256, recordCount: 4, revisionCount: 7,
    exclusions: value.exclusions, checks: { recordHashes: true, history: true, sourceBindings: true, packageHash: true }, limitations: summary.limitations });
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 4096);
  assert.equal((await main(['restore', '--data', target, '--file', filename])).revisions, 7);
  const restored = new WorkspaceStore(target, validateRecord);
  try {
    assert.deepEqual(restored.project(), f.project);
    assert.deepEqual(restored.list(), f.store.list());
    for (const { id } of value.inventory) assert.deepEqual(restored.history(id), f.store.history(id));
    assert.equal(restored.history(f.draftId)[0].data.body, f.draft.body);
    assert.equal(restored.current(f.developmentId).data.worldSources[0].version, 1);
    assert.equal(restored.current(f.worldId).version, 2);
    assert.equal(preservationPreview(restored).sourceSha256, preview.sourceSha256);
    assert.deepEqual(new RecoveryStore(restored).list(), []);
    assert.deepEqual(new DevelopmentRecoveryStore(restored).list(), []);
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS count FROM requests').get().count, 0);
    assert.equal(save(restored, f.draftId, { ...f.draft, body: 'Third revision' }, 2).version, 3);
  } finally { restored.close(); }
  assert.notEqual(loadConfig(target).ownerToken, f.config.ownerToken);
  assert.equal(fs.existsSync(path.join(target, 'connections.json')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'workspace.sqlite')), before);
});

test('fingerprint ignores export times and record order, but binds project and every historical identity', t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T12:00:00.000Z') });
  const first = createPreservationPackage(f.store);
  t.mock.timers.tick(1000);
  const second = createPreservationPackage(f.store, first.sourceSha256);
  assert.notEqual(first.backup.createdAt, second.backup.createdAt);
  assert.notEqual(first.backup.sha256, second.backup.sha256);
  assert.equal(first.sourceSha256, second.sourceSha256);
  assert.notEqual(first.sha256, second.sha256);
  const reversed = structuredClone(first); reversed.backup.records.reverse();
  reversed.backup.sha256 = backupChecksum(reversed.backup); rehash(reversed);
  assert.equal(verifyPreservationPackage(reversed).sourceSha256, first.sourceSha256);
  const historical = structuredClone(first);
  historical.backup.records.find(record => record.id === f.draftId && record.version === 1).data.body = 'Different earlier body';
  rebind(historical);
  assert.notEqual(historical.sourceSha256, first.sourceSha256);
  assert.deepEqual(historical.inventory, first.inventory);
  assert.equal(verifyPreservationPackage(historical).valid, true); // Integrity is not authenticity.
  for (const field of ['id', 'kind', 'version', 'sha256']) {
    const bad = structuredClone(first), earlier = bad.backup.records.find(record => record.id === f.draftId && record.version === 1);
    earlier[field] = field === 'version' ? 10 : field === 'sha256' ? 'f'.repeat(64) : `${earlier[field]}x`;
    bad.backup.sha256 = backupChecksum(bad.backup); rehash(bad);
    assert.throws(() => verifyPreservationPackage(bad));
  }
  const changedProject = structuredClone(first); changedProject.backup.project.title = 'Another saved project title'; rebind(changedProject);
  assert.notEqual(changedProject.sourceSha256, first.sourceSha256);
  assert.equal(verifyPreservationPackage(changedProject).valid, true);
  const shuffled = Object.fromEntries(Object.entries(first).reverse());
  shuffled.inventory = first.inventory.map(row => Object.fromEntries(Object.entries(row).reverse()));
  assert.equal(verifyPreservationPackage(shuffled).packageSha256, first.sha256);
});

test('any supplied expected hash is enforced; recovery edits do not stale a preview but saved revisions do', t => {
  const f = fixture(t), preview = preservationPreview(f.store);
  for (const expected of [null, '', false, 0, {}, 'F'.repeat(64), 'a'.repeat(63)]) {
    assert.throws(() => createPreservationPackage(f.store, expected), code('PRESERVATION_SOURCE_INVALID'));
  }
  assert.throws(() => createPreservationPackage(f.store, '0'.repeat(64)), code('PRESERVATION_SOURCE_CHANGED', 409));
  new RecoveryStore(f.store).put(f.draftId, { ...f.screenplayRecovery, savedAt: '2026-09-27T13:00:00.000Z', data: { ...f.draft, body: 'New unsaved recovery' } });
  assert.equal(createPreservationPackage(f.store, preview.sourceSha256).sourceSha256, preview.sourceSha256);
  const current = f.store.current(f.worldId);
  save(f.store, f.worldId, current.data, current.version); // Even identical bytes create a new identity.
  assert.throws(() => createPreservationPackage(f.store, preview.sourceSha256), code('PRESERVATION_SOURCE_CHANGED', 409));
  assert.notEqual(preservationPreview(f.store).sourceSha256, preview.sourceSha256);
});

test('exact envelope, inventory, README, exclusions and checksums reject dishonest rehashed claims', async t => {
  const f = fixture(t), value = createPreservationPackage(f.store);
  const cases = [
    [v => { v.schema = 'caniscreenwrite-preservation-package/v999'; }, 'PRESERVATION_SCHEMA_INVALID'],
    [v => { v.scope = 'MEDIA_ARCHIVE'; }, 'PRESERVATION_SCHEMA_INVALID'],
    [v => { v.createdAt = '2026-02-30T00:00:00.000Z'; }, 'PRESERVATION_TIMESTAMP_INVALID'],
    [v => { v.flags = { valid: true }; }, 'PRESERVATION_SCHEMA_INVALID'],
    [v => { v.checks = { sourceBindings: true }; }, 'PRESERVATION_SCHEMA_INVALID'],
    [v => { v.sourceSha256 = 'f'.repeat(64); }, 'PRESERVATION_SOURCE_MISMATCH'],
    [v => { v.inventory.pop(); }, 'PRESERVATION_INVENTORY_INVALID'],
    [v => { v.inventory.push(v.inventory[0]); }, 'PRESERVATION_INVENTORY_INVALID'],
    [v => { v.inventory.reverse(); }, 'PRESERVATION_INVENTORY_MISMATCH'],
    [v => { v.inventory[0].title = 'Dishonest title'; }, 'PRESERVATION_INVENTORY_MISMATCH'],
    [v => { v.inventory[0].version--; }, 'PRESERVATION_INVENTORY_MISMATCH'],
    [v => { v.inventory[0].id = 'screenplay-draft:foreign'; }, 'PRESERVATION_INVENTORY_MISMATCH'],
    [v => { v.inventory[0].kind = 'shared-world'; }, 'PRESERVATION_INVENTORY_MISMATCH'],
    [v => { v.inventory[0].sha256 = 'f'.repeat(64); }, 'PRESERVATION_INVENTORY_MISMATCH'],
    [v => { v.inventory[0].extra = true; }, 'PRESERVATION_INVENTORY_MISMATCH'],
    [v => { v.readme = 'All media and production authority are preserved.'; }, 'PRESERVATION_README_INVALID'],
    [v => { v.exclusions = []; }, 'PRESERVATION_EXCLUSIONS_INVALID'],
    [v => { v.backup.extra = 'credential'; }, 'BACKUP_SCHEMA_INVALID'],
    [v => { v.backup.records[0].data.body = 'Corrupt bytes'; }, 'BACKUP_RECORD_CHECKSUM_MISMATCH'],
    [v => { v.backup.records[0].extra = true; }, 'BACKUP_RECORD_INVALID'],
    [v => { v.backup.project.title = 'Dishonest project'; }, 'BACKUP_CHECKSUM_MISMATCH'],
  ];
  for (let index = 0; index < cases.length; index++) {
    const [mutate, expected] = cases[index], bad = structuredClone(value); mutate(bad); rehash(bad);
    assert.throws(() => verifyPreservationPackage(bad), code(expected));
    const target = path.join(f.root, `bad-${index}`), filename = writePackage(f, bad, `bad-${index}.json`);
    await assert.rejects(main(['restore', '--data', target, '--file', filename]), code(expected));
    assert.equal(fs.existsSync(target), false);
  }
  const missing = structuredClone(value); delete missing.readme;
  assert.throws(() => verifyPreservationPackage(missing), code('PRESERVATION_SCHEMA_INVALID'));
  assert.throws(() => verifyPreservationPackage({ ...value, sha256: 'f'.repeat(64) }), code('PRESERVATION_CHECKSUM_MISMATCH'));
  assert.throws(() => verifyPreservationPackage({ ...value, sha256: 'not-a-hash' }), code('PRESERVATION_CHECKSUM_INVALID'));
  for (const bad of [null, [], {}, 'package']) assert.throws(() => verifyPreservationPackage(bad), code('PRESERVATION_SCHEMA_INVALID'));
});

test('fully rehashed backup corruption still fails record contracts, complete history and v3 source bindings', t => {
  const f = fixture(t), value = createPreservationPackage(f.store);
  const development = v => v.backup.records.find(record => record.id === f.developmentId && record.version === 2);
  const cases = [
    [v => { v.backup.records = v.backup.records.filter(record => record.id !== f.worldId); }, 'WORLD_SOURCE_REVISION_UNKNOWN'],
    [v => { development(v).data.worldSources[0].version = 0; }, 'WORLD_SOURCE_VERSION_INVALID'],
    [v => { development(v).data.worldSources[0].version = 3; }, 'WORLD_SOURCE_REVISION_UNKNOWN'],
    [v => { development(v).data.worldSources[0].sha256 = 'f'.repeat(64); }, 'WORLD_SOURCE_HASH_MISMATCH'],
    [v => { development(v).data.worldSources[0].elements.pop(); }, 'WORLD_SOURCE_ELEMENTS_MISMATCH'],
    [v => { development(v).data.worldSources[0].links = []; }, 'WORLD_SOURCE_LINKS_MISMATCH'],
    [v => { development(v).data.extra = true; }, 'STORY_DEVELOPMENT_FIELDS_INVALID'],
    [v => { development(v).data.projectId = 'foreign:project'; }, 'STORY_DEVELOPMENT_PROJECT_MISMATCH'],
    [v => { v.backup.records.push(structuredClone(v.backup.records[0])); }, 'BACKUP_HISTORY_INVALID'],
    [v => { v.backup.records = v.backup.records.filter(record => !(record.id === f.draftId && record.version === 1)); }, 'BACKUP_HISTORY_INVALID'],
    [v => { v.backup.records = v.backup.records.filter(record => record.id !== f.draftId); }, 'STORY_DEVELOPMENT_DRAFT_UNKNOWN'],
    [v => { v.backup.records.find(record => record.id === f.draftId).data.ownerToken = 'secret'; }, 'SCREENPLAY_DRAFT_FIELDS_INVALID'],
  ];
  for (const [mutate, expected] of cases) {
    const bad = structuredClone(value); mutate(bad); rebind(bad);
    assert.throws(() => verifyPreservationPackage(bad), code(expected));
  }
});

test('empty saved workspace and v3 with zero linked sources verify without creating recovery tables', t => {
  const f = fixture(t, { empty: true }), before = fs.readFileSync(path.join(f.directory, 'workspace.sqlite'));
  const preview = preservationPreview(f.store), value = createPreservationPackage(f.store, preview.sourceSha256);
  assert.deepEqual(preview.inventory, []);
  assert.equal(preview.revisionCount, 0);
  assert.deepEqual(preview.recoveryCounts, { screenplay: 0, development: 0 });
  assert.equal(verifyPreservationPackage(value).recordCount, 0);
  assert.equal(verifyPreservationPackage(value).revisionCount, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'workspace.sqlite')), before);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('recovery', 'development_recovery')").get().n, 0);
  const draftId = `screenplay-draft:${crypto.randomUUID()}`;
  save(f.store, draftId, { schemaVersion: 2, projectId: f.project.id, sourceHash: null, title: 'Unlinked', body: '', format: 'FOUNTAIN', status: 'DRAFT' });
  save(f.store, draftId.replace('screenplay-draft:', 'story-development:'), { schemaVersion: 3, projectId: f.project.id, draftId,
    concept: '', logline: '', synopsis: '', outline: '', beats: [], characters: [], worldNotes: '', researchNotes: [], world: createWorld(), worldSources: [] });
  assert.equal(verifyPreservationPackage(createPreservationPackage(f.store)).recordCount, 2);
});

test('reader uses exact UTF-8 and nofollow; changed, nonregular and oversized files are refused', t => {
  const f = fixture(t), value = createPreservationPackage(f.store), filename = writePackage(f, value);
  const cases = [Buffer.from('{'), Buffer.concat([Buffer.from('{"bad":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(value))]), Buffer.from(JSON.stringify(value) + '{}')];
  for (let index = 0; index < cases.length; index++) {
    const invalid = path.join(f.root, `bytes-${index}`); fs.writeFileSync(invalid, cases[index]);
    assert.throws(() => readPreservationFile(invalid), code('PRESERVATION_JSON_INVALID'));
  }
  const link = path.join(f.root, 'link'); fs.symlinkSync(filename, link);
  assert.throws(() => readPreservationFile(link), error => error.code === 'ELOOP');
  assert.throws(() => readPreservationFile(f.directory), code('PRESERVATION_FILE_INVALID'));
  const oversized = path.join(f.root, 'oversized');
  const fd = fs.openSync(oversized, 'wx'); fs.ftruncateSync(fd, MAX_PRESERVATION_BYTES + 1); fs.closeSync(fd);
  assert.throws(() => readPreservationFile(oversized), code('PRESERVATION_TOO_LARGE', 413));
  const read = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', function (...args) {
    if (!changed) { changed = true; fs.appendFileSync(filename, ' '); }
    return read.apply(this, args);
  });
  assert.throws(() => readPreservationFile(filename), code('PRESERVATION_FILE_CHANGED'));
});

test('verification rejects non-JSON accessors, hidden fields, sparse arrays and depth without executing code', t => {
  const f = fixture(t), value = createPreservationPackage(f.store);
  let reads = 0;
  const getter = () => { reads++; throw new Error('Accessor executed'); };
  const cases = [
    v => Object.defineProperty(v, 'backup', { enumerable: true, get: getter }),
    v => Object.defineProperty(v.inventory, '0', { enumerable: true, get: getter }),
    v => Object.defineProperty(v.backup.records[0].data, 'body', { enumerable: true, get: getter }),
    v => Object.defineProperty(v, 'hidden', { value: true }),
    v => { v.inventory[Symbol('secret')] = true; },
    v => { delete v.inventory[0]; },
    v => { v.inventory.extra = true; },
    v => { Object.setPrototypeOf(v.backup, { inherited: true }); },
    v => { v.backup.records[0].data.body = '\ud800'; },
    v => { v.toJSON = () => value; },
    v => { v.deep = v; },
    v => { v.inventory[0].version = -0; },
  ];
  for (const mutate of cases) {
    const bad = structuredClone(value); mutate(bad);
    assert.throws(() => verifyPreservationPackage(bad), code('PRESERVATION_JSON_INVALID'));
  }
  assert.equal(reads, 0);
  assert.throws(() => verifyPreservationPackage({ ...value, readme: 'x'.repeat(MAX_PRESERVATION_BYTES) }), code('PRESERVATION_TOO_LARGE', 413));
  assert.throws(() => verifyPreservationPackage({ ...value, inventory: Array(MAX_PRESERVATION_BYTES + 1) }), code('PRESERVATION_TOO_LARGE', 413));
});

test('CLI verifies read-only without data/config and preserves legacy restore and every existing destination', async t => {
  const f = fixture(t), value = createPreservationPackage(f.store), filename = writePackage(f, value);
  const cwd = path.join(f.root, 'clean-cwd'); fs.mkdirSync(cwd);
  const before = fs.readFileSync(path.join(f.directory, 'workspace.sqlite'));
  const run = spawnSync(process.execPath, [cli, 'verify-preservation', '--file', filename], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).packageSha256, value.sha256);
  assert.deepEqual(fs.readdirSync(cwd), []);
  await assert.rejects(main(['verify-preservation']), code('PRESERVATION_FILE_REQUIRED', 400));
  await assert.rejects(main(['restore', '--file', filename]), code('RESTORE_ARGUMENTS_REQUIRED', 400));
  const empty = path.join(f.root, 'empty'); fs.mkdirSync(empty);
  const file = path.join(f.root, 'existing-file'); fs.writeFileSync(file, 'keep');
  const link = path.join(f.root, 'existing-link'); fs.symlinkSync(f.directory, link);
  const dangling = path.join(f.root, 'dangling'); fs.symlinkSync(path.join(f.root, 'absent'), dangling);
  for (const target of [f.directory, empty, file, link, dangling]) {
    await assert.rejects(main(['restore', '--data', target, '--file', filename]), code('RESTORE_DESTINATION_EXISTS', 409));
  }
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'workspace.sqlite')), before);
  assert.deepEqual(fs.readdirSync(empty), []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  assert.equal(fs.readlinkSync(link), f.directory);
  assert.equal(fs.readlinkSync(dangling), path.join(f.root, 'absent'));
  const legacy = createBackup(f.store), legacyFile = writePackage(f, legacy, 'legacy.json');
  assert.throws(() => readPreservationFile(legacyFile), code('PRESERVATION_SCHEMA_INVALID'));
  assert.deepEqual(readPreservationFile(legacyFile, { allowLegacyBackup: true }), legacy);
  const legacyTarget = path.join(f.root, 'legacy-restored');
  assert.equal((await main(['restore', '--data', legacyTarget, '--file', legacyFile])).revisions, 7);
});

test('128 MiB applies to the entire generated package even when its real saved backup fits', t => {
  const f = fixture(t, { empty: true });
  assert.equal(MAX_PRESERVATION_BYTES, 128 * 1024 * 1024);
  assert.equal(MAX_BACKUP_BYTES, MAX_PRESERVATION_BYTES);
  // Long legal IDs/titles make inventory overhead larger than backup's spare
  // envelope allowance. Escaped body bytes exercise byte (not character) limits.
  const data = { schemaVersion: 2, projectId: f.project.id, sourceHash: null, title: 't'.repeat(200), format: 'FOUNTAIN', body: '', status: 'DRAFT' };
  const fixed = Buffer.byteLength(canonicalJson(data)) + 512;
  let used = 0, index = 0;
  while (MAX_BACKUP_BYTES - 1024 - used > fixed + 6) {
    const length = Math.min(200000, Math.floor((MAX_BACKUP_BYTES - 1024 - used - fixed) / 6));
    const record = { ...data, body: '\u0001'.repeat(length) };
    const id = `screenplay-draft:${String(index++).padStart(160 - 'screenplay-draft:'.length, '0')}`;
    save(f.store, id, record);
    used += Buffer.byteLength(canonicalJson(record)) + 512;
  }
  assert.ok(createBackup(f.store).records.length > 100);
  assert.throws(() => createPreservationPackage(f.store), code('PRESERVATION_TOO_LARGE', 413));
});
