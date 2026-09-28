import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, WorkspaceStore, hashCanonical, sha256 } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { QiMoviLibrary } from '../server/qimovi-library.mjs';
import { createPreservationPackage, verifyPreservationPackage } from '../server/preservation.mjs';
import { restoreWorkspace, validateBackup, backupChecksum } from '../server/backup.mjs';

function fixture(t, { text = 'Title: Synthetic film\r\n\r\nINT. ROOM - DAY\r\n\r\nA lamp glows. 海', filename = 'script.fountain', mimeType = 'text/plain', validator = validateRecord } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-library-'));
  const directory = path.join(root, 'writer'); initialize(directory);
  const store = new WorkspaceStore(directory, validator);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const bytes = Buffer.from(text), contentHash = sha256(bytes);
  const project = { id: 'project:remote', title: 'Synthetic production', profile: 'caniscreenwrite-creative/v1', sourceHash: null };
  const data = { schemaVersion: 2, projectId: project.id, sourceHash: null, title: 'Original screenplay', originalFilename: filename, asset: { sha256: contentHash, byteLength: bytes.length, mimeType }, family: filename.endsWith('.pdf') ? 'DOCUMENT' : 'TEXT', scope: 'PROJECT_REFERENCE', review: 'PENDING', collection: 'Scripts', category: 'Reference', collectionPath: filename, sourcePaths: ['/private/original/' + filename] };
  const row = { id: `project-asset:${contentHash}`, kind: 'project-asset', version: 1, sha256: hashCanonical(data), data };
  const bridge = { settings: { origin: 'http://127.0.0.1:12345', ownerToken: 'f'.repeat(64) }, remote: { project, records: [row] }, config() { return this.settings; }, async refreshInstalled() {}, async bootstrap() {}, async request() { return { bytes, response: new Response(bytes, { headers: { 'x-asset-sha256': contentHash, 'content-type': mimeType } }) }; } };
  const clock = { value: Date.parse('2026-09-27T20:00:00Z') }, library = new QiMoviLibrary(bridge, store, { now: () => clock.value });
  const preview = () => library.preview({ recordId: row.id });
  const input = p => ({ token: p.token, title: 'Reviewed working film', body: p.text, conversion: 'FOUNTAIN_UTF8' });
  return { root, directory, store, bridge, project, bytes, row, clock, library, preview, input };
}

test('library listing minimizes paths and credentials and never imports on read', async t => {
  const f = fixture(t), catalog = await f.library.list();
  assert.equal(catalog.assets[0].format, 'FOUNTAIN'); assert.equal(catalog.assets[0].importedDraftId, null);
  assert(!JSON.stringify(catalog).includes('/private/original')); assert(!JSON.stringify(catalog).includes('ownerToken'));
  assert.equal(f.store.list().length, 0); await f.preview(); assert.equal(f.store.list().length, 0);
});

test('reviewed import is atomic and exact; repeat preserves subsequent edits and never pushes remotely', async t => {
  const f = fixture(t), p = await f.preview(), result = await f.library.import(f.input(p));
  assert.equal(result.replayed, false); assert.equal(f.store.list().length, 3);
  assert.equal(result.draft.data.body, p.text); assert.deepEqual(Buffer.from(result.document.data.base64,'base64'), f.bytes);
  assert.equal(result.receipt.data.draftRef.sha256, result.draft.sha256); assert.equal(f.bridge.remote.records.length, 1);
  const next = f.store.save(result.draft.id, { kind: 'screenplay-draft', expectedVersion: 1, requestId: 'later-edit', data: { ...result.draft.data, body: 'A later local revision.' } });
  const replay = await f.library.import(f.input(p)); assert.equal(replay.replayed, true); assert.equal(replay.draft.version, 1); assert.deepEqual(f.store.current(next.id), next);
  await assert.rejects(f.library.import({ ...f.input(p), title: 'Different retry' }), { code: 'QIMOVI_LIBRARY_ALREADY_IMPORTED' });
  assert.equal((await f.library.list()).assets[0].importedDraftId, next.id);
  // A restarted service can offer a fresh preview and find the retained receipt.
  const reopened = new QiMoviLibrary(f.bridge, f.store), fresh = await reopened.preview({ recordId: f.row.id });
  assert.equal((await reopened.import(f.input(fresh))).replayed, true);
});

test('a late receipt failure rolls back the original, draft and idempotency receipts together', async t => {
  let reject = true;
  const f = fixture(t, { validator: (...args) => { if (args[0] === 'source-import' && reject) throw new Error('Synthetic final write failure'); return validateRecord(...args); } });
  const p = await f.preview(); await assert.rejects(f.library.import(f.input(p)), /Synthetic final write failure/);
  assert.equal(f.store.list().length, 0); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM requests').get().n, 0);
  reject = false; assert.equal((await f.library.import(f.input(p))).draft.version, 1);
});

test('changed original bytes, hash header, MIME or byte count reject before preview', async t => {
  for (const mutation of ['bytes','hash','mime','length']) {
    const f = fixture(t), original = f.bridge.request.bind(f.bridge);
    f.bridge.request = async () => { const result = await original(); if (mutation === 'bytes') result.bytes = Buffer.from('wrong'); else if (mutation === 'hash') result.response.headers.set('x-asset-sha256','a'.repeat(64)); else if (mutation === 'mime') result.response.headers.set('content-type','application/pdf'); else { f.row.data.asset.byteLength++; f.row.sha256 = hashCanonical(f.row.data); } return result; };
    if (mutation === 'length') { f.row.data.asset.byteLength++; f.row.sha256 = hashCanonical(f.row.data); }
    await assert.rejects(f.preview(), { code: 'QIMOVI_LIBRARY_BYTES_MISMATCH' }); assert.equal(f.store.list().length, 0);
  }
});

test('stale sources, project switches and expired reviews reject without creating records', async t => {
  for (const change of ['source','project','connection','expiry']) {
    const f = fixture(t), p = await f.preview();
    if (change === 'source') { f.row.data.title = 'Changed'; f.row.sha256 = hashCanonical(f.row.data); }
    if (change === 'project') f.bridge.remote.project = { ...f.project, id: 'different:project' };
    if (change === 'connection') f.bridge.settings.origin = 'http://127.0.0.1:54321';
    if (change === 'expiry') f.clock.value += 16 * 60 * 1000;
    await assert.rejects(f.library.import(f.input(p)), { code: change === 'expiry' ? 'QIMOVI_LIBRARY_PREVIEW_EXPIRED' : 'QIMOVI_LIBRARY_STALE' });
    assert.equal(f.store.list().length, 0);
  }
});

test('PDF and oversized originals stay reference-only; no conversion guesses', async t => {
  const f = fixture(t, { filename: 'original.pdf', mimeType: 'application/pdf', text: '%PDF-1.7' });
  assert.equal((await f.library.list()).assets[0].format, 'REFERENCE'); await assert.rejects(f.preview(), { code: 'QIMOVI_LIBRARY_UNSUPPORTED' });
  const large = fixture(t, { text: 'a'.repeat(1024*1024+1) }); await assert.rejects(large.preview(), { code: 'QIMOVI_LIBRARY_UNSUPPORTED' });
});

test('FDX rejects declarations, preserves its original and records reviewed conversion honestly', async t => {
  const bad = fixture(t, { text: '<!DOCTYPE FinalDraft><FinalDraft/>', filename: 'unsafe.fdx', mimeType: 'application/xml' });
  await assert.rejects(bad.preview(), { code: 'SOURCE_FDX_INVALID' });
  const f = fixture(t, { text: '<FinalDraft><Content><Paragraph Type="Action"><Text>The lamp.</Text></Paragraph></Content></FinalDraft>', filename: 'original.fdx', mimeType: 'application/xml' });
  const p = await f.preview(), result = await f.library.import({ token: p.token, title: 'Converted film', body: '!The lamp.\n', conversion: 'FDX_REVIEWED' });
  assert.equal(result.receipt.data.conversion, 'FDX_REVIEWED'); assert.deepEqual(Buffer.from(result.document.data.base64,'base64'), f.bytes);
});

test('Fountain cannot substitute text or forge authority; malformed records fail closed', async t => {
  const f = fixture(t), p = await f.preview();
  for (const patch of [{ body: p.text + '\nChanged' }, { conversion: 'FDX_REVIEWED' }, { approved: true }, { title: 'a'.repeat(201) }]) await assert.rejects(f.library.import({ ...f.input(p), ...patch }));
  f.row.data.projectId = 'foreign'; f.row.sha256 = hashCanonical(f.row.data);
  await assert.rejects(f.library.list(), { code: 'QIMOVI_LIBRARY_SCOPE_INVALID' }); assert.equal(f.store.list().length, 0);
});

test('preservation round-trip retains original bytes, import relationship and later history; corruption fails', async t => {
  const f = fixture(t), p = await f.preview(), result = await f.library.import(f.input(p));
  f.store.save(result.draft.id, { kind: 'screenplay-draft', expectedVersion: 1, requestId: crypto.randomUUID(), data: { ...result.draft.data, body: 'Changed working draft' } });
  const packet = createPreservationPackage(f.store); assert.equal(verifyPreservationPackage(packet).valid, true);
  const restored = path.join(f.root,'restored'); restoreWorkspace(restored, packet.backup);
  const copy = new WorkspaceStore(restored, validateRecord); assert.deepEqual(copy.list(), f.store.list()); copy.close();
  const bad = structuredClone(packet.backup), doc = bad.records.find(row => row.kind === 'source-document');
  doc.data.base64 = Buffer.from('corrupt').toString('base64'); doc.sha256 = hashCanonical(doc.data); bad.sha256 = backupChecksum(bad);
  assert.throws(() => validateBackup(bad), { code: 'SOURCE_BYTES_INVALID' });
  const missing = structuredClone(packet.backup); missing.records = missing.records.filter(row => row.kind !== 'source-document'); missing.sha256 = backupChecksum(missing);
  assert.throws(() => validateBackup(missing), { code: 'SOURCE_REVISION_MISSING' });
});

test('source originals and receipts are immutable and pending preview storage is bounded', async t => {
  const f = fixture(t), p = await f.preview(), result = await f.library.import(f.input(p));
  for (const record of [result.document,result.receipt]) assert.throws(() => f.store.save(record.id, { kind: record.kind, expectedVersion: 1, requestId: crypto.randomUUID(), data: record.data }), { code: 'SOURCE_IMMUTABLE' });
  for (let i=0;i<9;i++) await f.preview(); assert.equal(f.library.previews.size,8);
  await assert.rejects(f.library.import(f.input(p)), { code: 'QIMOVI_LIBRARY_PREVIEW_EXPIRED' });
});
