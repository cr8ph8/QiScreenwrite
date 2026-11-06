import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initialize, WorkspaceStore } from '../server/storage.mjs';
import { validateRecord } from '../server/contracts.mjs';
import { startServer } from '../server/http.mjs';
import { target } from '../research/target.mjs';

const PRIVATE_BODY = 'INT. PRIVATE TEST ROOM - DAY\n\nAn authored sentence stays outside the research corpus.\n';

async function fixture(t, { brokenResearch = false, fetcher } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-research-http-'));
  const config = initialize(directory, { title: 'Disposable private research workspace' });
  const store = new WorkspaceStore(directory, validateRecord);
  const projectId = store.project().id;
  const draft = store.save('screenplay-draft:private-fixture', { kind: 'screenplay-draft', expectedVersion: null,
    requestId: crypto.randomUUID(), data: { schemaVersion: 2, projectId, sourceHash: null,
      title: 'Private authored title', body: PRIVATE_BODY, format: 'FOUNTAIN', status: 'DRAFT' } });
  store.close();
  if (brokenResearch) fs.writeFileSync(path.join(directory, 'research-loop.sqlite'), 'not a sqlite database', { mode: 0o600 });
  let server, cookie = '', providerCalls = 0;
  const open = async () => {
    server = await startServer({ directory,
      bridge: { status: () => ({ configured: false, connected: false }) },
      analysisOptions: { fetcher: async (...args) => { providerCalls++; if (fetcher) return fetcher(...args); throw new Error('Unexpected provider request'); } },
    });
  };
  await open();
  t.after(async () => { await server?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = async (route, { method = 'GET', value, origin = server.origin, authenticated = true } = {}) => {
    const response = await fetch(server.origin + route, { method, redirect: 'error', headers: {
      ...(origin === null ? {} : { Origin: origin }), ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, data: await response.json(), disposition: response.headers.get('content-disposition') };
  };
  const login = async () => assert.equal((await call('/api/session', { method: 'POST', value: { token: config.ownerToken } })).status, 200);
  return { directory, projectId, draft, call, login,
    request: (changes = {}) => ({ projectId, requestId: crypto.randomUUID(), maxTrials: 8, maxWallMs: 30000, trialTimeoutMs: 5000, ...changes }),
    get providerCalls() { return providerCalls; },
    close: () => server.close(),
    async reopen() { await server.close(); cookie = ''; await open(); await login(); },
    async finished() {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const result = await call('/api/research-loop');
        assert.equal(result.status, 200);
        if (!result.data.active) return result.data;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('Research run did not finish within the test deadline');
    },
  };
}

test('research HTTP requires owner session, exact origin, bounded fields, and the current project', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/research-loop')).status, 401);
  assert.equal((await f.call('/api/research-loop/export')).status, 401);
  assert.equal((await f.call('/api/research-loop/start', { method: 'POST', value: f.request() })).status, 401);
  await f.login();
  for (const origin of [null, 'https://untrusted.example']) {
    assert.equal((await f.call('/api/research-loop/start', { method: 'POST', value: f.request(), origin })).status, 403);
  }
  const initial = await f.call('/api/research-loop');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.schema, 'qi-research-loop/v1');
  assert.equal(initial.data.projectId, f.projectId);
  assert.equal(initial.data.contract.scope, 'RESEARCH_CONFIGURATION_ONLY');
  assert.equal(initial.data.contract.provider, 'NONE');
  assert.equal(initial.data.accepted.version, 0);
  for (const route of ['/api/research-loop?extra=1', '/api/research-loop/export?extra=1']) {
    const rejected = await f.call(route);
    assert.equal(rejected.status, 422); assert.equal(rejected.data.error, 'RESEARCH_QUERY_REJECTED');
  }
  const wrongProject = await f.call('/api/research-loop/start', { method: 'POST', value: f.request({ projectId: 'other-project' }) });
  assert.equal(wrongProject.status, 409); assert.equal(wrongProject.data.error, 'RESEARCH_PROJECT_MISMATCH');
  const extra = await f.call('/api/research-loop/start', { method: 'POST', value: f.request({ applyToDraft: true }) });
  assert.equal(extra.status, 422); assert.equal(extra.data.error, 'RESEARCH_FIELDS_INVALID');
  const unbounded = await f.call('/api/research-loop/start', { method: 'POST', value: f.request({ maxTrials: 25 }) });
  assert.equal(unbounded.status, 422); assert.equal(unbounded.data.error, 'RESEARCH_BUDGET_INVALID');
  assert.equal((await f.call('/api/research-loop/unknown')).status, 404);
  assert.equal((await f.call('/api/research-loop')).data.runs.length, 0);
  assert.equal(f.providerCalls, 0);
});

test('synthetic research admits only a separate configuration and accounts without editing or exposing writing', async t => {
  const f = await fixture(t); await f.login();
  const before = (await f.call('/api/records')).data;
  const started = await f.call('/api/research-loop/start', { method: 'POST', value: f.request() });
  assert.equal(started.status, 200); assert.ok(started.data.active);
  const completed = await f.finished(), run = completed.runs[0];
  assert.equal(run.status, 'COMPLETED'); assert.equal(run.decision, 'COMMIT');
  assert.equal(completed.accepted.version, 1);
  assert.deepEqual(completed.accepted.config, { titleWeight: 0, textWeight: 1, tagWeight: 0 });
  assert.equal(run.confirmation.candidate.correct, 6);
  assert.ok(run.confirmation.candidate.correct > run.confirmation.baseline.correct);
  assert.deepEqual((await f.call('/api/records')).data, before);
  assert.equal(f.providerCalls, 0);
  const accounting = (await f.call('/api/resource-accounting')).data;
  assert.equal(accounting.researchRuns.length, 1);
  assert.equal(accounting.researchRuns[0].id, run.id);
  assert.equal(accounting.researchRuns[0].resources.inputTokens, 0);
  assert.equal(accounting.researchRuns[0].resources.outputTokens, 0);
  assert.equal(accounting.researchRuns[0].resources.providerCostUsd, '0');
  assert.equal(accounting.researchRuns[0].resources.energyKwh, null);
  assert.ok(accounting.researchRuns[0].resources.resultBytes > 0);
  assert.ok(accounting.researchRuns[0].resources.elapsedMs >= 0);
  const exported = await f.call('/api/research-loop/export');
  assert.equal(exported.status, 200);
  assert.match(exported.disposition, /private-research-loop\.json/);
  assert.equal(exported.data.events.at(-1).type, 'run-finish');
  assert.equal(JSON.stringify(exported.data).includes(PRIVATE_BODY), false);
  assert.equal(JSON.stringify(exported.data).includes(f.draft.data.title), false);
  const developmentIds = new Set(target.development.flatMap(query => query.relevantIds));
  assert.ok(target.confirmation.every(query => query.relevantIds.every(id => !developmentIds.has(id))));
  await f.reopen();
  const restored = (await f.call('/api/research-loop')).data;
  assert.deepEqual(restored.accepted, completed.accepted);
  assert.equal(restored.active, null); assert.equal(restored.runs.length, 1);
});

test('HTTP request replay cannot launch a second experiment or change its budget', async t => {
  const f = await fixture(t); await f.login();
  const request = f.request();
  assert.equal((await f.call('/api/research-loop/start', { method: 'POST', value: request })).status, 200);
  const conflict = await f.call('/api/research-loop/start', { method: 'POST', value: { ...request, maxTrials: 1 } });
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error, 'RESEARCH_REPLAY_CONFLICT');
  await f.finished();
  const replay = await f.call('/api/research-loop/start', { method: 'POST', value: request });
  assert.equal(replay.status, 200); assert.equal(replay.data.runs.length, 1); assert.equal(replay.data.active, null);
  assert.equal((await f.call('/api/resource-accounting')).data.researchRuns.length, 1);
});

test('a screenplay revision during the run blocks admission with a fresh source hash', async t => {
  const f = await fixture(t); await f.login();
  const started = await f.call('/api/research-loop/start', { method: 'POST', value: f.request() });
  assert.ok(started.data.active);
  const saved = await f.call(`/api/records/${f.draft.id}`, { method: 'PUT', value: {
    kind: f.draft.kind, expectedVersion: f.draft.version, requestId: crypto.randomUUID(),
    data: { ...f.draft.data, body: PRIVATE_BODY + '\nA deliberate owner revision.\n' },
  } });
  assert.equal(saved.status, 200);
  const completed = await f.finished();
  assert.equal(completed.runs[0].decision, 'ESCALATE');
  assert.equal(completed.runs[0].reason, 'SOURCE_OR_ACCEPTED_STATE_CHANGED');
  assert.equal(completed.accepted.version, 0);
  assert.equal((await f.call(`/api/records/${f.draft.id}/history`)).data.length, 2);
});

test('cancel is scoped to an existing run and prevents admission', async t => {
  const f = await fixture(t); await f.login();
  const started = await f.call('/api/research-loop/start', { method: 'POST', value: f.request() });
  const runId = started.data.active.id;
  const wrongProject = await f.call('/api/research-loop/cancel', { method: 'POST', value: { projectId: 'other-project', runId } });
  assert.equal(wrongProject.status, 409);
  const cancelled = await f.call('/api/research-loop/cancel', { method: 'POST', value: { projectId: f.projectId, runId } });
  assert.equal(cancelled.status, 200);
  const completed = await f.finished();
  assert.equal(completed.runs[0].status, 'CANCELLED');
  assert.notEqual(completed.runs[0].decision, 'COMMIT');
  assert.equal(completed.accepted.version, 0);
  const missing = await f.call('/api/research-loop/cancel', { method: 'POST', value: { projectId: f.projectId, runId: crypto.randomUUID() } });
  assert.equal(missing.status, 404); assert.equal(missing.data.error, 'RESEARCH_RUN_NOT_FOUND');
});

test('shutdown cancels research before unrelated HTTP requests drain and preserves its resource receipt', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { fetcher: async () => {
    entered.resolve(); await release.promise;
    return new Response(JSON.stringify({ models: [] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  await f.login();
  // Hold a real owner HTTP request open, with an in-memory model discovery
  // transport. No network or inference occurs beyond the disposable server.
  const inFlight = f.call('/api/creative-services/models', { method: 'POST', value: { endpoint: 'http://127.0.0.1:11434' } });
  await entered.promise;
  let closing, runId;
  try {
    const started = await f.call('/api/research-loop/start', { method: 'POST', value: f.request() });
    runId = started.data.active.id;
    let closed = false;
    closing = f.close();
    closing.then(() => { closed = true; });
    const db = new DatabaseSync(path.join(f.directory, 'research-loop.sqlite'), { readOnly: true });
    try {
      const deadline = Date.now() + 5000;
      let finish;
      while (Date.now() < deadline && !finish) {
        finish = db.prepare('SELECT payload FROM research_events ORDER BY sequence').all()
          .map(row => JSON.parse(row.payload)).find(event => event.type === 'run-finish' && event.data.id === runId);
        if (!finish) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(finish, 'Research must finalize while the unrelated request is still draining');
      assert.equal(finish.data.status, 'CANCELLED');
      assert.notEqual(finish.data.decision, 'COMMIT');
      assert.equal(finish.data.reason, 'RESEARCH_CANCELLED');
      assert.equal(closed, false, 'The unrelated HTTP request should still hold server shutdown open');
    } finally { db.close(); }
  } finally {
    release.resolve();
    assert.equal((await inFlight).status, 200);
    await closing;
  }
  await f.reopen();
  const restored = (await f.call('/api/research-loop')).data;
  assert.equal(restored.accepted.version, 0);
  assert.equal(restored.active, null);
  assert.equal(restored.runs[0].id, runId);
  assert.equal(restored.runs[0].status, 'CANCELLED');
  const accounting = (await f.call('/api/resource-accounting')).data;
  assert.equal(accounting.researchRuns.length, 1);
  assert.equal(accounting.researchRuns[0].id, runId);
  assert.equal(accounting.researchRuns[0].status, 'CANCELLED');
  assert.equal(accounting.researchRuns[0].resources.providerCostUsd, '0');
  assert.equal(accounting.researchRuns[0].resources.energyKwh, null);
});

test('damaged research storage degrades the lab while owner writing remains available', async t => {
  const f = await fixture(t, { brokenResearch: true }); await f.login();
  const snapshot = await f.call('/api/research-loop');
  assert.equal(snapshot.status, 200); assert.equal(snapshot.data.degraded, true); assert.equal(snapshot.data.accepted, null);
  assert.equal((await f.call('/api/research-loop/start', { method: 'POST', value: f.request() })).status, 503);
  assert.equal((await f.call('/api/research-loop/export')).status, 503);
  assert.equal((await f.call('/api/records')).status, 200);
  const save = await f.call(`/api/records/${f.draft.id}`, { method: 'PUT', value: {
    kind: f.draft.kind, expectedVersion: f.draft.version, requestId: crypto.randomUUID(), data: { ...f.draft.data, body: PRIVATE_BODY + '\nStill writable.\n' },
  } });
  assert.equal(save.status, 200); assert.equal(save.data.version, 2);
});
