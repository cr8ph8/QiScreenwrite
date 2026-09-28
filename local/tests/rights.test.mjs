import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkspaceStore, initialize, hashCanonical } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { retainEvidence, privateWorksheet, tokenPreview, exportTokenMetadata, RightsRecoveryStore } from '../server/rights.mjs';
import { RIGHTS_ID, defaultParticipation, projectSubject, recordRef, validateWriterParticipation, calculateParticipationPool, validateTokenDraft, emptyPublicFields, MAX_EVIDENCE_BYTES } from '../contracts/writer-rights.mjs';
import { createPreservationPackage, verifyPreservationPackage, preservationPreview } from '../server/preservation.mjs';
import { createBackup, validateBackup, backupChecksum } from '../server/backup.mjs';
import { main } from '../server/cli.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-rights-'));
  const directory = path.join(root, 'source'); initialize(directory, { title: 'Synthetic rights fixture' });
  const store = new WorkspaceStore(directory, validateRecord);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = store.project();
  const save = (id, data, version = null, requestId = crypto.randomUUID()) => store.save(id, { kind: id.split(':')[0], data, expectedVersion: version, requestId });
  const draftData = { schemaVersion: 2, projectId: project.id, sourceHash: null, title: 'Private screenplay', format: 'FOUNTAIN', body: 'INT. PRIVATE ROOM - DAY\n\nPrivate text.', status: 'DRAFT' };
  const draft = save('screenplay-draft:one', draftData);
  const data = defaultParticipation(project);
  data.parties.push({ id: 'writer-one', kind: 'PERSON', name: 'Private collaborator' });
  data.pools.push({ id: 'copyright', name: 'Writing ownership', kind: 'COPYRIGHT_INTEREST', subject: { kind: 'RECORD', label: 'Private screenplay', assetHash: null, recordRef: recordRef(draft) }, definition: 'PRIVATE negotiated draft basis', entityName: '', currency: '', receiptsMinor: null, deductionsMinor: null, recoupmentMinor: null, allocations: [{ id: 'allocation-one', partyId: 'writer-one', shareBps: null, agreementStatus: 'PROPOSED', evidenceHashes: [] }] });
  return { root, directory, store, project, save, draft, data, draftData };
}
const tokenData = (f, ledger) => ({ schemaVersion: 1, projectId: f.project.id, status: 'DRAFT', subjectRef: recordRef(f.draft), participationRef: recordRef(ledger), standard: 'UNDECIDED', editionCap: null, royaltyRequestBps: null, publicFields: { ...emptyPublicFields(), name: 'Public concept', description: 'Selected public description' }, nonce: 'a'.repeat(64) });

test('unknown allocations persist; different pools do not imply payouts or ownership authority', t => {
  const f = fixture(t); const saved = f.save(RIGHTS_ID, f.data);
  assert.equal(saved.data.pools[0].allocations[0].shareBps, null);
  assert.equal(calculateParticipationPool(saved.data.pools[0]).status, 'INCOMPLETE');
  f.data.pools[0].allocations[0].shareBps = 0;
  const next = f.save(RIGHTS_ID, f.data, 1);
  assert.equal(calculateParticipationPool(next.data.pools[0]).status, 'INTEREST_ONLY');
  assert.equal(calculateParticipationPool(next.data.pools[0]).unallocatedBps, 10000);
  assert.equal(next.data.status, 'DRAFT');
});

test('malformed shares, unknown fields and party references reject without appending a revision', t => {
  const f = fixture(t);
  for (const value of [-1, 10001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, '5000']) {
    const bad = structuredClone(f.data); bad.pools[0].allocations[0].shareBps = value;
    assert.throws(() => f.save(RIGHTS_ID, bad));
  }
  for (const mutate of [d => d.parties.push({ ...d.parties[0] }), d => d.pools[0].allocations[0].partyId = 'foreign', d => d.signatureVerified = true, d => d.sourceHash = 'b'.repeat(64)]) {
    const bad = structuredClone(f.data); mutate(bad); assert.throws(() => f.save(RIGHTS_ID, bad));
  }
  assert.equal(f.store.history(RIGHTS_ID).length, 0);
});

test('local participation identity remains saveable for the maximum supported project ID', () => {
  const project = { id: 'p'.repeat(160), sourceHash: null };
  assert.doesNotThrow(() => validateWriterParticipation(defaultParticipation(project), project));
  assert(RIGHTS_ID.length <= 160);
});

test('evidence retains original bytes, deduplicates, and rejects corrupt or oversized uploads', t => {
  const f = fixture(t), bytes = Buffer.from('Private original agreement\n\x00\xff', 'latin1');
  const evidence = retainEvidence(f.store, { name: 'agreement.pdf', mediaType: 'application/pdf', base64: bytes.toString('base64') });
  assert.deepEqual(Buffer.from(evidence.data.base64, 'base64'), bytes);
  assert.equal(retainEvidence(f.store, { name: 'renamed.pdf', mediaType: 'application/pdf', base64: bytes.toString('base64') }).id, evidence.id);
  assert.equal(f.store.history(evidence.id).length, 1);
  assert.throws(() => f.save(evidence.id, { ...evidence.data, name: 'changed.pdf' }, 1), { code: 'RIGHTS_EVIDENCE_IMMUTABLE' });
  assert.throws(() => f.save('rights-evidence:' + 'f'.repeat(64), { ...evidence.data, sha256: 'f'.repeat(64) }), { code: 'RIGHTS_EVIDENCE_HASH_MISMATCH' });
  for (const base64 of ['', '!!!!', 'AB==', Buffer.alloc(MAX_EVIDENCE_BYTES + 1).toString('base64')]) assert.throws(() => retainEvidence(f.store, { name: 'bad.txt', mediaType: 'text/plain', base64 }));
  assert.throws(() => retainEvidence(f.store, { name: '../escape.pdf', mediaType: 'application/pdf', base64: bytes.toString('base64') }));
  f.data.pools[0].allocations[0].agreementStatus = 'DOCUMENTED';
  f.data.pools[0].allocations[0].evidenceHashes = [evidence.data.sha256];
  assert.doesNotThrow(() => f.save(RIGHTS_ID, f.data));
});

test('CAS, changed replay, exact stale retry and historical review basis stay distinct', t => {
  const f = fixture(t), first = f.save(RIGHTS_ID, f.data, null, 'same-request');
  const review = f.save('rights-review:one', { schemaVersion: 1, projectId: f.project.id, status: 'LOCAL_REVIEW', actor: 'local-owner', participationRef: recordRef(first), note: 'Reviewed locally, no co-writer assent.' });
  const next = structuredClone(f.data); next.pools[0].allocations[0].shareBps = 6000;
  const second = f.save(RIGHTS_ID, next, 1);
  assert.equal(f.store.current(review.id).data.participationRef.sha256, first.sha256);
  assert.notEqual(second.sha256, first.sha256);
  assert.throws(() => f.save(RIGHTS_ID, next, 1), { code: 'VERSION_CONFLICT' });
  assert.throws(() => f.save(RIGHTS_ID, next, null, 'same-request'), { code: 'REQUEST_ID_CONFLICT' });
  f.save(f.draft.id, { ...f.draftData, body: 'Changed source' }, 1);
  assert.equal(f.save(RIGHTS_ID, f.data, null, 'same-request').replayed, true);
  assert.throws(() => privateWorksheet(f.store, recordRef(first)), { code: 'RIGHTS_SOURCE_CHANGED' });
  assert.throws(() => privateWorksheet(f.store, recordRef(second)), { code: 'RIGHTS_SOURCE_CHANGED' });
  assert.throws(() => f.save('rights-review:two', { ...review.data, participationRef: recordRef(second) }), { code: 'RIGHTS_SOURCE_CHANGED' });
  assert.doesNotThrow(() => validateBackup(createBackup(f.store)));
});

test('public token metadata includes only explicit fields and salted commitment, with no execution routes', t => {
  const f = fixture(t), ledger = f.save(RIGHTS_ID, f.data), data = tokenData(f, ledger);
  const record = f.save('token-preparation:one', data), preview = tokenPreview(f.store, recordRef(record));
  assert.equal(preview.executionEnabled, false);
  assert.equal(preview.status, 'LOCAL_DRAFT');
  const serialized = JSON.stringify(preview.metadata);
  for (const secret of ['Private collaborator', 'PRIVATE negotiated', f.project.id, f.draft.id, f.draft.sha256, data.nonce, 'Private text', 'evidenceHashes']) assert(!serialized.includes(secret), secret);
  assert.deepEqual(exportTokenMetadata(f.store, { recordRef: recordRef(record), metadataSha256: preview.metadataSha256 }), preview.metadata);
  assert.throws(() => exportTokenMetadata(f.store, { recordRef: recordRef(record), metadataSha256: 'b'.repeat(64) }), { code: 'TOKEN_PREVIEW_CHANGED' });
  assert.throws(() => f.save(record.id, data, 1), { code: 'TOKEN_PREPARATION_IMMUTABLE' });
  f.data.parties[0].name = 'Changed party'; f.save(RIGHTS_ID, f.data, 1);
  assert.throws(() => tokenPreview(f.store, recordRef(record)), { code: 'RIGHTS_SOURCE_CHANGED' });
  assert.doesNotThrow(() => createBackup(f.store));
});

test('NFT drafts reject private URLs, forged authority, invalid ranges and incomplete source references', t => {
  const f = fixture(t), ledger = f.save(RIGHTS_ID, f.data), base = tokenData(f, ledger);
  for (const uri of ['file:///tmp/private.pdf', 'https://localhost/a', 'https://127.0.0.1/a', 'https://docs.example.com/a?token=secret', 'https://me:secret@docs.example.com/a', 'https://docs.example.com/%00', 'javascript:alert(1)']) {
    const bad = structuredClone(base); bad.publicFields.imageUri = uri; assert.throws(() => validateTokenDraft(bad, f.project), { code: 'TOKEN_PUBLIC_URI_INVALID' });
  }
  for (const change of [{ status: 'MINTED' }, { walletPrivateKey: 'secret' }, { royaltyRequestBps: 10001 }, { editionCap: 0 }]) assert.throws(() => f.save('token-preparation:bad', { ...base, ...change }));
  assert.throws(() => f.save('token-preparation:bad', { ...base, subjectRef: { ...base.subjectRef, sha256: 'f'.repeat(64) } }), { code: 'RIGHTS_SOURCE_CHANGED' });
  const before = hashCanonical(base); validateTokenDraft(base, f.project); assert.equal(hashCanonical(base), before);
});

test('rights recovery survives reopen and guards newer content, base binding and pending replay', t => {
  const f = fixture(t), recovery = new RightsRecoveryStore(f.store);
  assert.equal(recovery.get(), null); assert.equal(recovery.exists(), false);
  const data = { schemaVersion: 1, projectId: f.project.id, baseVersion: null, baseSha256: null, data: f.data, pendingSave: { id: RIGHTS_ID, kind: 'project-participation', expectedVersion: null, requestId: 'pending-request', data: f.data }, savedAt: '2026-09-27T17:00:00.000Z' };
  recovery.put(data); assert.deepEqual(recovery.get(), data); assert.deepEqual(recovery.put(data), data);
  const checkStore = new WorkspaceStore(f.directory, validateRecord);
  assert.deepEqual(new RightsRecoveryStore(checkStore).get(), data); checkStore.close();
  assert.equal(preservationPreview(f.store).recoveryCounts.rights, 1);
  assert.throws(() => recovery.put({ ...data, savedAt: '2026-09-27T16:00:00.000Z' }), { code: 'RIGHTS_RECOVERY_NEWER' });
  assert.throws(() => recovery.clear('older'), { code: 'RIGHTS_RECOVERY_NEWER' });
  assert.throws(() => recovery.put({ ...data, baseVersion: 99, baseSha256: 'f'.repeat(64) }), { code: 'RIGHTS_RECOVERY_BASE_INVALID' });
  assert.throws(() => recovery.put({ ...data, savedAt: '2026-99-27T17:00:00.000Z' }), { code: 'RIGHTS_RECOVERY_INVALID' });
  const { id, ...request } = data.pendingSave;
  const saved = f.store.save(id, request);
  assert.equal(saved.version, 1);
  assert.equal(f.store.save(id, request).replayed, true);
  assert.equal(recovery.clear(data.savedAt).removed, true);
  assert.equal(recovery.get(), null);
});

test('private preservation restores original attachments, history, review and token drafts; corruption fails', async t => {
  const f = fixture(t), evidence = retainEvidence(f.store, { name: 'private.txt', mediaType: 'text/plain', base64: Buffer.from('Exact private original').toString('base64') });
  f.data.pools[0].allocations[0].evidenceHashes.push(evidence.data.sha256);
  const ledger = f.save(RIGHTS_ID, f.data);
  f.save('rights-review:one', { schemaVersion: 1, projectId: f.project.id, status: 'LOCAL_REVIEW', actor: 'local-owner', participationRef: recordRef(ledger), note: 'Synthetic review' });
  f.save('token-preparation:one', tokenData(f, ledger));
  const packet = createPreservationPackage(f.store); assert.equal(verifyPreservationPackage(packet).valid, true);
  const file = path.join(f.root, 'preservation.json'); fs.writeFileSync(file, JSON.stringify(packet));
  const restored = path.join(f.root, 'restored'); await main(['restore', '--data', restored, '--file', file]);
  const other = new WorkspaceStore(restored, validateRecord);
  assert.deepEqual(other.list(), f.store.list()); other.close();
  const bad = structuredClone(packet.backup), row = bad.records.find(row => row.kind === 'rights-evidence');
  row.data.base64 = Buffer.from('Corrupt private original').toString('base64'); row.data.byteLength = Buffer.from(row.data.base64, 'base64').length; row.sha256 = hashCanonical(row.data); bad.sha256 = backupChecksum(bad);
  assert.throws(() => validateBackup(bad), { code: 'RIGHTS_EVIDENCE_HASH_MISMATCH' });
  const missing = structuredClone(packet.backup); missing.records = missing.records.filter(row => row.kind !== 'rights-evidence'); missing.sha256 = backupChecksum(missing);
  assert.throws(() => validateBackup(missing), { code: 'RIGHTS_EVIDENCE_MISSING' });
});

test('legacy v1 preservation remains verifiable and restorable by the new CLI', async t => {
  const f = fixture(t), file = new URL('./fixtures/preservation-v1-empty.json', import.meta.url);
  const legacy = JSON.parse(fs.readFileSync(file)); assert.equal(verifyPreservationPackage(legacy).valid, true);
  const copy = path.join(f.root, 'legacy.json'); fs.writeFileSync(copy, JSON.stringify(legacy));
  const destination = path.join(f.root, 'legacy-restored'); assert.equal((await main(['restore', '--data', destination, '--file', copy])).restored, true);
});
