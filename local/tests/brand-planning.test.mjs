import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, WorkspaceStore, canonicalJson, sha256 } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { scanWriterBrands, brandReviewId, sourceForBrandDraft } from '../server/brand-planning.mjs';
import { createBackup, restoreWorkspace } from '../server/backup.mjs';
import { QiMoviBridge } from '../server/qimovi.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-brands-')); initialize(dir);
  const store = new WorkspaceStore(dir, validateRecord), project = store.project();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const draft = store.save('screenplay-draft:brand-test', { kind: 'screenplay-draft', expectedVersion: null, requestId: crypto.randomUUID(),
    data: { schemaVersion: 2, projectId: project.id, sourceHash: null, title: 'Synthetic film', format: 'FOUNTAIN', status: 'DRAFT',
      body: 'Title: Coffee\n\nINT. STUDIO - DAY\n😀 coffee beside a laptop.\n[[car in note]]\n/* pizza in comment */\n' } });
  const scan = (row = draft) => scanWriterBrands(store, { draftId: row.id, draftVersion: row.version, draftSha256: row.sha256 });
  const result = scan();
  const input = { kind: 'brand-review', expectedVersion: null, requestId: crypto.randomUUID(), data: { schemaVersion: 1, projectId: project.id,
    draftId: draft.id, sourceRef: result.source.recordRef, reviews: [{ opportunityId: result.opportunities[0].id, decision: 'approved', reason: 'Fits the existing action.' }], approvalGranted: false } };
  return { dir, store, project, draft, scan, result, input, save: (value = input) => store.save(brandReviewId(draft.id), value) };
}
test('local scan is deterministic, excerpt-bound and read-only, with no cloud or QiMovi connection', t => {
  const f = setup(t), before = canonicalJson(f.store.list());
  assert.deepEqual(f.scan(), f.result); assert.equal(canonicalJson(f.store.list()), before);
  assert.deepEqual(f.result.opportunities.map(row => row.quote), ['coffee', 'laptop']);
  for (const row of f.result.opportunities) assert.equal(f.draft.data.body.slice(row.start, row.end), row.quote);
  assert.equal(f.result.approvalGranted, false); assert.equal(f.result.authority, 'CREATIVE_PLANNING_ONLY');
});
test('review persists without changing screenplay; retries, conflicts and forged approvals fail safely', t => {
  const f = setup(t), before = f.store.current(f.draft.id), record = f.save();
  assert.deepEqual(f.store.current(f.draft.id), before); assert.equal(record.version, 1);
  assert.equal(f.save().replayed, true);
  assert.throws(() => f.save({ ...f.input, requestId: crypto.randomUUID() }), /VERSION_CONFLICT/);
  assert.throws(() => f.save({ ...f.input, expectedVersion: 1, requestId: crypto.randomUUID(), data: { ...f.input.data, approvalGranted: true } }), /BRAND_REVIEW_FIELDS_INVALID/);
  assert.throws(() => f.save({ ...f.input, expectedVersion: 1, requestId: crypto.randomUUID(), data: { ...f.input.data, reviews: [{ ...f.input.data.reviews[0], opportunityId: `placement:${'f'.repeat(40)}` }] } }), /BRAND_OPPORTUNITY_MISSING/);
});
test('draft revisions invalidate reviews; historical reviews remain valid in backup and restore', t => {
  const f = setup(t); f.save();
  const next = f.store.save(f.draft.id, { kind: 'screenplay-draft', expectedVersion: 1, requestId: crypto.randomUUID(), data: { ...f.draft.data, body: f.draft.data.body + 'A phone rings.\n' } });
  assert.throws(() => f.scan(), /BRAND_SOURCE_CHANGED/); assert.equal(f.scan(next).stale, true);
  assert.throws(() => f.save({ ...f.input, expectedVersion: 1, requestId: crypto.randomUUID() }), /BRAND_SOURCE_CHANGED/);
  const backup = createBackup(f.store), destination = path.join(f.dir, 'restored'); restoreWorkspace(destination, backup);
  const restored = new WorkspaceStore(destination, validateRecord);
  try { assert.equal(scanWriterBrands(restored, { draftId: next.id, draftVersion: next.version, draftSha256: next.sha256 }).stale, true); }
  finally { restored.close(); }
});
test('rejects duplicate review identities, oversized input and incorrect project references', t => {
  const f = setup(t);
  for (const data of [{ ...f.input.data, projectId: 'other' }, { ...f.input.data, reviews: [f.input.data.reviews[0], f.input.data.reviews[0]] }])
    assert.throws(() => f.save({ ...f.input, requestId: crypto.randomUUID(), data }), /BRAND_REVIEW/);
  assert.throws(() => scanWriterBrands(f.store, { draftId: f.draft.id, draftVersion: 1, draftSha256: f.draft.sha256, ignored: true }), /BRAND_SCAN_FIELDS_INVALID/);
});
function bridgeFixture(t) {
  const f = setup(t), remoteProject = { id: 'remote-project', title: 'Remote', profile: 'caniscreenwrite-creative/v1', sourceHash: null };
  const remoteData = { ...f.draft.data, projectId: remoteProject.id }, remote = { ...f.draft, data: remoteData, sha256: sha256(canonicalJson(remoteData)) };
  const link = { schemaVersion: 1, projectId: f.project.id, draftId: f.draft.id, draftVersion: f.draft.version, draftSha256: f.draft.sha256, target: 'qimovi',
    remote: { origin: 'http://127.0.0.1:4317', projectId: remoteProject.id, projectTitle: remoteProject.title, projectProfile: remoteProject.profile, recordId: remote.id, version: remote.version, sha256: remote.sha256 }, linkedAt: new Date().toISOString() };
  f.store.save('sync-link:qimovi:brand-test', { kind: 'sync-link', expectedVersion: null, requestId: crypto.randomUUID(), data: link });
  const bridge = new QiMoviBridge(f.dir); bridge.config = () => ({ origin: link.remote.origin, ownerToken: 'synthetic' });
  bridge.refreshInstalled = async () => {}; bridge.ensureConnected = async () => {}; bridge.bootstrap = async () => {};
  bridge.capabilities = ['brand-context/v1']; bridge.remote = { project: remoteProject, records: [remote] };
  const data = { schemaVersion: 'qimovi-brand-context/v1', projectId: remoteProject.id, source: sourceForBrandDraft(remote),
    ledgerVersion: 0, reviews: [], deals: [], totals: [], totalsScope: 'PROJECT_NOT_DRAFT', readOnly: true, authority: 'OWNER_RECORDED_PLANNING_ONLY', externalVerification: false, approvalGranted: false };
  const calls = []; bridge.request = async (...args) => { calls.push(args); return { data }; };
  return { ...f, bridge, data, calls };
}
test('bridge reads only the exact transferred revision and never requests finance writes', async t => {
  const f = bridgeFixture(t), result = await f.bridge.brandContext(f.store, f.draft.id);
  assert.equal(result.draftSha256, f.draft.sha256); assert.equal(result.readOnly, true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], '/api/caniscreenwrite/brand-context');
  assert.equal(f.calls[0][1].body.sourceHash, sha256(f.draft.data.body));
});
test('bridge fails closed for forged authority, divergent transfer and changed local revision in flight', async t => {
  const f = bridgeFixture(t); f.data.approvalGranted = true;
  await assert.rejects(f.bridge.brandContext(f.store, f.draft.id), /BRAND_CONTEXT_UNVERIFIED/); f.data.approvalGranted = false;
  f.bridge.remote.records[0].version = 2;
  await assert.rejects(f.bridge.brandContext(f.store, f.draft.id), /BRAND_TRANSFER_DIVERGED/); f.bridge.remote.records[0].version = 1;
  f.bridge.request = async () => {
    f.store.save(f.draft.id, { kind: 'screenplay-draft', expectedVersion: 1, requestId: crypto.randomUUID(), data: { ...f.draft.data, body: 'INT. NEW - DAY\nA car.' } });
    return { data: f.data };
  };
  await assert.rejects(f.bridge.brandContext(f.store, f.draft.id), /BRAND_SOURCE_CHANGED/);
  await assert.rejects(f.bridge.brandContext(f.store, f.draft.id), /Transfer this saved revision/);
});
