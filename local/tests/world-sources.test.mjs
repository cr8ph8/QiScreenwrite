import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, WorkspaceStore, canonicalJson, hashCanonical, sha256, MAX_CANONICAL_BYTES, MAX_CANONICAL_NODES, MAX_WORLD_CANONICAL_BYTES, MAX_WORLD_CANONICAL_NODES } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { validateDevelopment } from '../server/development.mjs';
import { WORLD_SOURCE_LIMITS, validateWorldSources } from '../server/world-sources.mjs';
import { createWorld, newWorldElement, newWorldLink, worldTextLength } from '../server/world.mjs';
import { createBackup, validateBackup, backupChecksum, restoreWorkspace } from '../server/backup.mjs';
import { DevelopmentRecoveryStore, DEVELOPMENT_RECOVERY_SCHEMA, MAX_RECOVERY_BYTES } from '../server/recovery.mjs';
import { worldExports } from '../server/qimovi.mjs';
import { universeSource, mapUniverse } from '../server/qimovi-universe.mjs';
import { startServer } from '../server/http.mjs';

const legacyData = (projectId = 'local-writer:fixture', draftId = 'screenplay-draft:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') => ({
  schemaVersion: 1, projectId, draftId, concept: 'Exact 🌊\n  text', logline: '', synopsis: '', outline: '', beats: [], characters: [], worldNotes: '', researchNotes: [],
});
const input = (data, expectedVersion = null, requestId = crypto.randomUUID(), kind = 'story-development') => ({ kind, data, expectedVersion, requestId });
const nodeCount = value => 1 + (value && typeof value === 'object' ? Object.values(value).reduce((sum, child) => sum + nodeCount(child), 0) : 0);
const error = code => ({ code, status: 422 });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-world-sources-'));
  const directory = path.join(root, 'source'), config = initialize(directory);
  const store = new WorkspaceStore(directory, validateRecord);
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });
  const projectId = store.project().id, draftId = `screenplay-draft:${crypto.randomUUID()}`;
  const id = draftId.replace('screenplay-draft:', 'story-development:');
  store.save(draftId, input({ schemaVersion: 2, projectId, sourceHash: null, title: 'Linked worlds', format: 'FOUNTAIN', body: 'FADE IN:', status: 'DRAFT' }, null, crypto.randomUUID(), 'screenplay-draft'));
  const legacy = legacyData(projectId, draftId);
  const saveWorld = (world, worldId = `shared-world:${crypto.randomUUID()}`) => store.save(worldId, input({ schemaVersion: 1, projectId, name: 'Shared reference', description: '', world }, null, crypto.randomUUID(), 'shared-world'));
  const copy = (data, base = null, pendingSave = null) => ({ schema: DEVELOPMENT_RECOVERY_SCHEMA, projectId, draftId, baseVersion: base?.version ?? null, baseSha256: base?.sha256 ?? null, data, pendingSave, savedAt: '2026-09-01T12:00:00.000Z' });
  return { root, directory, config, store, close, projectId, draftId, id, legacy, saveWorld, copy };
}
function smallWorld() {
  const elements = [newWorldElement('location'), newWorldElement('prop')];
  elements[0].name = 'Harbor 海';
  return { schemaVersion: 1, elements, links: [newWorldLink(elements[0].id, 'element', elements[1].id, 'Compass')] };
}
function sourceRef(base, remap = false) {
  return { worldId: base.id, version: base.version, sha256: base.sha256,
    elements: base.data.world.elements.map(item => ({ sourceId: item.id, localId: remap ? crypto.randomUUID() : item.id })),
    links: base.data.world.links.map(item => ({ sourceId: item.id, localId: remap ? crypto.randomUUID() : item.id })),
  };
}
function linked(legacy, base, remap = false) {
  const source = sourceRef(base, remap), world = structuredClone(base.data.world);
  const ids = new Map([...source.elements, ...source.links].map(item => [item.sourceId, item.localId]));
  world.elements.forEach(item => { item.id = ids.get(item.id); });
  world.links.forEach(item => { item.id = ids.get(item.id); item.elementId = ids.get(item.elementId); item.targetRef = ids.get(item.targetRef); });
  return { ...legacy, schemaVersion: 3, world, worldSources: [source] };
}
const state = store => ({ records: store.db.prepare('SELECT * FROM records ORDER BY id,version').all(), requests: store.db.prepare('SELECT * FROM requests ORDER BY id').all(), recovery: store.db.prepare('SELECT * FROM development_recovery ORDER BY draft_id').all() });

test('v1/v2 canonical hashes and exact schemas remain unchanged when v3 is added', t => {
  const legacy = legacyData(), v2 = { ...legacy, schemaVersion: 2, world: createWorld() };
  // Captured from the unmodified backend before implementing v3.
  assert.equal(hashCanonical(legacy), 'cb011719c31ed6091272872e98d2194f77ee32dae2bbd32ef4778cb137008a00');
  assert.equal(hashCanonical(v2), '2379795baed42352b68698ab730ef3ba8dc07ec0e7d945aae69f7450a633ddc4');
  for (const data of [legacy, v2]) {
    assert.equal(validateDevelopment(data), data);
    assert.throws(() => validateDevelopment({ ...data, worldSources: [] }), error('STORY_DEVELOPMENT_FIELDS_INVALID'));
  }
  assert.throws(() => validateDevelopment({ ...v2, schemaVersion: 3 }), error('STORY_DEVELOPMENT_FIELDS_INVALID'));
  assert.equal(validateDevelopment({ ...v2, schemaVersion: 3, worldSources: [] }).schemaVersion, 3);
  const f = fixture(t), first = f.store.save(f.id, input(f.legacy));
  const second = f.store.save(f.id, input({ ...f.legacy, schemaVersion: 2, world: createWorld() }, 1));
  const third = f.store.save(f.id, input({ ...second.data, schemaVersion: 3, worldSources: [] }, 2));
  assert.deepEqual(f.store.history(f.id), [first, second, third]);
  assert.equal(Object.hasOwn(first.data, 'world'), false);
  assert.equal(Object.hasOwn(second.data, 'worldSources'), false);
});

test('linked v3 uses immutable bases through CAS, replay, reopen, backup restore and independent recovery', t => {
  const f = fixture(t), base = f.saveWorld(smallWorld()), data = linked(f.legacy, base, true);
  const request = input(data), first = f.store.save(f.id, request);
  const changedBase = structuredClone(base.data);
  changedBase.world.elements.push(newWorldElement('character'));
  f.store.save(base.id, input(changedBase, 1, crypto.randomUUID(), 'shared-world'));
  // Source revision 1 remains the base even after the library changes.
  const next = structuredClone(data); next.world.elements[0].description = 'Local edit';
  const second = f.store.save(f.id, input(next, first.version));
  assert.deepEqual(f.store.save(f.id, request), { ...first, replayed: true });
  assert.throws(() => f.store.save(f.id, input(data, 1)), { code: 'VERSION_CONFLICT' });
  assert.throws(() => f.store.save(f.id, { ...request, data: next }), { code: 'REQUEST_ID_CONFLICT' });
  assert.equal(first.sha256, hashCanonical(data));
  const recovery = new DevelopmentRecoveryStore(f.store), pending = { id: f.id, ...request };
  const copy = f.copy({ ...next, concept: 'Newer unsaved text' }, first, pending);
  const before = state(f.store);
  assert.deepEqual(recovery.put(f.draftId, copy), copy);
  assert.deepEqual(state(f.store).records, before.records);
  assert.deepEqual(state(f.store).requests, before.requests);
  const backup = createBackup(f.store);
  assert.equal(validateBackup(backup), backup);
  const destination = path.join(f.root, 'restored');
  assert.equal(restoreWorkspace(destination, backup).revisions, 5);
  const restored = new WorkspaceStore(destination, validateRecord);
  try {
    assert.deepEqual(restored.history(f.id), [first, second]);
    assert.equal(restored.save(f.id, input(data, second.version)).version, 3);
    assert.deepEqual(new DevelopmentRecoveryStore(restored).list(), []);
  } finally { restored.close(); }
  f.close();
  const reopened = new WorkspaceStore(f.directory, validateRecord);
  try {
    assert.deepEqual(reopened.history(f.id), [first, second]);
    assert.deepEqual(reopened.save(f.id, request), { ...first, replayed: true });
    assert.deepEqual(new DevelopmentRecoveryStore(reopened).get(f.draftId), copy);
  } finally { reopened.close(); }
});

test('standalone validation allows explicit published identity, case-insensitive source sets and local tombstones', t => {
  const f = fixture(t), base = f.saveWorld(smallWorld()), data = linked(f.legacy, base);
  for (const item of [...data.worldSources[0].elements, ...data.worldSources[0].links]) {
    assert.equal(item.sourceId, item.localId);
    item.sourceId = item.sourceId.toUpperCase(); item.localId = item.localId.toUpperCase();
  }
  data.worldSources[0].elements.reverse();
  const before = canonicalJson(data);
  assert.equal(validateDevelopment(data, f.store.project(), { id: f.id, store: f.store }), data);
  assert.equal(canonicalJson(data), before);
  data.world = createWorld();
  assert.equal(validateWorldSources(data.worldSources, data.world, { projectId: f.projectId, store: f.store }), data.worldSources);
  assert.deepEqual(f.store.save(f.id, input(data)).data, data);
});

test('source and mapping shapes reject accessors without invoking them, sparse arrays and nonplain objects', t => {
  const f = fixture(t), data = linked(f.legacy, f.saveWorld(smallWorld()));
  let reads = 0;
  const getter = () => { reads++; throw new Error('Getter executed'); };
  const cases = [
    value => { Object.defineProperty(value, 'worldSources', { enumerable: true, get: getter }); },
    value => { Object.defineProperty(value.worldSources, '0', { enumerable: true, get: getter }); },
    value => { Object.defineProperty(value.worldSources[0], 'version', { enumerable: true, get: getter }); },
    value => { Object.defineProperty(value.worldSources[0].elements, '0', { enumerable: true, get: getter }); },
    value => { Object.defineProperty(value.worldSources[0].elements[0], 'sourceId', { enumerable: true, get: getter }); },
    value => { delete value.worldSources[0]; },
    value => { delete value.worldSources[0].links[0]; },
    value => { value.worldSources.extra = true; },
    value => { value.worldSources[0].elements[Symbol('extra')] = true; },
    value => { value.worldSources[0].links[0].extra = true; },
    value => { Object.setPrototypeOf(value.worldSources, null); },
    value => { Object.setPrototypeOf(value.worldSources[0], { inherited: true }); },
    value => { Object.setPrototypeOf(value.worldSources[0].elements, null); },
    value => { Object.defineProperty(value.worldSources[0].elements[0], 'localId', { enumerable: false }); },
  ];
  for (const mutate of cases) {
    const invalid = structuredClone(data); mutate(invalid);
    assert.throws(() => validateDevelopment(invalid), e => e.status === 422 && /^(WORLD_SOURCE_|STORY_DEVELOPMENT_FIELDS_INVALID)/.test(e.code));
  }
  assert.equal(reads, 0);
  const plain = structuredClone(data);
  Object.setPrototypeOf(plain.worldSources[0], null);
  Object.setPrototypeOf(plain.worldSources[0].elements[0], null);
  assert.equal(validateDevelopment(plain), plain);
});

test('invalid references and duplicate, foreign, incomplete or wrong-kind mappings do not mutate any saved state', t => {
  const f = fixture(t), base = f.saveWorld(smallWorld()), data = linked(f.legacy, base, true);
  const saved = f.store.save(f.id, input(data));
  const recovery = new DevelopmentRecoveryStore(f.store), copy = f.copy(data, saved);
  recovery.put(f.draftId, copy);
  const before = state(f.store);
  const cases = [
    ['WORLD_SOURCE_LIST_INVALID', d => { d.worldSources = null; }],
    ['WORLD_SOURCE_FIELDS_INVALID', d => { d.worldSources[0].extra = true; }],
    ['WORLD_SOURCE_ID_INVALID', d => { d.worldSources[0].worldId = base.id.toUpperCase(); }],
    ['WORLD_SOURCE_VERSION_INVALID', d => { d.worldSources[0].version = 0; }],
    ['WORLD_SOURCE_VERSION_INVALID', d => { d.worldSources[0].version = 2147483647; }],
    ['WORLD_SOURCE_VERSION_INVALID', d => { d.worldSources[0].version = 1.5; }],
    ['WORLD_SOURCE_HASH_INVALID', d => { d.worldSources[0].sha256 = 'A'.repeat(64); }],
    ['WORLD_SOURCE_REVISION_UNKNOWN', d => { d.worldSources[0].worldId = `shared-world:${crypto.randomUUID()}`; }],
    ['WORLD_SOURCE_REVISION_UNKNOWN', d => { d.worldSources[0].version = 2; }],
    ['WORLD_SOURCE_HASH_MISMATCH', d => { d.worldSources[0].sha256 = '0'.repeat(64); }],
    ['WORLD_SOURCE_DUPLICATE', d => { d.worldSources.push({ ...structuredClone(d.worldSources[0]), worldId: 'shared-world:' + base.id.slice(13).toUpperCase() }); }],
    ['WORLD_SOURCE_MAPPING_FIELDS_INVALID', d => { d.worldSources[0].elements[0].extra = true; }],
    ['WORLD_SOURCE_MAPPING_ID_INVALID', d => { d.worldSources[0].elements[0].sourceId = 'foreign'; }],
    ['WORLD_SOURCE_MAPPING_ID_INVALID', d => { d.worldSources[0].links[0].localId = null; }],
    ['WORLD_SOURCE_SOURCE_ID_DUPLICATE', d => { d.worldSources[0].elements[1].sourceId = d.worldSources[0].elements[0].sourceId.toUpperCase(); }],
    ['WORLD_SOURCE_SOURCE_ID_DUPLICATE', d => { d.worldSources[0].links[0].sourceId = d.worldSources[0].elements[0].sourceId.toUpperCase(); }],
    ['WORLD_SOURCE_LOCAL_ID_DUPLICATE', d => { d.worldSources[0].elements[1].localId = d.worldSources[0].elements[0].localId.toUpperCase(); }],
    ['WORLD_SOURCE_LOCAL_KIND_MISMATCH', d => { d.worldSources[0].elements[0].localId = d.world.links[0].id.toUpperCase(); }],
    ['WORLD_SOURCE_LOCAL_KIND_MISMATCH', d => { d.worldSources[0].elements = []; d.worldSources[0].links[0].localId = d.world.elements[0].id.toUpperCase(); }],
    ['WORLD_SOURCE_ELEMENTS_MISMATCH', d => { d.worldSources[0].elements.pop(); }],
    ['WORLD_SOURCE_LINKS_MISMATCH', d => { d.worldSources[0].links = []; }],
    ['WORLD_SOURCE_ELEMENTS_MISMATCH', d => { d.worldSources[0].elements[0].sourceId = crypto.randomUUID(); }],
    ['WORLD_SOURCE_LINKS_MISMATCH', d => { d.worldSources[0].links[0].sourceId = crypto.randomUUID(); }],
  ];
  for (const [code, mutate] of cases) {
    const invalid = structuredClone(data); mutate(invalid);
    assert.throws(() => validateDevelopment(invalid, f.store.project(), { id: f.id, store: f.store }), error(code));
    // Fractional numbers fail the existing serializer before contract dispatch.
    const saveCode = code === 'WORLD_SOURCE_VERSION_INVALID' && invalid.worldSources[0].version === 1.5 ? 'NON_CANONICAL_NUMBER' : code;
    assert.throws(() => f.store.save(f.id, input(invalid, saved.version)), { code: saveCode });
    assert.throws(() => recovery.put(f.draftId, { ...copy, data: invalid }), { code: saveCode });
    assert.throws(() => recovery.put(f.draftId, { ...copy, pendingSave: { id: f.id, ...input(invalid, saved.version) } }), { code: saveCode });
    assert.deepEqual(state(f.store), before);
    assert.equal(f.store.db.isTransaction, false);
  }
});

test('base history must belong to the exact world, project, kind and hash; current is never a substitute', t => {
  const f = fixture(t), base = f.saveWorld(smallWorld()), data = linked(f.legacy, base);
  const validate = (record, sources = data.worldSources) => validateWorldSources(sources, data.world, { projectId: f.projectId, store: {
    history: id => { assert.equal(id, base.id); return record ? [record] : []; },
    current: () => { throw new Error('Must use history'); },
  } });
  assert.doesNotThrow(() => validate(base));
  assert.throws(() => validate(null), error('WORLD_SOURCE_REVISION_UNKNOWN'));
  assert.throws(() => validate({ ...base, id: `shared-world:${crypto.randomUUID()}` }), error('WORLD_SOURCE_REVISION_MISMATCH'));
  assert.throws(() => validate({ ...base, kind: 'story-development' }), error('WORLD_SOURCE_REVISION_MISMATCH'));
  assert.throws(() => validate({ ...base, data: { ...base.data, projectId: 'foreign-project' } }), error('WORLD_SOURCE_PROJECT_MISMATCH'));
  assert.throws(() => validate({ ...base, data: { ...base.data, description: 'Tampered bytes' } }), error('WORLD_SOURCE_HASH_MISMATCH'));
  const second = f.saveWorld(smallWorld()), secondRef = sourceRef(second);
  secondRef.elements[0].localId = data.worldSources[0].elements[0].localId.toUpperCase();
  assert.throws(() => validateWorldSources([...data.worldSources, secondRef], data.world), error('WORLD_SOURCE_LOCAL_ID_DUPLICATE'));
});

test('rehashed backups cannot omit source revisions or forge complete lineage, and restore creates no destination', t => {
  const f = fixture(t), base = f.saveWorld(smallWorld()), data = linked(f.legacy, base);
  const first = f.store.save(f.id, input(data));
  f.store.save(f.id, input({ ...data, worldSources: [] }, first.version));
  const original = createBackup(f.store);
  for (const mutate of [
    backup => { backup.records = backup.records.filter(record => record.id !== base.id); },
    backup => { backup.records.find(record => record.id === f.id && record.version === 1).data.worldSources[0].elements.pop(); },
    backup => { backup.records.find(record => record.id === f.id && record.version === 1).data.worldSources[0].links[0].sourceId = crypto.randomUUID(); },
    backup => { backup.records.find(record => record.id === f.id && record.version === 1).data.worldSources[0].sha256 = '0'.repeat(64); },
  ]) {
    const backup = structuredClone(original); mutate(backup);
    for (const record of backup.records) record.sha256 = hashCanonical(record.data);
    backup.sha256 = backupChecksum(backup);
    assert.throws(() => validateBackup(backup), e => e.status === 422 && e.code.startsWith('WORLD_SOURCE_'));
    const destination = path.join(f.root, crypto.randomUUID());
    assert.throws(() => restoreWorkspace(destination, backup), e => e.code.startsWith('WORLD_SOURCE_'));
    assert.equal(fs.existsSync(destination), false);
  }
  assert.deepEqual(createBackup(f.store).records, original.records);
  const recovery = new DevelopmentRecoveryStore(f.store), invalid = f.copy(data, first);
  invalid.data = structuredClone(data); invalid.data.worldSources[0].links = [];
  const text = canonicalJson(invalid);
  f.store.db.prepare('INSERT INTO development_recovery VALUES(?,?,?,?)').run(f.draftId, text, sha256(text), invalid.savedAt);
  assert.throws(() => recovery.get(f.draftId), error('WORLD_SOURCE_LINKS_MISMATCH'));
  assert.deepEqual(createBackup(f.store).records, original.records);
});

function maximum(f) {
  const world = createWorld(), worldSources = [];
  for (let index = 0; index < 32; index++) {
    const elements = Array.from({ length: index < 12 ? 10 : 9 }, () => newWorldElement('location'));
    const links = Array.from({ length: index < 8 ? 32 : 31 }, () => newWorldLink(elements[0].id, 'element', elements[1].id, ''));
    const base = f.saveWorld({ schemaVersion: 1, elements, links });
    world.elements.push(...structuredClone(elements)); world.links.push(...structuredClone(links));
    worldSources.push(sourceRef(base));
  }
  let remaining = 164000;
  for (const element of world.elements) { element.description = '界'.repeat(Math.min(8000, remaining)); remaining -= element.description.length; }
  return { ...f.legacy, schemaVersion: 3, concept: '', world, worldSources,
    beats: Array.from({ length: 200 }, (_, index) => ({ id: crypto.randomUUID(), title: '', description: index < 50 ? '界'.repeat(4000) : '' })),
    characters: Array.from({ length: 100 }, () => ({ id: crypto.randomUUID(), name: '', role: '', description: '', arc: '' })),
    researchNotes: Array.from({ length: 100 }, () => ({ id: crypto.randomUUID(), title: '', notes: '', source: '' })),
  };
}

test('32 sources plus 300/1000 mappings, maximum development and independent pending recovery fit unchanged budgets', t => {
  const f = fixture(t), data = maximum(f);
  assert.deepEqual(WORLD_SOURCE_LIMITS, { sources: 32, elements: 300, links: 1000 });
  assert.equal(worldTextLength(data.world), 200000);
  assert.equal(nodeCount(data), 16009);
  assert.equal(validateDevelopment(data, f.store.project(), { id: f.id, store: f.store }), data);
  const request = input(data), pending = { id: f.id, ...request }, saved = f.store.save(f.id, request);
  const working = structuredClone(data); working.world.elements[0].description = '改' + working.world.elements[0].description.slice(1);
  const copy = f.copy(working, saved, pending);
  assert.notDeepEqual(copy.data, pending.data);
  assert.equal(nodeCount(copy), 32030);
  const serialized = canonicalJson(copy);
  assert.ok(Buffer.byteLength(serialized) > MAX_CANONICAL_BYTES);
  assert.ok(Buffer.byteLength(serialized) <= MAX_RECOVERY_BYTES);
  const { replayed, ...record } = saved;
  for (const value of [data, request, pending, saved, record, { ...saved, replayed: true }, copy]) assert.deepEqual(JSON.parse(canonicalJson(value)), value);
  const recovery = new DevelopmentRecoveryStore(f.store);
  assert.deepEqual(recovery.put(f.draftId, copy), copy);
  assert.deepEqual(recovery.get(f.draftId), copy);
  assert.deepEqual(f.store.save(f.id, request), { ...saved, replayed: true });
  const destination = path.join(f.root, 'maximum-restored');
  restoreWorkspace(destination, createBackup(f.store));
  const restored = new WorkspaceStore(destination, validateRecord);
  try { assert.deepEqual(restored.current(f.id), saved); }
  finally { restored.close(); }
  const before = state(f.store);
  for (const [code, change] of [
    ['WORLD_SOURCE_LIST_INVALID', value => { value.worldSources.push({ ...sourceRef({ id: `shared-world:${crypto.randomUUID()}`, version: 1, sha256: 'a'.repeat(64), data: { world: createWorld() } }) }); }],
    ['WORLD_SOURCE_ELEMENT_LIMIT', value => { value.worldSources[31].elements.push({ sourceId: crypto.randomUUID(), localId: crypto.randomUUID() }); }],
    ['WORLD_SOURCE_LINK_LIMIT', value => { value.worldSources[31].links.push({ sourceId: crypto.randomUUID(), localId: crypto.randomUUID() }); }],
    ['STORY_DEVELOPMENT_TEXT_LIMIT', value => { value.concept = 'x'; }],
  ]) {
    const invalid = structuredClone(data); change(invalid);
    assert.throws(() => f.store.save(f.id, input(invalid, saved.version)), error(code));
    assert.throws(() => recovery.put(f.draftId, { ...copy, data: invalid }), error(code));
    assert.throws(() => recovery.put(f.draftId, { ...copy, pendingSave: { ...pending, data: invalid } }), error(code));
    assert.deepEqual(state(f.store), before);
  }
  f.close();
  const reopened = new WorkspaceStore(f.directory, validateRecord);
  try { assert.deepEqual(new DevelopmentRecoveryStore(reopened).get(f.draftId), copy); }
  finally { reopened.close(); }
});

test('only exact-qualified v3 roots and envelopes get 40k nodes/4 MiB; other budgets are unchanged', () => {
  assert.equal(MAX_CANONICAL_NODES, 10000); assert.equal(MAX_CANONICAL_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_WORLD_CANONICAL_NODES, 40000); assert.equal(MAX_WORLD_CANONICAL_BYTES, 4 * 1024 * 1024);
  const data = { ...legacyData(), schemaVersion: 3, world: createWorld(), worldSources: [], beats: Array(10000).fill(null) };
  assert.doesNotThrow(() => canonicalJson(data));
  for (const value of [{ ...data, extra: true }, { ...data, schemaVersion: 2 }, { ...data, worldSources: {} }, { wrapped: data }, Array(10000).fill(null)]) {
    assert.throws(() => canonicalJson(value), { code: 'JSON_TOO_LARGE' });
  }
  assert.throws(() => canonicalJson({ ...data, beats: Array(40000).fill(null) }), { code: 'JSON_TOO_LARGE' });
  assert.throws(() => canonicalJson({ ...data, concept: 'x'.repeat(MAX_WORLD_CANONICAL_BYTES) }), { code: 'JSON_TOO_LARGE' });
  assert.throws(() => canonicalJson('x'.repeat(MAX_CANONICAL_BYTES)), { code: 'JSON_TOO_LARGE' });
  // A v3 pending request independently qualifies a legacy working snapshot.
  const copy = { schema: DEVELOPMENT_RECOVERY_SCHEMA, projectId: data.projectId, draftId: data.draftId, baseVersion: null, baseSha256: null, data: legacyData(), pendingSave: { id: 'story-development:fixture', ...input(data) }, savedAt: '2026-09-01T12:00:00.000Z' };
  assert.doesNotThrow(() => canonicalJson(copy));
  assert.throws(() => canonicalJson({ ...copy, extra: true }), { code: 'JSON_TOO_LARGE' });
});

test('QiMovi reference JSON retains v3 lineage and Universe mapping keeps existing remote contracts', t => {
  const f = fixture(t), base = f.saveWorld(smallWorld()), data = linked(f.legacy, base);
  const { worldSources, ...v2 } = { ...data, schemaVersion: 2 };
  f.store.save(f.id, input(v2));
  const target = { id: 'creative-fixture', profile: 'caniscreenwrite-creative/v1', sourceHash: null, title: 'Fixture' };
  const previous = mapUniverse(universeSource(f.store, f.draftId), target);
  assert.equal(JSON.parse(worldExports(f.store, f.draftId).files[0].bytes).development.data.schemaVersion, 2);
  const saved = f.store.save(f.id, input(data, 1));
  const exported = worldExports(f.store, f.draftId), snapshot = JSON.parse(exported.files[0].bytes);
  assert.equal(snapshot.schemaVersion, 'caniscreenwrite-world-export/v1');
  assert.deepEqual(snapshot.development.data, data);
  assert.deepEqual(snapshot.development.data.worldSources, worldSources);
  assert.equal(snapshot.development.sha256, saved.sha256);
  assert.deepEqual(worldExports(f.store, f.draftId), exported);
  assert.deepEqual(mapUniverse(universeSource(f.store, f.draftId), target), previous);
});

test('authenticated local HTTP saves v3, replays, recovers above 2 MiB and rejects invalid lineage without mutation', async t => {
  const f = fixture(t), data = maximum(f);
  f.close();
  const server = await startServer({ directory: f.directory });
  t.after(() => server.close());
  const session = await fetch(`${server.origin}/api/session`, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: f.config.ownerToken }) });
  assert.equal(session.status, 200);
  const cookie = session.headers.getSetCookie()[0].split(';')[0];
  const call = (route, method = 'GET', body) => fetch(server.origin + route, { method, headers: { Cookie: cookie, Origin: server.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const route = `/api/records/${encodeURIComponent(f.id)}`, recoveryRoute = `/api/development-recovery/${encodeURIComponent(f.draftId)}`;
  const request = input(data), response = await call(route, 'PUT', request);
  assert.equal(response.status, 200);
  const saved = await response.json(), copy = f.copy({ ...data, logline: data.logline }, saved, { id: f.id, ...request });
  assert.ok(Buffer.byteLength(JSON.stringify(copy)) > MAX_CANONICAL_BYTES);
  assert.equal((await call(recoveryRoute, 'PUT', copy)).status, 200);
  assert.deepEqual(await (await call(recoveryRoute)).json(), copy);
  const invalid = structuredClone(data); invalid.worldSources[0].elements.pop();
  const rejected = await call(route, 'PUT', input(invalid, saved.version));
  assert.equal(rejected.status, 422);
  assert.match(JSON.stringify(await rejected.json()), /WORLD_SOURCE_ELEMENTS_MISMATCH/);
  assert.equal((await call(recoveryRoute, 'PUT', { ...copy, pendingSave: { id: f.id, ...input(invalid, saved.version) } })).status, 422);
  assert.equal((await call(recoveryRoute, 'PUT', { ...copy, data: { ...data, concept: 'x'.repeat(MAX_RECOVERY_BYTES) } })).status, 413);
  assert.deepEqual(await (await call(recoveryRoute)).json(), copy);
  assert.deepEqual(await (await call(`${route}/history`)).json(), [saved]);
  assert.deepEqual(await (await call(route, 'PUT', request)).json(), { ...saved, replayed: true });
  assert.equal(validateBackup(await (await call('/api/backup')).json()).records.length, 34);
});
