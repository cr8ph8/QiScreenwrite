import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, sha256 } from '../server/storage.mjs';
import { startServer } from '../server/http.mjs';
const BODY = 'INT. ROOM - DAY\n\nA private synthetic character drinks coffee.\n';
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-writer-http-')), config = initialize(directory); let generationCalls = 0;
  const fetcher = async url => {
    const route = new URL(url).pathname;
    const value = route === '/api/tags' ? { models: [{ name: 'qwen3:8b', digest: 'a'.repeat(64), size: 4000000 }] }
      : route === '/api/show' ? { model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 65536 } }
      : (generationCalls++, { model: 'qwen3:8b', done: true, done_reason: 'stop', prompt_eval_count: 90, prompt_eval_cached_count: 20, eval_count: 50,
        message: { role: 'assistant', content: 'Invalid JSON means semantic rejection, not free compute.' }, total_duration: 9000000 });
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  const server = await startServer({ directory, port: 0, analysisOptions: { fetcher } });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let cookie = '';
  const call = async (route, method = 'GET', value, origin = server.origin) => {
    const response = await fetch(server.origin + route, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
    const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  return { directory, call, get generationCalls() { return generationCalls; }, login: () => call('/api/session', 'POST', { token: config.ownerToken }) };
}
test('resource routes require owner/origin; estimates and repeated reads leave source records unchanged', async t => {
  const f = await fixture(t); assert.equal((await f.call('/api/resource-accounting')).status, 401); await f.login();
  const boot = (await f.call('/api/bootstrap')).data, scope = data => ({ projectId: boot.project.id, data });
  assert.equal((await f.call('/api/resource-accounting')).data.requestActivity.started, 0);
  const r = { id: 'fixture-rate', provider: 'OLLAMA', model: 'qwen3:8b', currency: 'USD', inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: null,
    watts: null, electricityPerKwh: null, validFrom: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', basis: 'Fixture, not a real price' };
  assert.equal((await f.call('/api/resource-accounting/rate', 'POST', scope(r), 'http://foreign.invalid')).status, 403);
  assert.equal((await f.call('/api/resource-accounting/rate', 'POST', { projectId: 'wrong', data: r })).status, 409);
  assert.equal((await f.call('/api/resource-accounting/rate', 'POST', scope(r))).status, 200);
  const before = (await f.call('/api/resource-accounting/export')).data;
  const q = await f.call('/api/resource-accounting/quote', 'POST', scope({ provider: 'OLLAMA', model: 'qwen3:8b', local: true, usage: { inputTokens: 1000, outputTokens: 500 } }));
  assert.equal(q.status, 200); assert.equal(q.data.modelCost, '0.002'); assert.equal(q.data.spendAuthorized, false);
  assert.deepEqual((await f.call('/api/resource-accounting/export')).data.events, before.events);
  assert.deepEqual((await f.call('/api/bootstrap')).data.records, boot.records); assert.equal(f.generationCalls, 0);
});
test('actual analysis adapter records consumed tokens on failed output; replay never generates or charges twice', async t => {
  const f = await fixture(t); await f.login(); const boot = (await f.call('/api/bootstrap')).data;
  const draft = (await f.call('/api/records/screenplay-draft:resource-test', 'PUT', { kind: 'screenplay-draft', expectedVersion: null, requestId: crypto.randomUUID(),
    data: { schemaVersion: 2, projectId: boot.project.id, sourceHash: null, title: 'Resource fixture', body: BODY, format: 'FOUNTAIN', status: 'DRAFT' } })).data;
  const input = { requestId: crypto.randomUUID(), endpoint: 'http://127.0.0.1:11434', model: 'qwen3:8b', input: { schemaVersion: 1, kind: 'coverage', characterName: '',
    source: { draftId: draft.id, title: draft.data.title, bodySha256: sha256(BODY), excerpt: BODY, scope: 'full' } } };
  const result = await f.call('/api/creative-services/local', 'POST', input); assert.equal(result.status, 200); assert.equal(result.data.status, 'failed');
  assert.equal((await f.call('/api/creative-services/local', 'POST', input)).data.status, 'failed'); assert.equal(f.generationCalls, 1);
  const costs = (await f.call('/api/resource-accounting')).data;
  assert.equal(costs.usage.totalAttempts, 1); assert.equal(costs.usage.groups[0].inputKnown, '90'); assert.equal(costs.usage.groups[0].outputKnown, '50');
  assert.equal(costs.runs[0].usage.cachedInputTokens, 20); assert.equal(costs.runs[0].estimate.modelCost, null);
  assert.equal(costs.usage.attempts[0].status, 'failed'); assert.equal(JSON.stringify((await f.call('/api/resource-accounting/export')).data).includes(BODY), false);
  assert.deepEqual((await f.call('/api/bootstrap')).data.records.find(r => r.id === draft.id).data, draft.data);
});
test('cash, cost, credits and human time observations remain separate, explicit and idempotent', async t => {
  const f = await fixture(t); await f.login(); const projectId = (await f.call('/api/bootstrap')).data.project.id;
  const data = { id: 'invoice:fixture', stage: 'incurred', unit: 'money:CAD', amount: '10.15', provider: 'fixture', account: 'test', taskId: 'test', evidence: 'Synthetic evidence', recordedAt: '2026-11-04T00:00:00.000Z' };
  assert.equal((await f.call('/api/resource-accounting/entry', 'POST', { projectId, data })).status, 200);
  assert.equal((await f.call('/api/resource-accounting/entry', 'POST', { projectId, data })).data.replayed, true);
  assert.equal((await f.call('/api/resource-accounting/entry', 'POST', { projectId, data: { ...data, amount: '20' } })).status, 409);
  const costs = (await f.call('/api/resource-accounting')).data; assert.equal(costs.entryTotals[0].amount, '10.15'); assert.equal(costs.financing, null);
});
