import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ResourceJournal } from '../accounting/resource-journal.mjs';
import { ResearchLoop, openResearchLoop, runTrial } from './engine.mjs';
import { decide, REQUIRED_CHECKS, scorePredictions, digest, validateConfig } from './evaluator.mjs';

const title = { titleWeight: 1, textWeight: 0, tagWeight: 0 };
const body = { titleWeight: 0, textWeight: 1, tagWeight: 0 };
const target = () => ({ id: 'test-retrieval', title: 'Synthetic evidence', description: 'Tests only.', baseline: title,
  candidates: [body, { titleWeight: 1, textWeight: 1, tagWeight: 0 }, { titleWeight: 0, textWeight: 2, tagWeight: 0 }],
  documents: [
    { id: 'a-decoy', title: 'red lantern', text: 'unrelated title', tags: [] },
    { id: 'b-evidence', title: 'source one', text: 'red lantern', tags: [] },
    { id: 'c-decoy', title: 'blue mirror', text: 'unrelated title', tags: [] },
    { id: 'd-evidence', title: 'source two', text: 'blue mirror', tags: [] },
  ], development: [{ id: 'dev', query: 'red lantern', relevantIds: ['b-evidence'] }],
  confirmation: [{ id: 'confirm', query: 'blue mirror', relevantIds: ['d-evidence'] }] });
const input = (extra = {}) => ({ projectId: 'test-project', requestId: crypto.randomUUID(), maxTrials: 3, maxWallMs: 15000, trialTimeoutMs: 2000, ...extra });
function setup(t, fixture = target()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-research-engine-'));
  const journal = new ResourceJournal(directory, 'qimovi', 'test-project');
  let sourceHash = digest('original-source'), loop;
  const options = { directory, app: 'qimovi', projectId: 'test-project', target: fixture, readSourceHash: () => sourceHash, resourceJournal: journal };
  loop = new ResearchLoop(options);
  t.after(async () => { await loop.close(); journal.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, journal, options, loop, changeSource: () => { sourceHash = digest('changed-source'); } };
}
const checks = () => Object.fromEntries(REQUIRED_CHECKS.map(key => [key, 'PASS']));

test('admission requires every validator; telemetry cannot create permission', () => {
  for (const key of REQUIRED_CHECKS) for (const status of ['SKIPPED', 'ERROR', 'FAIL', undefined]) {
    assert.notEqual(decide({ checks: { ...checks(), [key]: status }, improved: true, omega: 'PASS' }), 'COMMIT');
  }
  assert.equal(decide({ checks: checks(), governance: true, improved: true }), 'ESCALATE');
  assert.equal(decide({ checks: checks(), replay: true, improved: true }), 'ESCALATE');
  assert.equal(decide({ checks: checks(), stale: true, improved: true }), 'ESCALATE');
  assert.equal(decide({ checks: checks(), improved: true, omega: 'DAMP' }), 'DAMP');
  assert.equal(decide({ checks: checks(), improved: false, omega: 'PASS' }), 'DAMP');
});

test('evaluator recalculates correctness and refuses forged scores or provenance', () => {
  const fixture = target(), queries = fixture.development;
  assert.equal(scorePredictions([{ queryId: 'dev', sourceIds: ['a-decoy'] }], queries, fixture.documents).accuracy, 0);
  assert.equal(scorePredictions([{ queryId: 'dev', sourceIds: ['b-evidence'] }], queries, fixture.documents).accuracy, 1);
  for (const row of [
    { queryId: 'dev', sourceIds: ['nonexistent'] },
    { queryId: 'dev', sourceIds: ['b-evidence', 'b-evidence'] },
    { queryId: 'dev', sourceIds: ['b-evidence'], score: 1 },
    { queryId: 'invented-query', sourceIds: ['b-evidence'] },
  ]) assert.throws(() => scorePredictions([row], queries, fixture.documents));
});

test('comma-containing keys cannot impersonate the exact configuration shape', () => {
  for (const invalid of [{ 'tagWeight,textWeight,titleWeight': 1 }, { tagWeight: 1, 'textWeight,titleWeight': 1 },
    { ...body, extra: 0 }, { titleWeight: 0, textWeight: 1 }]) assert.throws(() => validateConfig(invalid), { code: 'RESEARCH_FIELDS_INVALID' });
});

test('real worker confirms a gain, commits only research configuration, and accounts for all trials', async t => {
  const { loop, journal, directory } = setup(t), before = loop.snapshot().accepted;
  const real = loop.runner; let confirmationCalls = 0;
  loop.runner = async args => {
    if (args.queries[0].id === 'confirm') { confirmationCalls++; assert.deepEqual(loop.snapshot().accepted, before); }
    return real(args);
  };
  loop.start(input());
  assert.deepEqual(loop.snapshot().accepted, before);
  await loop.pending;
  const result = loop.snapshot(), run = result.runs[0];
  assert.equal(run.decision, 'COMMIT'); assert.equal(result.accepted.version, 1); assert.deepEqual(result.accepted.config, body);
  assert.equal(confirmationCalls, 2); assert.equal(run.development.baseline.accuracy, 0); assert.equal(run.confirmation.candidate.accuracy, 1);
  assert.equal(run.completedTrials, 3); assert.equal(run.resources.inputTokens, 0); assert.equal(run.resources.outputTokens, 0);
  assert.equal(run.resources.energyKwh, null); assert.equal(run.resources.providerCostUsd, '0'); assert.ok(run.resources.resultBytes > 0);
  assert.equal(journal.snapshot().researchRuns.length, 1); assert.equal(journal.snapshot().runs.length, 0, 'research is not double-counted as model usage');
  assert.equal(journal.snapshot().researchRuns[0].completedTrials, 3);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['research-loop.sqlite', 'resource-accounting.sqlite']);
  assert.equal(result.events.filter(e => e.type === 'run-finish' && e.data.decision === 'COMMIT').length, 1);
});

test('a development gain that fails independent confirmation leaves accepted state unchanged', async t => {
  const fixture = target(); fixture.confirmation[0].relevantIds = ['c-decoy'];
  const { loop } = setup(t, fixture), before = loop.snapshot().accepted;
  loop.start(input()); await loop.pending;
  assert.equal(loop.snapshot().runs[0].decision, 'DAMP'); assert.deepEqual(loop.snapshot().accepted, before);
});

test('stale source detected after evaluation cannot commit', async t => {
  const { loop, changeSource } = setup(t), before = loop.snapshot().accepted, real = loop.runner;
  loop.runner = async args => { const result = await real(args); if (args.queries[0].id === 'confirm') changeSource(); return result; };
  loop.start(input()); await loop.pending;
  assert.equal(loop.snapshot().runs[0].decision, 'ESCALATE'); assert.deepEqual(loop.snapshot().accepted, before);
});

test('exact HTTP-style retry is idempotent, conflicting reuse is refused, and duplicate proposal pairs escalate', async t => {
  const { loop } = setup(t), first = input();
  loop.start(first); assert.equal(loop.start(first).runs.length, 1);
  assert.throws(() => loop.start({ ...first, maxTrials: 2 }), { code: 'RESEARCH_REPLAY_CONFLICT' });
  assert.throws(() => loop.start(input()), { code: 'RESEARCH_ALREADY_RUNNING' });
  await loop.pending; const count = loop.export().events.length;
  loop.start(first); assert.equal(loop.export().events.length, count);
  loop.start(input()); await loop.pending;
  const accepted = loop.snapshot().accepted;
  loop.start(input()); await loop.pending;
  assert.equal(loop.snapshot().runs[0].decision, 'ESCALATE'); assert.deepEqual(loop.snapshot().accepted, accepted);
  assert.ok(loop.export().events.some(e => e.type === 'trial' && e.data.reason === 'REPLAY_PAIR'));
});

test('cancel before dispatch prevents any worker and preserves state', async t => {
  const { loop } = setup(t), before = loop.snapshot().accepted; let called = false;
  loop.runner = async () => { called = true; throw new Error('should never run'); };
  const running = loop.start(input());
  loop.cancel({ projectId: 'test-project', runId: running.active.id }); await loop.pending;
  assert.equal(called, false); assert.equal(loop.snapshot().runs[0].status, 'CANCELLED'); assert.deepEqual(loop.snapshot().accepted, before);
});

test('parent terminates a hung worker at the job deadline', async t => {
  const { loop, directory } = setup(t), before = loop.snapshot().accepted;
  const worker = path.join(directory, 'hung-worker.mjs'); fs.writeFileSync(worker, 'while (true) {}');
  loop.runner = args => runTrial({ ...args, workerUrl: pathToFileURL(worker) });
  const start = performance.now(); loop.start(input({ maxWallMs: 100, trialTimeoutMs: 100 })); await loop.pending;
  assert.ok(performance.now() - start < 5000); assert.notEqual(loop.snapshot().runs[0].decision, 'COMMIT');
  assert.equal(loop.snapshot().runs[0].status, 'TIMED_OUT'); assert.deepEqual(loop.snapshot().accepted, before);
  assert.equal(loop.snapshot().runs[0].resources.cpuMicros, null);
});

test('cancel and close terminate an in-flight hung worker', async t => {
  const { loop, directory } = setup(t), before = loop.snapshot().accepted;
  const worker = path.join(directory, 'hung-worker.mjs'); fs.writeFileSync(worker, 'while (true) {}');
  loop.runner = args => runTrial({ ...args, workerUrl: pathToFileURL(worker) });
  const running = loop.start(input());
  await new Promise(resolve => setTimeout(resolve, 30));
  loop.cancel({ projectId: 'test-project', runId: running.active.id }); await loop.pending;
  assert.equal(loop.snapshot().runs[0].status, 'CANCELLED'); assert.deepEqual(loop.snapshot().accepted, before);
});

test('accounting failure after evaluation blocks COMMIT and retains uncertain usage', async t => {
  const { loop, journal } = setup(t), before = loop.snapshot().accepted, append = journal.append.bind(journal);
  journal.append = (key, type, data) => { if (type === 'research-finish') throw new Error('disk full'); return append(key, type, data); };
  loop.start(input()); await loop.pending;
  assert.notEqual(loop.snapshot().runs[0].decision, 'COMMIT'); assert.deepEqual(loop.snapshot().accepted, before);
  assert.equal(loop.snapshot().degraded, true); assert.equal(journal.snapshot().researchRuns[0].status, 'UNCERTAIN');
  assert.equal(journal.snapshot().researchRuns[0].resources, null);
  assert.throws(() => loop.start(input()), { code: 'RESEARCH_UNAVAILABLE' });
});

test('slow accounting cannot report completed work when the final deadline check rejects it', async t => {
  const { loop, journal } = setup(t), append = journal.append.bind(journal), before = loop.snapshot().accepted;
  loop.runner = async args => ({ predictions: args.queries.map(q => ({ queryId: q.id, sourceIds: [q.relevantIds[0]] })), workerElapsedMs: 0, cpuMicros: 0 });
  journal.append = (key, type, data) => {
    if (type === 'research-finish') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    return append(key, type, data);
  };
  loop.start(input({ maxWallMs: 100, trialTimeoutMs: 100 })); await loop.pending;
  const run = loop.snapshot().runs[0], receipt = journal.snapshot().researchRuns[0];
  assert.equal(run.status, 'TIMED_OUT'); assert.equal(receipt.status, 'TIMED_OUT'); assert.equal(receipt.decision, 'REJECT');
  assert.ok(run.elapsedMs >= 150 && run.resources.elapsedMs >= 150 && receipt.elapsedMs >= 150);
  assert.ok(receipt.evaluationElapsedMs < 100); assert.deepEqual(loop.snapshot().accepted, before);
});

test('a lost terminal receipt retains known consumption and marks outcome uncertain', async t => {
  const { loop, journal } = setup(t), append = journal.append.bind(journal);
  journal.append = (key, type, data) => { if (type === 'research-outcome') throw new Error('disk full'); return append(key, type, data); };
  loop.start(input()); await loop.pending;
  assert.equal(loop.snapshot().runs[0].decision, 'COMMIT');
  const receipt = journal.snapshot().researchRuns[0];
  assert.equal(receipt.status, 'OUTCOME_UNCERTAIN'); assert.equal(receipt.elapsedMs, null);
  assert.equal(receipt.resources.inputTokens, 0); assert.ok(receipt.resources.resultBytes > 0);
  assert.equal(loop.snapshot().degraded, true);
});

test('invalid budgets, project identity and extra governance fields cannot start work', async t => {
  const { loop } = setup(t), count = loop.export().events.length;
  for (const extra of [{ projectId: 'other' }, { maxTrials: 25 }, { maxWallMs: 300001 }, { trialTimeoutMs: 0 }, { policy: { allowAll: true } }]) assert.throws(() => loop.start(input(extra)));
  assert.equal(loop.export().events.length, count);
});

test('a forged worker output cannot authorize an improvement', async t => {
  const { loop } = setup(t), real = loop.runner, before = loop.snapshot().accepted; let calls = 0;
  loop.runner = async args => ++calls === 1 ? real(args) : { predictions: [{ queryId: 'dev', sourceIds: ['invented'] }], workerElapsedMs: 1, cpuMicros: 0 };
  loop.start(input()); await loop.pending;
  assert.deepEqual(loop.snapshot().accepted, before);
  assert.ok(loop.export().events.filter(e => e.type === 'trial').every(e => e.data.decision === 'REJECT' && e.data.score === null));
});

test('restart preserves accepted state and never resumes interrupted work', async t => {
  const { loop, options, journal } = setup(t);
  loop.start(input()); await loop.pending; const accepted = loop.snapshot().accepted;
  loop.append('run-start', { id: 'interrupted', requestId: 'interrupted-id', requestHash: digest('interrupted'), startedAt: new Date().toISOString() });
  journal.append('research:interrupted:start', 'research-start', { id: 'interrupted', targetId: 'test-retrieval', startedAt: new Date().toISOString() });
  await loop.close();
  const restarted = new ResearchLoop(options);
  try {
    assert.deepEqual(restarted.snapshot().accepted, accepted); assert.equal(restarted.snapshot().active, null);
    assert.equal(restarted.snapshot().runs[0].status, 'INTERRUPTED'); assert.equal(restarted.pending, null);
    assert.equal(journal.snapshot().researchRuns.at(-1).status, 'UNCERTAIN');
  } finally { await restarted.close(); }
});

test('journal corruption and evaluator-contract change degrade research without bypassing admission', async t => {
  const { loop, options, directory } = setup(t); await loop.close();
  const changed = target(); changed.documents[0].text = 'different fixture';
  assert.throws(() => new ResearchLoop({ ...options, target: changed }), { code: 'RESEARCH_POLICY_CHANGED' });
  const db = new DatabaseSync(path.join(directory, 'research-loop.sqlite'));
  assert.throws(() => db.exec('DELETE FROM research_events'), /RESEARCH_APPEND_ONLY/);
  db.exec('DROP TRIGGER research_no_update'); db.prepare('UPDATE research_events SET payload=? WHERE sequence=1').run('{}'); db.close();
  const degraded = openResearchLoop(options);
  assert.equal(degraded.snapshot().degraded, true); assert.equal(degraded.snapshot().accepted, null);
  assert.throws(() => degraded.start(input()), { code: 'RESEARCH_LEDGER_CORRUPT' }); await degraded.close();
});
