import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ResourceJournal, openResourceJournal } from '../accounting/resource-journal.mjs';
import { units, decimal, product, sum, estimate, metrics, ollamaMetrics, entryTotals } from '../accounting/resource-math.mjs';
import { usageView } from '../accounting/resource-view.mjs';
import { resourceSnapshot } from '../server/resource-accounting.mjs';
const now = '2026-11-04T20:00:00.000Z';
const rate = (extra = {}) => ({ id: 'rate-v1', provider: 'OLLAMA', model: 'qwen:fixture', currency: 'USD', inputPerMillion: '2', outputPerMillion: '10', cachedPerMillion: null,
  watts: '100', electricityPerKwh: '0.2', validFrom: '2026-11-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z', basis: 'Synthetic test assumptions, not vendor prices', ...extra });
const entry = (extra = {}) => ({ id: 'receipt-1', stage: 'incurred', unit: 'money:USD', amount: '1.25', provider: 'fixture', account: 'local-test', taskId: 'task-1', evidence: 'Synthetic record', recordedAt: now, ...extra });
const meta = (extra = {}) => ({ id: 'run-1', provider: 'OLLAMA', model: 'qwen:fixture', taskId: 'task-1', local: true, requestHash: 'a'.repeat(64), ...extra });
function setup(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-resource-test-')); const j = new ResourceJournal(directory, 'qimovi', 'project-1', { now: () => now });
  t.after(() => { try { j.close(); } catch {} fs.rmSync(directory, { recursive: true, force: true }); }); return { j, directory }; }
test('nanounit arithmetic preserves tiny charges and rejects malformed money', () => {
  assert.equal(sum(['0.1', '0.2']), '0.3'); assert.equal(product('1', '1', '1000000'), '0.000001'); assert.equal(decimal(units('0')), '0');
  for (const v of ['NaN', 'Infinity', '-1', '1e3', '', '1.0000000001', '01', 1, null]) assert.throws(() => units(v), /RESOURCE_DECIMAL_INVALID/);
});
test('unknown rates/counts stay unknown, while explicit zero is supported', () => {
  assert.equal(estimate({ inputTokens: 0, outputTokens: 0 }, null).modelCost, null);
  assert.equal(estimate({ inputTokens: 0, outputTokens: 0 }, rate(), { at: now }).modelCost, '0');
  assert.equal(estimate({ inputTokens: null, outputTokens: 20 }, rate(), { at: now }).modelCost, null);
  assert.equal(estimate({ inputTokens: 1, outputTokens: 1 }, rate(), { at: '2027-01-01T00:00:00.000Z' }).basis, 'RATE_EXPIRED_OR_NOT_ACTIVE');
});
test('cache pricing uses a subset and cannot double charge input; reasoning is not added', () => {
  const r = rate({ cachedPerMillion: '0.5' });
  assert.equal(estimate({ inputTokens: 1000000, cachedInputTokens: 200000, outputTokens: 1000, reasoningTokens: 500 }, r, { at: now }).modelCost, '1.71');
  assert.equal(estimate({ inputTokens: 1000000, outputTokens: 0 }, r, { at: now }).modelCost, null);
  assert.throws(() => metrics({ inputTokens: 2, cachedInputTokens: 3 }), /RESOURCE_TOKEN_SUBSET_INVALID/);
  assert.throws(() => metrics({ inputTokens: 2, extra: 1 }), /RESOURCE_METRIC_INVALID/);
});
test('electricity is an explicit local estimate, not a token conversion or cloud measurement', () => {
  const a = estimate({ elapsedMs: 3600000 }, rate(), { at: now, local: true }); assert.equal(a.energyKwh, '0.1'); assert.equal(a.electricityCost, '0.02');
  assert.equal(a.energyAllocation, 'PER_RUN_NOT_ADDITIVE_DURING_OVERLAP');
  assert.equal(estimate({ elapsedMs: 3600000 }, rate(), { at: now, local: false }).energyKwh, null);
});
test('provider nanoseconds and reported cache tokens are parsed without inventing missing usage', () => {
  const x = ollamaMetrics({ prompt_eval_count: 12, prompt_eval_cached_count: 8, eval_count: 4, total_duration: 2000001 }, 8);
  assert.equal(x.providerMs, 3); assert.equal(x.cachedInputTokens, 8); assert.equal(x.reasoningTokens, null);
  assert.equal(ollamaMetrics({ eval_count: -1 }, 8).outputTokens, null);
});
test('manual entries separate currencies, provider accounts, stages and units', () => {
  const rows = entryTotals([entry(), entry({ id: 'paid', stage: 'paid' }), entry({ id: 'cad', unit: 'money:CAD' }), entry({ id: 'c1', unit: 'credits' }), entry({ id: 'c2', unit: 'credits', provider: 'another' })]);
  assert.equal(rows.length, 5); assert.ok(rows.every(r => r.amount === '1.25'));
});
test('rate and entry retries are idempotent; changed reused identities fail', t => {
  const { j } = setup(t); j.setRate(rate()); assert.equal(j.setRate(rate()).replayed, true);
  assert.throws(() => j.setRate(rate({ inputPerMillion: '3' })), /RESOURCE_REPLAY_CONFLICT/);
  j.record(entry()); assert.equal(j.record(entry()).replayed, true); assert.throws(() => j.record(entry({ amount: '2' })), /RESOURCE_REPLAY_CONFLICT/);
  assert.equal(j.snapshot().entryTotals.length, 1);
});
test('preflight estimates do not execute, authorize, or write journal events', t => {
  const { j } = setup(t); j.setRate(rate()); const before = j.export();
  const q = j.quote({ provider: 'OLLAMA', model: 'qwen:fixture', local: true, usage: { inputTokens: 1000, outputTokens: 500 } });
  assert.equal(q.modelCost, '0.007'); assert.equal(q.spendAuthorized, false); assert.deepEqual(j.export(), before);
});
test('provider work is started durably, captured once and cannot be retried through the meter', async t => {
  const { j } = setup(t); j.setRate(rate()); let calls = 0;
  await j.measure(meta(), async () => { calls++; assert.equal(j.read().at(-1).type, 'run-start'); return { prompt_eval_count: 1000, eval_count: 500 }; });
  await assert.rejects(() => j.measure(meta(), async () => { calls++; }), /RESOURCE_RUN_ALREADY_STARTED/);
  assert.equal(calls, 1); assert.equal(j.snapshot().runs[0].estimate.modelCost, '0.007');
});
test('pricing is frozen per attempt instead of rewritten by a later rate', async t => {
  const { j } = setup(t); j.setRate(rate()); await j.measure(meta(), async () => ({ prompt_eval_count: 1000, eval_count: 500 }));
  j.setRate(rate({ id: 'rate-v2', outputPerMillion: '20' })); assert.equal(j.snapshot().runs[0].estimate.modelCost, '0.007');
});
test('failed requests and aborted jobs retain unknown rather than zero tokens/cost', async t => {
  const { j } = setup(t); await assert.rejects(() => j.measure(meta(), async () => { throw new Error('private failure'); }), /private failure/);
  const run = j.snapshot().runs[0]; assert.equal(run.status, 'FAILED_OR_UNCERTAIN'); assert.equal(run.usage.inputTokens, null); assert.equal(run.estimate.modelCost, null);
  assert.equal(JSON.stringify(j.export()).includes('private failure'), false);
});
test('semantic rejection after the provider returns cannot erase consumed tokens', async t => {
  const { j } = setup(t); const result = await j.measure(meta(), async () => ({ prompt_eval_count: 22, eval_count: 11, message: { content: 'PRIVATE BAD OUTPUT' } }));
  assert.throws(() => { if (result.message) throw new Error('semantic rejection'); });
  assert.equal(j.snapshot().outputTokens.known, 11); assert.equal(JSON.stringify(j.export()).includes('PRIVATE BAD OUTPUT'), false);
});
test('failure to persist completion never masks an already completed provider action', async t => {
  const { j } = setup(t); const append = j.append.bind(j); j.append = (key, type, data) => { if (type === 'run-finish') throw new Error('disk full'); return append(key, type, data); };
  const result = await j.measure(meta(), async () => ({ eval_count: 9 })); assert.equal(result.eval_count, 9); assert.equal(j.snapshot().degraded, true); assert.equal(j.snapshot().runs[0].status, 'UNCERTAIN');
});
test('native receipt and direct meter for one exact attempt count only once', () => {
  const view = usageView([{ key: 'local:task-1', taskId: 'task-1', provider: 'OLLAMA', model: 'qwen:fixture', origin: 'LOCAL_MODEL', inputTokens: 20, outputTokens: 10, status: 'FAILED' }], [{ ...meta(), startedAt: now, usage: metrics({ inputTokens: 20, outputTokens: 10 }), estimate: null, status: 'PROVIDER_RETURNED' }]);
  assert.equal(view.totalAttempts, 1); assert.equal(view.groups[0].outputKnown, '10'); assert.equal(view.attempts[0].status, 'FAILED');
});
test('token counters independently prefer known meter values and retain native fallbacks', async t => {
  const cases = [
    { name: 'missing meter input', native: [20, 10], meter: [null, 3], expected: [20, 3] },
    { name: 'missing meter output', native: [20, 10], meter: [4, null], expected: [4, 10] },
    { name: 'absent meter counters', native: [20, 10], meter: [], expected: [20, 10] },
    { name: 'explicit meter zero', native: [20, 10], meter: [0, 0], expected: [0, 0] },
    { name: 'explicit native zero', native: [0, 0], meter: [null, null], expected: [0, 0] },
    { name: 'unknown counters', native: [null, null], meter: [null, null], expected: [null, null] },
    { name: 'partially known native receipt', native: [20, null], meter: [null, null], expected: [20, null] },
    { name: 'meter without native receipt', native: null, meter: [4, 3], expected: [4, 3] },
    { name: 'unknown meter without native receipt', native: null, meter: [], expected: [null, null] },
  ];
  for (const value of cases) await t.test(value.name, () => {
    const native = value.native === null ? [] : [{ key: 'local:task-1', provider: 'OLLAMA', model: 'qwen:fixture', inputTokens: value.native[0], outputTokens: value.native[1] }];
    const view = usageView(native, [{ ...meta(), startedAt: now, usage: { inputTokens: value.meter[0], outputTokens: value.meter[1] }, estimate: null, status: 'UNCERTAIN' }]);
    assert.equal(view.totalAttempts, 1);
    assert.deepEqual([view.attempts[0].inputTokens, view.attempts[0].outputTokens], value.expected);
    for (const [index, field] of ['input', 'output'].entries()) {
      assert.equal(view.groups[0][`${field}Known`], String(value.expected[index] ?? 0));
      assert.equal(view.groups[0][`${field}Unknown`], Number(value.expected[index] === null));
    }
  });
});
test('Costs retains native token counts when journal completion persistence fails and after reopen', async t => {
  const { j, directory } = setup(t), append = j.append.bind(j);
  j.append = (key, type, data) => { if (type === 'run-finish') throw new Error('disk full'); return append(key, type, data); };
  const result = await j.measure(meta(), async () => ({ prompt_eval_count: 22, eval_count: 0 }));
  const creativeServices = { list: () => [{ id: 'task-1', model: 'qwen:fixture', status: 'completed', createdAt: now,
    report: { usage: { inputTokens: result.prompt_eval_count, outputTokens: result.eval_count } } }], issues: [] };
  const verify = journal => {
    const snapshot = resourceSnapshot(journal, creativeServices);
    assert.equal(snapshot.runs[0].status, 'UNCERTAIN');
    assert.equal(snapshot.runs[0].usage.inputTokens, null);
    assert.equal(snapshot.runs[0].usage.outputTokens, null);
    assert.equal(snapshot.usage.totalAttempts, 1);
    assert.deepEqual([snapshot.usage.attempts[0].inputTokens, snapshot.usage.attempts[0].outputTokens], [22, 0]);
    assert.equal(snapshot.usage.attempts[0].status, 'completed');
    assert.equal(snapshot.usage.attempts[0].cost, null);
    assert.equal(snapshot.usage.attempts[0].estimate, null);
    assert.equal(snapshot.usage.groups[0].inputKnown, '22');
    assert.equal(snapshot.usage.groups[0].outputKnown, '0');
    assert.equal(snapshot.usage.groups[0].inputUnknown, 0);
    assert.equal(snapshot.usage.groups[0].outputUnknown, 0);
  };
  assert.equal(j.snapshot().degraded, true); verify(j); j.close();
  const reopened = new ResourceJournal(directory, 'qimovi', 'project-1');
  try { verify(reopened); } finally { reopened.close(); }
});
test('unknown tasks do not disappear when known subtotals are displayed', () => {
  const view = usageView([{ key: '1', provider: 'P', model: 'M', origin: 'X', inputTokens: 10, outputTokens: 4 }, { key: '2', provider: 'P', model: 'M', origin: 'X', inputTokens: null, outputTokens: null }], []);
  assert.equal(view.groups[0].inputKnown, '10'); assert.equal(view.groups[0].inputUnknown, 1);
});
test('HTTP audit excludes credentials, polls, query text and the accounting view itself', t => {
  const { j } = setup(t), res = new EventEmitter(); res.statusCode = 200; res.writableFinished = true;
  j.observeRequest({ method: 'POST' }, res, '/api/records/PRIVATE_SCRIPT_ID'); res.emit('finish'); res.emit('close');
  j.observeRequest({ method: 'GET' }, res, '/api/resource-accounting'); j.observeRequest({ method: 'POST' }, res, '/api/session');
  assert.equal(j.snapshot().requestActivity.finished, 1); assert.equal(JSON.stringify(j.export()).includes('PRIVATE_SCRIPT_ID'), false);
});
test('journal reopen preserves receipts, marks interrupted runs uncertain, detects tampering', t => {
  const { j, directory } = setup(t); j.append('run:unfinished:start', 'run-start', { ...meta({ id: 'unfinished' }), rate: null, startedAt: now }); j.close();
  const next = new ResourceJournal(directory, 'qimovi', 'project-1'); assert.equal(next.snapshot().runs[0].status, 'UNCERTAIN');
  assert.throws(() => next.db.prepare('DELETE FROM resource_events').run(), /RESOURCE_APPEND_ONLY/); next.close();
  const db = new DatabaseSync(path.join(directory, 'resource-accounting.sqlite')); db.exec('DROP TRIGGER resource_no_update'); db.prepare('UPDATE resource_events SET event_hash=? WHERE sequence=1').run('0'.repeat(64)); db.close();
  assert.throws(() => new ResourceJournal(directory, 'qimovi', 'project-1'), /RESOURCE_JOURNAL_CORRUPT/);
});
test('unsafe journal paths disable inference without preventing access to authored storage', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-resource-path-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'target'), 'keep'); fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'resource-accounting.sqlite'));
  const j = openResourceJournal(dir, 'qimovi', 'p'); assert.equal(j.degraded, true); assert.throws(() => j.measure(meta(), () => {}), /RESOURCE_UNAVAILABLE/);
  assert.equal(fs.readFileSync(path.join(dir, 'target'), 'utf8'), 'keep');
});
