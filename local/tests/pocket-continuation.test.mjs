import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, WorkspaceStore, hashCanonical } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { RecoveryStore, DevelopmentRecoveryStore, RECOVERY_SCHEMA, DEVELOPMENT_RECOVERY_SCHEMA } from '../server/recovery.mjs';
import { startServer } from '../server/http.mjs';
import { newWorldElement } from '../server/world.mjs';
import { decodePocketPackage, encodePocketPackage, encodePocketContinuation, preparePocketContinuation, exportPreparedPocketContinuation, previewPocketPackage, returnPocketContinuation, importPocketPackage } from '../server/pocket-exchange.mjs';

const bytes = value => JSON.stringify(value);
const save = (store, id, data, expectedVersion = null) => store.save(id, { kind: id.split(':')[0], data, expectedVersion, requestId: crypto.randomUUID() });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-continuation-'));
  const config = initialize(directory);
  let store = new WorkspaceStore(directory, validateRecord), server;
  const uuid = crypto.randomUUID(), draftId = `screenplay-draft:${uuid}`, developmentId = `story-development:${uuid}`;
  const draft = save(store, draftId, { schemaVersion: 2, projectId: store.project().id, sourceHash: null, status: 'DRAFT', title: 'Harbor', format: 'FOUNTAIN', body: 'INT. HARBOR - DAY\r\n\r\n海 é 🎬', genre: 'Drama' });
  const element = { ...newWorldElement('location'), name: 'Harbor' }, world = { schemaVersion: 1, elements: [element], links: [] };
  const shared = save(store, `shared-world:${crypto.randomUUID()}`, { schemaVersion: 1, projectId: store.project().id, name: 'Harbor world', description: '', world });
  const development = save(store, developmentId, { schemaVersion: 3, projectId: store.project().id, draftId, concept: '', logline: '', synopsis: '', outline: '', beats: [], characters: [], worldNotes: '', researchNotes: [], world,
    worldSources: [{ worldId: shared.id, version: shared.version, sha256: shared.sha256, elements: [{ sourceId: element.id, localId: element.id }], links: [] }] });
  t.after(async () => { await server?.close(); store?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, config, draft, development, shared, draftId, developmentId, get store() { return store; },
    restart() { store.close(); store = new WorkspaceStore(directory, validateRecord); },
    async serve() { store.close(); store = null; server = await startServer({ directory }); return server; },
  };
}
const rows = store => ({ records: store.db.prepare('SELECT * FROM records ORDER BY id, version').all(), requests: store.db.prepare('SELECT * FROM requests ORDER BY id').all(),
  trips: store.db.prepare("SELECT name FROM sqlite_master WHERE name='pocket_trips'").get() ? store.db.prepare('SELECT * FROM pocket_trips ORDER BY id').all() : [] });
function changed(packet) {
  const { snapshot, continuation } = decodePocketPackage(bytes(packet));
  snapshot.body += '\r\n\r\nPhone edit 🎬'; snapshot.development.world.elements[0].description = 'A tide returns.\r\n海';
  return encodePocketContinuation(snapshot, continuation);
}

test('issuing and native download retain the saved bases without adding authored records', t => {
  const f = fixture(t), before = rows(f.store), packet = preparePocketContinuation(f.store, f.draftId), decoded = decodePocketPackage(bytes(packet));
  assert.equal(packet.schema, 'qicaniscreenwrite-pocket/v2');
  assert.equal(decoded.continuation.draft.id, f.draftId); assert.equal(decoded.continuation.development.id, f.developmentId);
  assert.deepEqual(rows(f.store).records, before.records); assert.deepEqual(rows(f.store).requests, before.requests);
  assert.deepEqual(exportPreparedPocketContinuation(f.store, decoded.continuation.exchangeId), packet);
  save(f.store, f.draftId, { ...f.draft.data, body: 'Later desktop writing' }, 1);
  assert.deepEqual(exportPreparedPocketContinuation(f.store, decoded.continuation.exchangeId), packet, 'download stays bound to original immutable revisions');
});

test('reviewed return appends same identities, preserves worlds and histories, and retries after restart', t => {
  const f = fixture(t), packet = changed(preparePocketContinuation(f.store, f.draftId)), raw = bytes(packet), before = rows(f.store);
  const preview = previewPocketPackage(f.store, raw);
  assert.equal(preview.returnReview.status, 'ready'); assert.equal(preview.returnReview.baseSnapshot.body, f.draft.data.body);
  assert.deepEqual(preview.returnReview.changedDraftFields, ['body']); assert.deepEqual(preview.returnReview.changedDevelopmentFields, ['world']);
  assert.deepEqual(rows(f.store), before, 'preview is read-only');
  assert.throws(() => returnPocketContinuation(f.store, raw, '0'.repeat(64)), /POCKET_PREVIEW_MISMATCH/);
  const result = returnPocketContinuation(f.store, raw, packet.contentSha256);
  assert.equal(result.draft.id, f.draftId); assert.equal(result.development.id, f.developmentId);
  assert.equal(result.draft.version, 2); assert.equal(result.development.version, 2);
  assert.deepEqual(result.development.data.worldSources, f.development.data.worldSources);
  assert.equal(result.development.data.world.elements[0].id, f.development.data.world.elements[0].id);
  assert.deepEqual(f.store.history(f.draftId)[0], f.draft); assert.deepEqual(f.store.history(f.developmentId)[0], f.development);
  const later = save(f.store, f.draftId, { ...result.draft.data, body: 'Later local edit' }, 2);
  f.restart(); const after = rows(f.store);
  assert.equal(previewPocketPackage(f.store, raw).returnReview.status, 'returned');
  assert.deepEqual(returnPocketContinuation(f.store, raw, packet.contentSha256).draft, later);
  assert.deepEqual(rows(f.store), after, 'retry does not write or rewind later edits');
  const next = changed(packet);
  assert.equal(previewPocketPackage(f.store, bytes(next)).returnReview.status, 'conflict');
  assert.throws(() => returnPocketContinuation(f.store, bytes(next), next.contentSha256), /fresh trip/);
  assert.deepEqual(rows(f.store), after);
});

for (const field of ['draft', 'development']) test(`concurrent Mac ${field} change refuses the stale reviewed return`, t => {
  const f = fixture(t), packet = changed(preparePocketContinuation(f.store, f.draftId));
  assert.equal(previewPocketPackage(f.store, bytes(packet)).returnReview.status, 'ready');
  const current = f[field]; save(f.store, current.id, { ...current.data, [field === 'draft' ? 'body' : 'concept']: 'Changed on Mac' }, current.version);
  const before = rows(f.store);
  assert.throws(() => returnPocketContinuation(f.store, bytes(packet), packet.contentSha256), /Mac screenplay or development changed/);
  assert.deepEqual(rows(f.store), before);
});

for (const development of [false, true]) test(`pending ${development ? 'development' : 'screenplay'} recovery blocks prepare and return`, t => {
  const f = fixture(t), packet = changed(preparePocketContinuation(f.store, f.draftId)), saved = development ? f.development : f.draft;
  const recovery = development ? new DevelopmentRecoveryStore(f.store) : new RecoveryStore(f.store);
  recovery.put(f.draftId, { schema: development ? DEVELOPMENT_RECOVERY_SCHEMA : RECOVERY_SCHEMA, draftId: f.draftId,
    baseVersion: saved.version, baseSha256: saved.sha256, savedAt: new Date().toISOString(),
    ...(development ? { projectId: f.store.project().id, pendingSave: null } : {}), data: { ...saved.data, [development ? 'concept' : 'body']: 'Unsaved recovery writing' } });
  const before = rows(f.store);
  assert.throws(() => preparePocketContinuation(f.store, f.draftId), /recovery edits/);
  assert.throws(() => returnPocketContinuation(f.store, bytes(packet), packet.contentSha256), /recovery edits/);
  assert.deepEqual(rows(f.store), before); assert.equal(recovery.get(f.draftId).data[development ? 'concept' : 'body'], 'Unsaved recovery writing');
});

test('receipt or origin forgery never establishes authority; strict malformed v2 is rejected', t => {
  const f = fixture(t), packet = changed(preparePocketContinuation(f.store, f.draftId)), decoded = decodePocketPackage(bytes(packet));
  for (const continuation of [{ ...decoded.continuation, exchangeId: crypto.randomUUID() }, { ...decoded.continuation, projectId: 'foreign-workspace' },
    { ...decoded.continuation, draft: { ...decoded.continuation.draft, sha256: '0'.repeat(64) } }]) {
    const bad = encodePocketContinuation(decoded.snapshot, continuation), before = rows(f.store);
    assert.equal(previewPocketPackage(f.store, bytes(bad)).returnReview.status, 'conflict');
    assert.throws(() => returnPocketContinuation(f.store, bytes(bad), bad.contentSha256), /not issued/); assert.deepEqual(rows(f.store), before);
  }
  assert.throws(() => encodePocketContinuation({ ...decoded.snapshot, id: crypto.randomUUID() }, decoded.continuation));
  assert.throws(() => encodePocketContinuation(decoded.snapshot, { ...decoded.continuation, authority: 'approved' }));
  const plain = encodePocketPackage(decoded.snapshot);
  assert.throws(() => returnPocketContinuation(f.store, bytes(plain), plain.contentSha256), /POCKET_CONTINUATION_REQUIRED/);
});

test('failure in development append rolls back screenplay, requests and consumption receipt', t => {
  const f = fixture(t), packet = changed(preparePocketContinuation(f.store, f.draftId)), before = rows(f.store);
  f.store.db.exec("CREATE TRIGGER fail_linked_return BEFORE INSERT ON records WHEN NEW.kind='story-development' BEGIN SELECT RAISE(ABORT,'SIMULATED_FAILURE'); END");
  assert.throws(() => returnPocketContinuation(f.store, bytes(packet), packet.contentSha256), /SIMULATED_FAILURE/);
  assert.deepEqual(rows(f.store), before);
  f.store.db.exec('DROP TRIGGER fail_linked_return');
  assert.equal(returnPocketContinuation(f.store, bytes(packet), packet.contentSha256).draft.version, 2);
});

test('unchanged return records one receipt without inventing revisions; fresh trips continue the same draft', t => {
  const f = fixture(t), first = preparePocketContinuation(f.store, f.draftId);
  const unchanged = returnPocketContinuation(f.store, bytes(first), first.contentSha256);
  assert.equal(unchanged.draft.version, 1); assert.equal(unchanged.development.version, 1);
  const second = changed(preparePocketContinuation(f.store, f.draftId));
  assert.notEqual(decodePocketPackage(bytes(first)).continuation.exchangeId, decodePocketPackage(bytes(second)).continuation.exchangeId);
  const continued = returnPocketContinuation(f.store, bytes(second), second.contentSha256);
  assert.equal(continued.draft.id, f.draftId); assert.equal(continued.draft.version, 2);
  assert.equal(f.store.list('screenplay-draft').length, 1);
  assert.deepEqual(continued.development.data.worldSources, f.development.data.worldSources);
});

test('v2 explicit copy import preserves original draft and trip, without carrying Mac linkage', t => {
  const f = fixture(t), packet = changed(preparePocketContinuation(f.store, f.draftId));
  const result = importPocketPackage(f.store, bytes(packet), packet.contentSha256);
  assert.notEqual(result.draft.id, f.draftId); assert.equal(result.development.data.schemaVersion, 2);
  assert.deepEqual(f.store.current(f.draftId), f.draft); assert.deepEqual(f.store.current(f.developmentId), f.development);
  assert.equal(f.store.db.prepare('SELECT returned_sha256 FROM pocket_trips').get().returned_sha256, null);
});

test('owner HTTP routes require explicit preparation and reviewed return; native download is same-origin', async t => {
  const f = fixture(t), server = await f.serve();
  const login = await fetch(server.origin + '/api/session', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: bytes({ token: f.config.ownerToken }) });
  const headers = { Origin: server.origin, Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const request = (route, options = {}) => fetch(server.origin + route, { headers, ...options });
  assert.equal((await fetch(server.origin + '/api/pocket-exchange/prepare', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: bytes({ draftId: f.draftId }) })).status, 401);
  assert.equal((await request('/api/pocket-exchange/prepare', { method: 'POST', headers: { ...headers, Origin: 'http://foreign.invalid' }, body: bytes({ draftId: f.draftId }) })).status, 403);
  const prepared = await request('/api/pocket-exchange/prepare', { method: 'POST', body: bytes({ draftId: f.draftId }) }); assert.equal(prepared.status, 200);
  const { exchangeId } = await prepared.json(), download = await request('/api/pocket-exchange/linked?exchangeId=' + exchangeId);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  const packet = changed(await download.json());
  assert.equal((await request('/api/pocket-exchange/preview', { method: 'POST', body: bytes(packet) })).status, 200);
  assert.equal((await request('/api/pocket-exchange/return', { method: 'POST', body: bytes(packet) })).status, 409);
  const result = await request('/api/pocket-exchange/return', { method: 'POST', body: bytes(packet), headers: { ...headers, 'X-Pocket-Content-Sha256': packet.contentSha256 } });
  assert.equal(result.status, 200); assert.equal((await result.json()).draft.id, f.draftId);
});

test('real Swift phone repository imports, edits, reopens, exports v2 and returns to the same Mac records', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), packet = preparePocketContinuation(f.store, f.draftId), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-continuation-swift-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../', import.meta.url)), source = path.join(scratch, 'Roundtrip.swift'), binary = path.join(scratch, 'roundtrip');
  fs.writeFileSync(source, String.raw`import Foundation
@main struct Main {
 static func main() throws {
  let args = CommandLine.arguments
  let repo = try PocketRepository(directory: URL(fileURLWithPath: args[3]))
  let input = try Data(contentsOf: URL(fileURLWithPath: args[1]))
  let origin = try PocketPackage.decodeTransfer(input)
  var phone = try repo.importPackage(input, existing: [])
  precondition(phone.id != origin.snapshot.id)
  phone.working.body += "\r\nPhone edit 海 🎬"
  phone.working.development.world.elements[0].description = "Phone world edit"
  phone = try repo.saveRevision(phone)
  let reopened = try repo.load().documents[0]
  precondition(reopened == phone && reopened.revisions.count == 2)
  precondition(try repo.importPackage(input, existing: [reopened]) == reopened)
  let output = try repo.exportContinuation(reopened)
  let returned = try PocketPackage.decodeTransfer(output)
  precondition(returned.snapshot.id == origin.snapshot.id && returned.continuation == origin.continuation)
  try output.write(to: URL(fileURLWithPath: args[2]))
 }
}`.replace('precondition(try repo.importPackage(input, existing: [reopened]) == reopened)', 'let retry = try repo.importPackage(input, existing: [reopened]); precondition(retry == reopened)'));
  const compiled = spawnSync('swiftc', ['-parse-as-library', '-module-cache-path', path.join(scratch, 'cache'), ...['Models.swift', 'PocketPackage.swift', 'PocketRepository.swift'].map(name => path.join(root, 'iphone/Core/Sources/ScreenwriteCore', name)), source, '-o', binary], { encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const input = path.join(scratch, 'input.qiscript'), output = path.join(scratch, 'output.qiscript'); fs.writeFileSync(input, bytes(packet));
  const run = spawnSync(binary, [input, output, path.join(scratch, 'phone-library')], { encoding: 'utf8', timeout: 10000 }); assert.equal(run.status, 0, run.stderr);
  const raw = fs.readFileSync(output), decoded = decodePocketPackage(raw);
  assert.equal(previewPocketPackage(f.store, raw).returnReview.status, 'ready');
  const result = returnPocketContinuation(f.store, raw, decoded.contentSha256);
  assert.equal(result.draft.id, f.draftId); assert.equal(result.development.data.schemaVersion, 3);
  assert.deepEqual(result.development.data.worldSources, f.development.data.worldSources);
  assert.equal(hashCanonical(result.development.data), result.development.sha256);
  assert.match(result.draft.data.body, /Phone edit 海 🎬/);
});
