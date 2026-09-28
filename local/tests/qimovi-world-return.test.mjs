import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, WorkspaceStore, canonicalJson, sha256 } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { QiMoviBridge } from '../server/qimovi.mjs';
import { universeSource, universeBinding, mapUniverse, saveUniverseReceipt } from '../server/qimovi-universe.mjs';
import { DevelopmentRecoveryStore, DEVELOPMENT_RECOVERY_SCHEMA } from '../server/recovery.mjs';

async function fixture(t, { film = false, sensoryDetails = 'Rain', tracked = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'world-return-'));
  initialize(directory); const store = new WorkspaceStore(directory, validateRecord);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const draftId = `screenplay-draft:${crypto.randomUUID()}`, developmentId = draftId.replace('screenplay-draft:', 'story-development:');
  const projectId = store.project().id;
  const savedDraft = store.save(draftId, { kind: 'screenplay-draft', expectedVersion: null, requestId: crypto.randomUUID(), data: { schemaVersion: 2, projectId, sourceHash: null, title: 'Return fixture', format: 'FOUNTAIN', body: 'INT. HALL - NIGHT\n\nA door opens.', status: 'DRAFT' } });
  const element = { id: crypto.randomUUID(), type: 'character', name: 'Mara', description: 'Original description', storyFunction: 'Open the door', sensoryDetails, continuity: 'Left hand', status: 'needs_review', order: 2 };
  const development = { schemaVersion: 2, projectId, draftId, concept: 'Private concept', logline: 'Only here', synopsis: '', outline: '', beats: [], characters: [], worldNotes: 'Private overview', researchNotes: [{ id: crypto.randomUUID(), title: 'Source', notes: 'Private note', source: 'Paragraph 1' }], world: { schemaVersion: 1, elements: [element], links: [{ id: crypto.randomUUID(), elementId: element.id, targetType: 'scene', targetRef: 'heading:INT. HALL - NIGHT', targetLabel: 'Hall', notes: 'Only a writer link' }] } };
  const save = data => store.save(developmentId, { kind: 'story-development', expectedVersion: store.current(developmentId)?.version ?? null, requestId: crypto.randomUUID(), data });
  const saved = save(development);
  let project = { id: 'qimovi-fixture', title: 'Film fixture', profile: film ? 'filmstack-film/v1' : 'caniscreenwrite-creative/v1', sourceHash: film ? 'f'.repeat(64) : null };
  const records = new Map(mapUniverse(universeSource(store, draftId), project).map(r => [r.id, { id: r.id, kind: r.kind, version: 1, sha256: r.sha256, data: r.data }]));
  const seen = [];
  let bootstrapHook = null;
  const bridge = new QiMoviBridge(directory, { fetch: async (url, options) => {
    const route = new URL(url).pathname; seen.push([route, options.method]);
    assert.equal(options.headers.Origin, 'http://127.0.0.1:4317');
    if (route === '/api/caniscreenwrite/session') return Response.json({ authenticated: true, protocol: 'caniscreenwrite-bridge/v1', capabilities: ['universe-drafts/v1'] }, { headers: { 'Set-Cookie': 'caniscreenwrite_bridge=fixture; HttpOnly; SameSite=Strict' } });
    assert.equal(options.headers.Cookie, 'caniscreenwrite_bridge=fixture');
    assert.equal(route, '/api/bootstrap');
    bootstrapHook?.(); bootstrapHook = null;
    return Response.json({ project, records: [...records.values()] });
  } });
  bridge.configure({ origin: 'http://127.0.0.1:4317', ownerToken: 'a'.repeat(64) });
  if (tracked) for (const record of records.values()) saveUniverseReceipt(store, universeSource(store, draftId), project, universeBinding(bridge.config()), record);
  const entityId = [...records.values()].find(r => r.kind === 'universe-entity' && r.data.name === 'Mara').id;
  const claimId = field => [...records.keys()].find(id => id.includes(`:${element.id}:${field.toLowerCase()}:0`));
  const edit = (id, changes) => { const old = records.get(id), data = { ...old.data, ...changes }; records.set(id, { ...old, version: old.version + 1, data, sha256: sha256(canonicalJson(data)) }); };
  const choices = (preview, decision = 'use-qimovi') => preview.items.filter(i => i.selectable).map(i => ({ id: i.id, decision }));
  return { directory, store, bridge, records, draftId, developmentId, saved, savedDraft, element, entityId, claimId, edit, save, seen, choices, setProject: p => { project = p; }, project, hook: fn => { bootstrapHook = fn; } };
}

test('three-way return keeps local-only text and author metadata, requires explicit conflict choices and saves once', async t => {
  const f = await fixture(t);
  const local = structuredClone(f.saved.data); local.world.elements[0].description = 'Writer draft description'; local.world.elements[0].sensoryDetails = 'Wind'; f.save(local);
  f.edit(f.entityId, { summary: 'QiMovi description', review: 'SUPPORTED', status: 'DRAFT' });
  f.edit(f.claimId('storyFunction'), { body: 'Protect the traveler' });
  const preview = await f.bridge.previewWorldReturn(f.store, f.draftId);
  assert.equal(preview.counts.bothChanged, 1); assert.equal(preview.counts.localOnly, 1); assert.equal(preview.counts.remoteOnly, 1);
  assert.equal(preview.items.find(i => i.field === 'sensoryDetails').selectable, false);
  await assert.rejects(f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, []), { code: 'QIMOVI_WORLD_RETURN_CHOICES_REQUIRED' });
  const choices = preview.items.filter(i => i.selectable).map(i => ({ id: i.id, decision: i.field === 'description' ? 'keep-local' : 'use-qimovi' }));
  const receiptsBefore = f.store.list('universe-sync');
  const result = await f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, choices);
  assert.equal(result.changed, true); assert.equal(result.development.version, 3); assert.equal(result.applied, 1); assert.equal(result.kept, 1);
  local.world.elements[0].storyFunction = 'Protect the traveler';
  assert.deepEqual(result.development.data, local);
  assert.deepEqual(f.store.current(f.draftId), f.savedDraft);
  assert.deepEqual(f.store.list('universe-sync'), receiptsBefore);
  const repeat = await f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, choices);
  assert.equal(repeat.replayed, true); assert.equal(repeat.changed, false); assert.equal(f.store.history(f.developmentId).length, 3);
  assert.ok(f.seen.every(([route, method]) => route === '/api/caniscreenwrite/session' || method === 'GET'));
});

test('no-op and converged return add no revision; a new service can re-preview safely', async t => {
  const f = await fixture(t); f.edit(f.entityId, { name: 'Mara the keeper' });
  const preview = await f.bridge.previewWorldReturn(f.store, f.draftId);
  await f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, f.choices(preview));
  f.bridge.worldReturnResults = new Map();
  const next = await f.bridge.previewWorldReturn(f.store, f.draftId);
  assert.equal(next.counts.converged, 1);
  const result = await f.bridge.pullWorldReturn(f.store, f.draftId, next.token, []);
  assert.equal(result.changed, false); assert.equal(result.development.version, 2);
});

test('stale local edit, draft edit, connection and remote edit cannot apply a prior preview', async t => {
  for (const kind of ['local', 'draft', 'connection', 'remote']) {
    const f = await fixture(t); f.edit(f.entityId, { name: 'Returned name' });
    const preview = await f.bridge.previewWorldReturn(f.store, f.draftId);
    if (kind === 'local') { const data = structuredClone(f.saved.data); data.concept = 'New local work'; f.save(data); }
    if (kind === 'draft') f.store.save(f.draftId, { kind: 'screenplay-draft', expectedVersion: 1, requestId: crypto.randomUUID(), data: { ...f.savedDraft.data, body: 'EXT. WATER - DAY' } });
    if (kind === 'connection') f.bridge.configure({ origin: 'http://127.0.0.1:4317', ownerToken: 'b'.repeat(64) });
    if (kind === 'remote') f.edit(f.entityId, { summary: 'New remote work' });
    const before = f.store.current(f.developmentId);
    await assert.rejects(f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, f.choices(preview)), { code: 'QIMOVI_WORLD_RETURN_PREVIEW_STALE' });
    assert.deepEqual(f.store.current(f.developmentId), before);
  }
});

test('a local save during awaited remote read invalidates the preview before any write', async t => {
  const f = await fixture(t); f.edit(f.entityId, { name: 'Returned name' });
  const preview = await f.bridge.previewWorldReturn(f.store, f.draftId);
  f.hook(() => f.save({ ...f.saved.data, concept: 'Concurrent local save' }));
  await assert.rejects(f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, f.choices(preview)), { code: 'QIMOVI_WORLD_RETURN_PREVIEW_STALE' });
  assert.equal(f.store.current(f.developmentId).data.concept, 'Concurrent local save');
  assert.equal(f.store.current(f.developmentId).data.world.elements[0].name, 'Mara');
});

test('different remote project/source and forged payload scope fail closed', async t => {
  for (const kind of ['project', 'source', 'payload']) {
    const f = await fixture(t, { film: true });
    if (kind === 'project') f.setProject({ ...f.project, id: 'other-project' });
    if (kind === 'source') f.setProject({ ...f.project, sourceHash: 'e'.repeat(64) });
    if (kind === 'payload') f.edit(f.entityId, { sourceHash: 'e'.repeat(64) });
    await assert.rejects(f.bridge.previewWorldReturn(f.store, f.draftId), { code: 'QIMOVI_WORLD_RETURN_PROJECT_CHANGED' });
    assert.equal(f.store.current(f.developmentId).version, 1);
  }
});

test('foreign same-name records never supply text; altered exact identity and hashes are rejected', async t => {
  const f = await fixture(t);
  const foreign = structuredClone(f.records.get(f.entityId)); foreign.id = 'universe-entity:foreign'; foreign.data.entityId = 'foreign'; foreign.data.summary = 'Forged replacement'; foreign.sha256 = sha256(canonicalJson(foreign.data)); f.records.set(foreign.id, foreign);
  const preview = await f.bridge.previewWorldReturn(f.store, f.draftId);
  assert.equal(preview.counts.unchanged, 5); assert.ok(!JSON.stringify(preview.items).includes('Forged replacement'));
  f.edit(f.entityId, { entityId: 'foreign' });
  await assert.rejects(f.bridge.previewWorldReturn(f.store, f.draftId), { code: 'QIMOVI_WORLD_RETURN_IDENTITY_INVALID' });
  f.records.get(f.entityId).sha256 = '0'.repeat(64);
  await assert.rejects(f.bridge.previewWorldReturn(f.store, f.draftId), { code: 'QIMOVI_REMOTE_REVISION_INVALID' });
});

test('missing or set-aside entries, reclassified entities and extra chunks remain unsupported without truncation', async t => {
  for (const kind of ['missing', 'aside', 'type', 'extra-part', 'over-limit']) {
    const f = await fixture(t);
    if (kind === 'missing') f.records.delete(f.claimId('storyFunction'));
    if (kind === 'aside') f.edit(f.entityId, { review: 'SET_ASIDE' });
    if (kind === 'type') f.edit(f.entityId, { type: 'location' });
    if (kind === 'extra-part') { const id = f.claimId('storyFunction').replace(/:0$/, ':1'), record = structuredClone(f.records.get(f.claimId('storyFunction'))); record.id = id; record.data.body = 'Extra part'; record.sha256 = sha256(canonicalJson(record.data)); f.records.set(id, record); }
    if (kind === 'over-limit') f.edit(f.claimId('storyFunction'), { body: 'x'.repeat(5000) });
    const preview = await f.bridge.previewWorldReturn(f.store, f.draftId), field = preview.items.find(i => i.field === 'storyFunction');
    assert.equal(field.state, 'unsupported'); assert.equal(field.selectable, false);
    if (kind === 'over-limit') assert.equal(field.remote.length, 5000);
    const result = await f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, []);
    assert.equal(result.changed, false); assert.equal(result.development.version, 1);
  }
});

test('whitespace wrappers are decoded losslessly only while unchanged; changed literal text is not interpreted', async t => {
  const f = await fixture(t, { sensoryDetails: '\n \t ' });
  let preview = await f.bridge.previewWorldReturn(f.store, f.draftId);
  assert.equal(preview.items.find(i => i.field === 'sensoryDetails').remote, '\n \t ');
  const literal = 'Whitespace-only text: "author chose these words"'; f.edit(f.claimId('sensoryDetails'), { body: literal });
  preview = await f.bridge.previewWorldReturn(f.store, f.draftId);
  const result = await f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, f.choices(preview));
  assert.equal(result.development.data.world.elements[0].sensoryDetails, literal);
});

test('unresolved recovery protects text; clean checkpoint survives a return and retry without deletion', async t => {
  const f = await fixture(t), recovery = new DevelopmentRecoveryStore(f.store);
  const copy = { schema: DEVELOPMENT_RECOVERY_SCHEMA, projectId: f.store.project().id, draftId: f.draftId, baseVersion: f.saved.version, baseSha256: f.saved.sha256, data: structuredClone(f.saved.data), pendingSave: null, savedAt: '2026-09-01T12:00:00.000Z' };
  copy.data.concept = 'Unsaved work'; recovery.put(f.draftId, copy);
  await assert.rejects(f.bridge.previewWorldReturn(f.store, f.draftId), { code: 'QIMOVI_WORLD_RETURN_RECOVERY_PENDING' });
  assert.equal(recovery.get(f.draftId).data.concept, 'Unsaved work');
  copy.data = structuredClone(f.saved.data); copy.savedAt = '2026-09-01T12:01:00.000Z'; recovery.put(f.draftId, copy);
  f.edit(f.entityId, { name: 'Mara the keeper' }); const preview = await f.bridge.previewWorldReturn(f.store, f.draftId);
  const choices = f.choices(preview); await f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, choices);
  const repeat = await f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, choices);
  assert.equal(repeat.replayed, true); assert.deepEqual(recovery.get(f.draftId), copy);
});

test('choices cannot target foreign fields, duplicate decisions, unsupported fields, or silently skip conflicts', async t => {
  const f = await fixture(t); f.edit(f.entityId, { name: 'Mara the keeper' });
  const p = await f.bridge.previewWorldReturn(f.store, f.draftId), valid = f.choices(p);
  for (const choices of [[{ id: 'foreign:name', decision: 'use-qimovi' }], [...valid, ...valid], [{ id: `${f.element.id}:status`, decision: 'use-qimovi' }], []]) {
    await assert.rejects(f.bridge.pullWorldReturn(f.store, f.draftId, p.token, choices), e => ['QIMOVI_WORLD_RETURN_CHOICES_REQUIRED', 'QIMOVI_WORLD_RETURN_CHOICES_INVALID'].includes(e.code));
  }
  assert.equal(f.store.current(f.developmentId).version, 1);
});

test('reference-file export alone does not authorize a Universe return', async t => {
  const f = await fixture(t, { tracked: false });
  await assert.rejects(f.bridge.previewWorldReturn(f.store, f.draftId), { code: 'QIMOVI_WORLD_RETURN_NOT_TRANSFERRED' });
});

test('a partial original transfer cannot turn an unconfirmed nonempty field into an empty return', async t => {
  const f = await fixture(t, { tracked: false });
  const entity = f.records.get(f.entityId);
  saveUniverseReceipt(f.store, universeSource(f.store, f.draftId), f.project, universeBinding(f.bridge.config()), entity);
  f.records.delete(f.claimId('storyFunction'));
  const preview = await f.bridge.previewWorldReturn(f.store, f.draftId);
  const field = preview.items.find(i => i.field === 'storyFunction');
  assert.equal(field.state, 'unsupported'); assert.match(field.reason, /no confirmed claim/);
  assert.equal(field.local, 'Open the door');
});

test('a large mapped world can be previewed without overflowing generic JSON node limits', async t => {
  const f = await fixture(t), data = structuredClone(f.saved.data);
  data.world.elements = Array.from({ length: 160 }, (_, order) => ({ ...f.element, id: order ? crypto.randomUUID() : f.element.id, order }));
  f.save(data); const source = universeSource(f.store, f.draftId);
  f.records.clear();
  for (const record of mapUniverse(source, f.project)) {
    const saved = { id: record.id, kind: record.kind, version: 1, sha256: record.sha256, data: record.data };
    f.records.set(record.id, saved); saveUniverseReceipt(f.store, source, f.project, universeBinding(f.bridge.config()), saved);
  }
  const preview = await f.bridge.previewWorldReturn(f.store, f.draftId);
  assert.equal(preview.items.length, 800); assert.equal(preview.counts.unchanged, 800);
  assert.equal((await f.bridge.pullWorldReturn(f.store, f.draftId, preview.token, [])).changed, false);
});

