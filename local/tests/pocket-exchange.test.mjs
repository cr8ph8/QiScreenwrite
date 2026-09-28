import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, WorkspaceStore, sha256 } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { newWorldElement, newWorldLink, worldTextLength } from '../server/world.mjs';
import { startServer } from '../server/http.mjs';
import { encodePocketPackage, decodePocketPackage, exportPocketPackage, previewPocketPackage, importPocketPackage, MAX_POCKET_BYTES, MAX_POCKET_PAYLOAD_BYTES } from '../server/pocket-exchange.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-exchange-'));
  const config = initialize(directory);
  let store = new WorkspaceStore(directory, validateRecord), server;
  t.after(async () => { await server?.close(); store?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, config, get store() { return store; },
    async serve(bridge) { store.close(); store = null; server = await startServer({ directory, bridge }); return server; },
    restart() { store.close(); store = new WorkspaceStore(directory, validateRecord); return store; },
  };
}
function snapshot() {
  const a = { ...newWorldElement('location'), name: '  海 🎬 é  ', description: 'Stone\r\nRain', storyFunction: 'Arrival', sensoryDetails: 'Salt', continuity: 'Night', status: 'established', order: 8 };
  const b = { ...newWorldElement('prop'), name: 'Compass' };
  const world = { schemaVersion: 1, elements: [a, b], links: [newWorldLink(a.id, 'element', b.id, 'Compass'), newWorldLink(a.id, 'scene', 'opaque:scene/α#12', 'Opening'), newWorldLink(b.id, 'character', 'É', 'É')] };
  world.links[1].notes = '  Exact\r\nreference 🎬  ';
  return { id: crypto.randomUUID(), title: '  Harbor 🎬  ', body: 'Title: Harbor\r\n\r\nINT. HARBOR - DAY\r\n\r\nÉ\r\n海 é\r\n', genre: 'Drama', logline: 'A return.', projectFormat: 'feature',
    development: { concept: '  Concept 🎬\r\n  ', logline: 'Development logline', synopsis: 'Synopsis', outline: 'Outline\r\n', worldNotes: 'World notes',
      beats: [{ id: crypto.randomUUID(), title: 'Arrival', description: 'A boat.' }],
      characters: [{ id: crypto.randomUUID(), name: 'É', role: 'Lead', description: 'A traveller', arc: 'Returns' }],
      researchNotes: [{ id: crypto.randomUUID(), title: 'Tides', notes: 'Notes', source: 'Personal journal' }], world } };
}
const bytes = value => JSON.stringify(value);
const envelope = data => ({ schema: 'qicaniscreenwrite-pocket/v1', contentEncoding: 'base64-json-utf8', contentSha256: sha256(data), payloadBase64: Buffer.from(data).toString('base64') });
const unchecked = value => bytes(envelope(bytes(value)));
const save = (store, id, data, expectedVersion = null) => store.save(id, { kind: id.split(':')[0], data, expectedVersion, requestId: crypto.randomUUID() });
const counts = store => [store.db.prepare('SELECT count(*) n FROM records').get().n, store.db.prepare('SELECT count(*) n FROM requests').get().n];

test('exact Unicode/line endings and optional targetPages roundtrip; portable fields are strict', () => {
  const data = snapshot();
  for (const target of [undefined, 1, 1000]) {
    const value = { ...data, ...(target === undefined ? {} : { targetPages: target }) };
    const packet = encodePocketPackage(value);
    assert.equal(packet.contentSha256, sha256(Buffer.from(packet.payloadBase64, 'base64')));
    assert.deepEqual(decodePocketPackage(bytes(packet)).snapshot, value);
    assert.equal(Object.hasOwn(decodePocketPackage(bytes(packet)).snapshot, 'targetPages'), target !== undefined);
  }
  for (const targetPages of [null, 0, -0, 1001, 1.5, '20']) assert.throws(() => encodePocketPackage({ ...data, targetPages }));
  assert.equal(decodePocketPackage(unchecked({ ...data, title: '' })).snapshot.title, '');
});

test('preview writes nothing; import creates independent editable records, preserves edits on retry and restart', t => {
  const f = fixture(t), data = snapshot(), packet = encodePocketPackage(data), raw = bytes(packet);
  const initial = counts(f.store);
  assert.deepEqual(previewPocketPackage(f.store, raw).snapshot, data);
  assert.deepEqual(counts(f.store), initial);
  assert.throws(() => importPocketPackage(f.store, raw, '0'.repeat(64)), /POCKET_PREVIEW_MISMATCH/);
  assert.deepEqual(counts(f.store), initial);
  const first = importPocketPackage(f.store, raw, packet.contentSha256);
  assert.equal(first.replayed, false);
  assert.notEqual(first.draft.id, `screenplay-draft:${data.id}`);
  assert.equal(first.draft.data.sourceHash, null); assert.equal(first.draft.data.status, 'DRAFT');
  assert.equal(first.development.data.schemaVersion, 2);
  assert.equal(first.development.data.draftId, first.draft.id);
  assert.equal(first.development.data.projectId, f.store.project().id);
  assert.deepEqual(first.development.data.world, data.development.world);
  const draft = save(f.store, first.draft.id, { ...first.draft.data, body: 'Later screenplay edits' }, 1);
  const development = save(f.store, first.development.id, { ...first.development.data, concept: 'Later concept edits' }, 1);
  const after = counts(f.store);
  f.restart();
  for (const text of [raw, JSON.stringify(packet, null, 2)]) {
    const retry = importPocketPackage(f.store, text, packet.contentSha256);
    assert.equal(retry.replayed, true); assert.deepEqual(retry.draft, draft); assert.deepEqual(retry.development, development);
    assert.deepEqual(counts(f.store), after);
  }
  const changed = encodePocketPackage({ ...data, body: data.body + 'Changed on iPhone' });
  const next = importPocketPackage(f.store, bytes(changed), changed.contentSha256);
  assert.notEqual(next.draft.id, first.draft.id);
  assert.deepEqual(f.store.current(first.draft.id), draft);
  assert.deepEqual(f.store.list().map(item => item.kind).sort(), ['screenplay-draft', 'screenplay-draft', 'story-development', 'story-development']);
});

test('export selected saved draft plus all v3 creative fields; omit lineage, history, rights and originals', t => {
  const f = fixture(t), data = snapshot(), packet = encodePocketPackage(data);
  const imported = importPocketPackage(f.store, bytes(packet), packet.contentSha256);
  const other = encodePocketPackage({ ...snapshot(), title: 'Other screenplay' });
  importPocketPackage(f.store, bytes(other), other.contentSha256);
  const world = { ...data.development.world, links: [data.development.world.links[0]] };
  const shared = save(f.store, `shared-world:${crypto.randomUUID()}`, { schemaVersion: 1, projectId: f.store.project().id, name: 'Published world', description: 'Lineage remains local', world });
  const development = { ...imported.development.data, schemaVersion: 3, worldSources: [{ worldId: shared.id, version: shared.version, sha256: shared.sha256,
    elements: world.elements.map(item => ({ sourceId: item.id, localId: item.id })), links: world.links.map(item => ({ sourceId: item.id, localId: item.id })) }] };
  save(f.store, imported.development.id, development, 1);
  const before = counts(f.store), exported = exportPocketPackage(f.store, imported.draft.id);
  const decoded = decodePocketPackage(bytes(exported));
  assert.deepEqual(decoded.snapshot, { ...data, id: imported.draft.id.slice(17) });
  assert.deepEqual(counts(f.store), before);
  assert.doesNotMatch(Buffer.from(exported.payloadBase64, 'base64').toString(), /worldSources|shared-world:|projectId|draftId|sourceHash|rights|originals|history/);
  assert.equal(f.store.current(imported.development.id).data.schemaVersion, 3);
  assert.throws(() => exportPocketPackage(f.store, 'screenplay-draft:invalid'), /POCKET_DRAFT_ID_INVALID/);
});

test('missing and legacy development export as empty/current portable world without losing notes', t => {
  const f = fixture(t), id = `screenplay-draft:${crypto.randomUUID()}`;
  save(f.store, id, { schemaVersion: 2, projectId: f.store.project().id, title: 'Legacy', sourceHash: null, status: 'DRAFT', format: 'FOUNTAIN', body: '' });
  let result = decodePocketPackage(bytes(exportPocketPackage(f.store, id))).snapshot;
  assert.equal(result.projectFormat, ''); assert.equal(Object.hasOwn(result, 'targetPages'), false);
  assert.deepEqual(result.development.world, { schemaVersion: 1, elements: [], links: [] });
  const { world: _world, ...development } = result.development;
  save(f.store, id.replace('screenplay-draft:', 'story-development:'), { ...development, schemaVersion: 1, draftId: id, projectId: f.store.project().id, worldNotes: 'Legacy notes\r\n' });
  result = decodePocketPackage(bytes(exportPocketPackage(f.store, id))).snapshot;
  assert.equal(result.development.worldNotes, 'Legacy notes\r\n');
});

test('full 300-element/1000-link world and aggregate development save, export, import and replay', t => {
  const f = fixture(t), data = snapshot();
  const elements = Array.from({ length: 300 }, (_, order) => ({ ...newWorldElement('location'), order }));
  const links = Array.from({ length: 1000 }, () => newWorldLink(elements[0].id, 'element', elements[1].id, ''));
  let remaining = 164000;
  for (const element of elements) { element.description = '海'.repeat(Math.min(8000, remaining)); remaining -= element.description.length; }
  data.development = { concept: '', logline: '', synopsis: '', outline: '', worldNotes: '', characters: [], researchNotes: [],
    beats: Array.from({ length: 50 }, () => ({ id: crypto.randomUUID(), title: '', description: '🎬'.repeat(2000) })), world: { schemaVersion: 1, elements, links } };
  assert.equal(worldTextLength(data.development.world), 200000);
  const packet = encodePocketPackage(data), raw = bytes(packet);
  assert.deepEqual(decodePocketPackage(raw).snapshot, data);
  const first = importPocketPackage(f.store, raw, packet.contentSha256);
  assert.deepEqual(first.development.data.world, data.development.world);
  assert.equal(importPocketPackage(f.store, raw, packet.contentSha256).replayed, true);
  const exported = decodePocketPackage(bytes(exportPocketPackage(f.store, first.draft.id)));
  assert.deepEqual(exported.snapshot.development, data.development);
  data.development.concept = 'x';
  assert.throws(() => encodePocketPackage(data), /STORY_DEVELOPMENT_TEXT_LIMIT/);
});

test('malformed/corrupt packages and field injection fail before any records or receipts change', t => {
  const f = fixture(t), data = snapshot(), valid = encodePocketPackage(data);
  const malformed = [
    '', '{}', '[1]', 'not JSON', Buffer.from([0xff]),
    bytes({ ...valid, contentSha256: '0'.repeat(64) }), bytes({ ...valid, contentSha256: valid.contentSha256.toUpperCase() }),
    bytes({ ...valid, schema: 'newer' }), bytes({ ...valid, contentEncoding: 'json' }), bytes({ ...valid, payloadBase64: valid.payloadBase64 + '\n' }),
    bytes({ ...valid, authority: 'APPROVED' }), bytes({ ...valid, payloadBase64: '_===' }),
    bytes(envelope(Buffer.from([0xff]))), bytes(envelope('{"id":1,"id":2}')),
    bytes(valid).replace('{', '{"schema":"forged",'),
    unchecked({ ...data, id: 'not-uuid' }), unchecked({ ...data, projectId: f.store.project().id }),
    unchecked({ ...data, sourceHash: null }), unchecked({ ...data, title: 'x\0' }), unchecked({ ...data, body: '\ud800' }),
    unchecked({ ...data, body: 'x'.repeat(200001) }), unchecked({ ...data, genre: 'x'.repeat(121) }),
    unchecked({ ...data, logline: 'x'.repeat(1001) }), unchecked({ ...data, projectFormat: 'wrong' }),
    unchecked({ ...data, targetPages: null }),
  ];
  for (const mutate of [
    d => { d.development.schemaVersion = 2; }, d => { d.development.worldSources = []; },
    d => { d.development.beats[0].authority = true; }, d => { d.development.beats.push({ ...d.development.beats[0], id: d.development.beats[0].id.toUpperCase() }); },
    d => { d.development.world.elements[0].type = 'unknown'; }, d => { d.development.world.elements[0].status = 'APPROVED'; },
    d => { d.development.world.elements[0].order = -1; }, d => { d.development.world.elements[0].description = 'x'.repeat(8001); },
    d => { d.development.world.elements.push({ ...d.development.world.elements[0] }); },
    d => { d.development.world.links[0].targetRef = crypto.randomUUID(); }, d => { d.development.world.links[0].elementId = crypto.randomUUID(); },
    d => { d.development.world.links[0].id = d.development.world.elements[0].id; },
    d => { d.development.world.links[0].targetType = 'rights'; }, d => { d.development.researchNotes[0].notes = '\udfff'; },
  ]) { const copy = structuredClone(data); mutate(copy); malformed.push(unchecked(copy)); }
  const initial = counts(f.store);
  for (const bad of malformed) {
    assert.throws(() => importPocketPackage(f.store, bad, valid.contentSha256));
    assert.deepEqual(counts(f.store), initial);
  }
  assert.throws(() => decodePocketPackage(Buffer.alloc(MAX_POCKET_BYTES + 1, 32)), /POCKET_SIZE_INVALID/);
  assert.throws(() => decodePocketPackage(bytes(envelope(Buffer.alloc(MAX_POCKET_PAYLOAD_BYTES + 1, 32)))), /POCKET_PAYLOAD_TOO_LARGE/);
  assert.throws(() => previewPocketPackage(f.store, unchecked({ ...data, title: '' })), /SCREENPLAY_DRAFT_TITLE_INVALID/);
  assert.throws(() => previewPocketPackage(f.store, unchecked({ ...data, title: 'A\nB' })), /SCREENPLAY_DRAFT_TITLE_INVALID/);
});

test('atomic import rolls back the draft and its receipt if development write fails, then retry succeeds', t => {
  const f = fixture(t), packet = encodePocketPackage(snapshot()), raw = bytes(packet), initial = counts(f.store);
  f.store.db.exec("CREATE TRIGGER fail_pocket_development BEFORE INSERT ON records WHEN NEW.kind='story-development' BEGIN SELECT RAISE(ABORT,'SIMULATED_DEVELOPMENT_FAILURE'); END;");
  assert.throws(() => importPocketPackage(f.store, raw, packet.contentSha256), /SIMULATED_DEVELOPMENT_FAILURE/);
  assert.deepEqual(counts(f.store), initial);
  assert.equal(f.store.db.isTransaction, false);
  f.store.db.exec('DROP TRIGGER fail_pocket_development');
  assert.equal(importPocketPackage(f.store, raw, packet.contentSha256).replayed, false);
  assert.deepEqual(counts(f.store), [2, 2]);
});

test('HTTP owner/origin gates, bounded preview, explicit import and selected download; route hooks dispatch only', async t => {
  const f = fixture(t), calls = [];
  const bridge = { status: () => ({}), previewWorldReturn: async (...args) => { calls.push(['preview', ...args.slice(1)]); return { preview: true }; }, pullWorldReturn: async (...args) => { calls.push(['pull', ...args.slice(1)]); return { pulled: true }; } };
  const server = await f.serve(bridge);
  const login = await fetch(server.origin + '/api/session', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: bytes({ token: f.config.ownerToken }) });
  assert.equal(login.status, 200);
  const headers = { Origin: server.origin, Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const request = async (route, body, overrides = {}) => {
    const response = await fetch(server.origin + route, { method: body === undefined ? 'GET' : 'POST', body, headers, ...overrides });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  const data = snapshot(), packet = encodePocketPackage(data), raw = bytes(packet);
  for (const route of ['/api/pocket-exchange/preview', '/api/pocket-exchange/import', '/api/pocket-exchange/export?draftId=invalid', '/api/connectors/qimovi/world-return/preview', '/api/connectors/qimovi/world-return']) {
    const payload = route.includes('/export?') ? undefined : raw;
    assert.equal((await request(route, payload, { headers: { ...headers, Cookie: '' } })).status, 401);
    assert.equal((await request(route, payload, { headers: { ...headers, Origin: 'https://foreign.invalid' } })).status, 403);
    if (payload) assert.equal((await request(route, payload, { headers: { ...headers, Origin: '' } })).status, 403);
  }
  const before = (await request('/api/bootstrap')).data.records;
  const preview = await request('/api/pocket-exchange/preview', raw);
  assert.equal(preview.status, 200); assert.deepEqual(preview.data.snapshot, data);
  assert.deepEqual((await request('/api/bootstrap')).data.records, before);
  assert.equal((await request('/api/pocket-exchange/import', raw)).status, 409);
  assert.equal((await request('/api/pocket-exchange/preview', raw, { headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/pocket-exchange/preview', ' '.repeat(MAX_POCKET_BYTES + 1))).status, 413);
  assert.equal((await request('/api/pocket-exchange/preview', bytes(packet).replace('{', '{"schema":"injected",'))).status, 422);
  const imported = await request('/api/pocket-exchange/import', raw, { headers: { ...headers, 'X-Pocket-Content-Sha256': preview.data.contentSha256 } });
  assert.equal(imported.status, 200); assert.equal(imported.data.replayed, false);
  const download = await request('/api/pocket-exchange/export?draftId=' + encodeURIComponent(imported.data.draft.id));
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment; filename="screenplay-snapshot.qiscript"/);
  assert.deepEqual(decodePocketPackage(bytes(download.data)).snapshot.development, data.development);
  assert.equal((await request('/api/connectors/qimovi/world-return/preview', bytes({ draftId: 'draft' }))).status, 200);
  assert.equal((await request('/api/connectors/qimovi/world-return', bytes({ draftId: 'draft', token: 'token', choices: [] }))).status, 200);
  assert.deepEqual(calls, [['preview', 'draft'], ['pull', 'draft', 'token', []]]);
  assert.equal((await request('/api/connectors/qimovi/world-return/preview', bytes({ draftId: 'draft', injected: true }))).status, 422);
  assert.equal((await request('/api/connectors/qimovi/world-return', bytes({ draftId: 'draft', token: 'token', choices: [], injected: true }))).status, 422);
  assert.equal(calls.length, 2);
});
