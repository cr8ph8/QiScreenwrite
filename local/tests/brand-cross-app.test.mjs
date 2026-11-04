import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { initialize, loadConfig } from '../server/storage.mjs';
import { startServer } from '../server/http.mjs';

// The paired CI job supplies an exact QiMovi checkout. No installed user app,
// real screenplay, account, network discovery, or production workspace is used.
const moviRoot = process.env.QIMOVI_SOURCE_DIR;
test('real local apps exchange source-bound financing context without granting financial authority', { skip: !moviRoot }, async t => {
  const fromMovi = relative => import(pathToFileURL(path.resolve(moviRoot, relative)).href);
  const { createCreativeProject } = await fromMovi('local/server/creative-project.mjs');
  const { startServer: startMovi } = await fromMovi('local/server/http.mjs');
  const { validateRecord } = await fromMovi('local/contracts/drifter.mjs');
  const { loadConfig: moviConfig } = await fromMovi('local/server/storage.mjs');
  for (const filename of ['brand-scanner.mjs', 'screenplay-index.mjs', 'screenplay-elements.mjs']) {
    assert.equal(fs.readFileSync(new URL(`../contracts/${filename}`, import.meta.url), 'utf8'),
      fs.readFileSync(path.resolve(moviRoot, 'local/contracts', filename), 'utf8'), `${filename}: shared contracts must stay byte-identical`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qibrand-paired-'));
  const filmDir = path.join(root, 'film'), writerDir = path.join(root, 'writer');
  createCreativeProject(filmDir, 'Synthetic cross-app placement'); initialize(writerDir);
  const film = await startMovi({ directory: filmDir, port: 0, validateRecord });
  const writer = await startServer({ directory: writerDir, port: 0 });
  t.after(async () => { await writer.close(); await film.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function client(origin) {
    let cookie = '';
    return async (route, method = 'GET', body) => {
      const response = await fetch(origin + route, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      const cookies = response.headers.getSetCookie(); if (cookies.length) cookie = cookies[0].split(';')[0];
      return { status: response.status, data: await response.json() };
    };
  }
  const w = client(writer.origin), f = client(film.origin), bridge = client(film.origin);
  assert.equal((await w('/api/session', 'POST', { token: loadConfig(writerDir).ownerToken })).status, 200);
  assert.equal((await f('/api/session', 'POST', { token: moviConfig(filmDir).ownerToken })).status, 200);
  const wp = (await w('/api/bootstrap')).data.project, fp = (await f('/api/bootstrap')).data.project;
  const input = { kind: 'screenplay-draft', expectedVersion: null, requestId: crypto.randomUUID(), data: { schemaVersion: 2, projectId: wp.id, sourceHash: null, title: 'Synthetic', format: 'FOUNTAIN', status: 'DRAFT', body: 'INT. STUDIO - DAY\n\nAri sips coffee beside a laptop.\n' } };
  const saved = await w('/api/records/screenplay-draft:paired', 'PUT', input);
  assert.equal(saved.status, 200); const local = saved.data;
  const scanInput = { draftId: local.id, draftVersion: local.version, draftSha256: local.sha256 };
  const localPlan = await w('/api/brands/scan', 'POST', scanInput);
  assert.equal(localPlan.status, 200); assert.equal(localPlan.data.opportunities.length, 2);
  const reviewInput = { kind: 'brand-review', expectedVersion: null, requestId: crypto.randomUUID(), data: { schemaVersion: 1, projectId: wp.id, draftId: local.id, sourceRef: localPlan.data.source.recordRef, reviews: [{ opportunityId: localPlan.data.opportunities[0].id, decision: 'approved', reason: 'Fits the original scene.' }], approvalGranted: false } };
  assert.equal((await w(`/api/records/${localPlan.data.reviewId}`, 'PUT', reviewInput)).status, 200);
  assert.equal((await w('/api/brands/qimovi-context', 'POST', { draftId: local.id })).status, 409);
  assert.equal((await w('/api/connectors/qimovi/config', 'PUT', { origin: film.origin, ownerToken: moviConfig(filmDir).ownerToken })).status, 200);
  assert.equal((await w('/api/connectors/qimovi/push', 'POST', { draftId: local.id })).status, 200);
  let ledger = (await f('/api/brand-financing')).data;
  assert.equal(ledger.version, 0, 'writer creative review is not a QiMovi financial approval');
  const source = ledger.sources.find(row => row.id === local.id);
  const remoteScan = await f('/api/brand-financing/scan', 'POST', { projectId: fp.id, sourceId: source.id, sourceFingerprint: source.fingerprint });
  assert.equal(remoteScan.status, 200);
  assert.deepEqual(remoteScan.data.opportunities.map(row => [row.quote, row.start, row.end]), localPlan.data.opportunities.map(row => [row.quote, row.start, row.end]));
  const opportunity = remoteScan.data.opportunities[0];
  async function command(action, data) {
    const result = await f('/api/brand-financing/command', 'POST', { projectId: fp.id, expectedVersion: ledger.version, requestId: crypto.randomUUID(), action, data });
    assert.equal(result.status, 200, JSON.stringify(result.data)); ledger = (await f('/api/brand-financing')).data;
  }
  await command('review', { sourceId: source.id, sourceFingerprint: source.fingerprint, opportunityId: opportunity.id, decision: 'approved', reason: 'Separate production review.' });
  await command('deal', { budgetHash: null, deal: { id: 'deal:paired', sponsor: 'Synthetic sponsor', opportunityId: opportunity.id, currency: 'USD', cash: '40', extraCost: '0', marketingSupport: '100', savings: [], milestones: [{ id: 'deposit', label: 'Deposit', amount: '40', dueDate: '2026-12-01' }], notes: 'Test only.' } });
  await command('sign', { dealId: 'deal:paired', confirmed: true, evidence: 'PRIVATE_CONTRACT_REFERENCE' });
  const read = await w('/api/brands/qimovi-context', 'POST', { draftId: local.id });
  assert.equal(read.status, 200, JSON.stringify(read.data)); assert.equal(read.data.readOnly, true); assert.equal(read.data.approvalGranted, false);
  assert.equal(read.data.deals[0].sponsor, 'Synthetic sponsor'); assert.equal(read.data.totals[0].signedCash, '40');
  assert.deepEqual(read.data.totals, ledger.totals, 'the writer reads canonical project totals without reformatting or recomputing money');
  assert.equal(JSON.stringify(read.data).includes('PRIVATE_CONTRACT_REFERENCE'), false);
  assert.equal(read.data.events, undefined); assert.equal(read.data.totalsScope, 'PROJECT_NOT_DRAFT');
  const still = (await w('/api/bootstrap')).data.records.find(row => row.id === local.id);
  assert.equal(still.sha256, local.sha256); assert.equal(still.version, local.version);
  const session = await bridge('/api/caniscreenwrite/session', 'POST', { token: moviConfig(filmDir).ownerToken });
  assert.ok(session.data.capabilities.includes('brand-context/v1'));
  assert.equal((await bridge('/api/brand-financing')).status, 403);
  assert.equal((await bridge('/api/brand-financing/command', 'POST', {})).status, 403);
  const edit = await w('/api/records/' + local.id, 'PUT', { ...input, expectedVersion: 1, requestId: crypto.randomUUID(), data: { ...input.data, body: input.data.body + '\nThe story changes.\n' } });
  assert.equal(edit.status, 200);
  assert.equal((await w('/api/brands/qimovi-context', 'POST', { draftId: local.id })).status, 409);
  assert.equal((await w('/api/brands/scan', 'POST', scanInput)).status, 409);
  assert.equal((await f('/api/brand-financing')).data.version, ledger.version, 'cross-app reads never write the ledger');
});
