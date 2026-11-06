import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { canonical, digest, exact, need, validateConfig, scorePredictions, better, decide, REQUIRED_CHECKS } from './evaluator.mjs';

const GENESIS = '0'.repeat(64), MAX_EVENTS = 10000, MAX_RUNS = 200;
const SHA = /^[a-f0-9]{64}$/;
export const POLICY = Object.freeze({ schema: 'qi-research-policy/v1', scope: 'RESEARCH_CONFIGURATION_ONLY',
  maxTrials: 24, maxWallMs: 300000, trialTimeoutMs: 10000,
  requiredChecks: REQUIRED_CHECKS, selection: 'MORE_CORRECT_OR_EQUAL_WITH_FEWER_ACTIVE_WEIGHTS',
  confirmation: 'ONE_FINALIST_PER_RUN', provider: 'NONE', autoResume: false });
const fault = (code, status = 409) => Object.assign(new Error(code), { code, status });
const clone = value => JSON.parse(canonical(value));
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

function validateTarget(target) {
  exact(target, ['id', 'title', 'description', 'baseline', 'candidates', 'documents', 'development', 'confirmation']);
  for (const key of ['id', 'title', 'description']) need(typeof target[key] === 'string' && target[key].length > 0 && target[key].length <= 1200, 'RESEARCH_TARGET_INVALID');
  validateConfig(target.baseline);
  need(Array.isArray(target.candidates) && target.candidates.length > 0 && target.candidates.length <= POLICY.maxTrials, 'RESEARCH_TARGET_INVALID');
  target.candidates.forEach(validateConfig);
  need(new Set(target.candidates.map(digest)).size === target.candidates.length, 'RESEARCH_DUPLICATE_CANDIDATES');
  need(Array.isArray(target.documents) && target.documents.length >= 3 && target.documents.length <= 200, 'RESEARCH_TARGET_INVALID');
  const ids = new Set();
  for (const doc of target.documents) {
    exact(doc, ['id', 'title', 'text', 'tags']);
    need(typeof doc.id === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(doc.id) && !ids.has(doc.id), 'RESEARCH_TARGET_INVALID'); ids.add(doc.id);
    for (const key of ['title', 'text']) need(typeof doc[key] === 'string' && doc[key].length <= 8000, 'RESEARCH_TARGET_INVALID');
    need(Array.isArray(doc.tags) && doc.tags.length <= 20 && doc.tags.every(t => typeof t === 'string' && t.length <= 200), 'RESEARCH_TARGET_INVALID');
  }
  const queryIds = new Set();
  for (const split of ['development', 'confirmation']) {
    need(Array.isArray(target[split]) && target[split].length >= 1 && target[split].length <= 64, 'RESEARCH_TARGET_INVALID');
    for (const query of target[split]) {
      exact(query, ['id', 'query', 'relevantIds']);
      need(typeof query.id === 'string' && query.id.length <= 100 && !queryIds.has(query.id)
        && typeof query.query === 'string' && query.query.length > 0 && query.query.length <= 1000
        && Array.isArray(query.relevantIds) && query.relevantIds.length > 0 && query.relevantIds.every(id => ids.has(id)), 'RESEARCH_TARGET_INVALID');
      queryIds.add(query.id);
    }
  }
  return freeze(clone(target));
}

/** Fixed code only. Termination is enforced by the parent, including workers
 * that never respond. Labels are removed before crossing the worker boundary. */
export function runTrial({ config, documents, queries, timeoutMs, signal, workerUrl = new URL('./trial-worker.mjs', import.meta.url) }) {
  validateConfig(config);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fault('RESEARCH_CANCELLED'));
    const worker = new Worker(workerUrl, { workerData: { config, documents, queries: queries.map(q => ({ id: q.id, query: q.query })) },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, execArgv: [] });
    let done = false;
    const finish = async (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      // No worker survives a success, failure, timeout or cancellation.
      try { await worker.terminate(); } catch { /* Already exited. */ }
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => { void finish(fault('RESEARCH_CANCELLED')); };
    const timer = setTimeout(() => { void finish(fault('RESEARCH_TRIAL_TIMEOUT')); }, Math.max(1, timeoutMs));
    signal?.addEventListener('abort', cancel, { once: true });
    worker.once('message', value => { void finish(null, value); });
    worker.once('error', () => { void finish(fault('RESEARCH_WORKER_ERROR')); });
    worker.once('exit', () => { if (!done) void finish(fault('RESEARCH_WORKER_EXIT')); });
    if (signal?.aborted) cancel();
  });
}

export class ResearchLoop {
  constructor({ directory, app, projectId, readSourceHash, withSourceLock = fn => fn(), resourceJournal, target }) {
    need(['qimovi', 'qiscreenwrite'].includes(app) && typeof projectId === 'string' && projectId.length > 0, 'RESEARCH_SCOPE_INVALID');
    need(typeof readSourceHash === 'function' && typeof withSourceLock === 'function', 'RESEARCH_SOURCE_GUARD_REQUIRED');
    this.app = app; this.projectId = projectId; this.readSourceHash = readSourceHash; this.withSourceLock = withSourceLock;
    this.resourceJournal = resourceJournal; this.target = validateTarget(target); this.active = null; this.pending = null; this.closed = false; this.degraded = false;
    this.runner = runTrial;
    this.datasetHash = digest({ documents: this.target.documents, development: this.target.development, confirmation: this.target.confirmation });
    this.evaluatorHash = digest(['evaluator.mjs', 'trial-worker.mjs'].map(name => fs.readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n'));
    this.policyHash = digest({ policy: POLICY, baseline: target.baseline, candidates: target.candidates,
      controller: fs.readFileSync(new URL('engine.mjs', import.meta.url), 'utf8') });
    const filename = path.join(directory, 'research-loop.sqlite');
    for (const name of [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`]) {
      try { const stat = fs.lstatSync(name); need(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'RESEARCH_STORAGE_UNSAFE', 409); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!fs.existsSync(filename)) fs.closeSync(fs.openSync(filename, 'wx', 0o600));
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS research_events(sequence INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS research_no_update BEFORE UPDATE ON research_events BEGIN SELECT RAISE(ABORT,'RESEARCH_APPEND_ONLY'); END;
        CREATE TRIGGER IF NOT EXISTS research_no_delete BEFORE DELETE ON research_events BEGIN SELECT RAISE(ABORT,'RESEARCH_APPEND_ONLY'); END;`);
      const events = this.read();
      if (!events.length) this.append('initialize', { targetId: target.id, datasetHash: this.datasetHash, evaluatorHash: this.evaluatorHash, policyHash: this.policyHash });
      else need(events[0].type === 'initialize' && canonical(events[0].data) === canonical({ targetId: target.id, datasetHash: this.datasetHash, evaluatorHash: this.evaluatorHash, policyHash: this.policyHash }), 'RESEARCH_POLICY_CHANGED', 409);
      this.accepted();
    } catch (error) { this.db.close(); throw error; }
  }
  read() {
    const rows = this.db.prepare('SELECT * FROM research_events ORDER BY sequence LIMIT ?').all(MAX_EVENTS + 1);
    need(rows.length <= MAX_EVENTS, 'RESEARCH_EVENT_LIMIT', 413);
    let previous = GENESIS;
    return rows.map((row, index) => {
      need(row.sequence === index + 1 && row.previous_hash === previous
        && row.event_hash === digest(`${row.sequence}\n${previous}\n${row.payload}`), 'RESEARCH_LEDGER_CORRUPT', 409);
      const event = JSON.parse(row.payload);
      need(event.app === this.app && event.projectId === this.projectId && typeof event.type === 'string', 'RESEARCH_SCOPE_INVALID', 409);
      previous = row.event_hash;
      return { sequence: row.sequence, previousHash: row.previous_hash, hash: row.event_hash, ...event };
    });
  }
  append(type, data, inside = false) {
    const payload = canonical({ app: this.app, projectId: this.projectId, at: new Date().toISOString(), type, data });
    need(Buffer.byteLength(payload) <= 65536, 'RESEARCH_EVENT_TOO_LARGE', 413);
    if (!inside) this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.read(), sequence = rows.length + 1, previous = rows.at(-1)?.hash ?? GENESIS;
      need(sequence <= MAX_EVENTS, 'RESEARCH_EVENT_LIMIT', 413);
      this.db.prepare('INSERT INTO research_events VALUES(?,?,?,?)').run(sequence, previous, digest(`${sequence}\n${previous}\n${payload}`), payload);
      if (!inside) this.db.exec('COMMIT');
    } catch (error) { if (!inside) this.db.exec('ROLLBACK'); throw error; }
  }
  stateHash(config, version) { return digest({ config, version, targetId: this.target.id, datasetHash: this.datasetHash, policyHash: this.policyHash }); }
  accepted(events = this.read()) {
    let state = { config: clone(this.target.baseline), version: 0, hash: this.stateHash(this.target.baseline, 0) };
    for (const event of events) if (event.type === 'run-finish' && event.data.decision === 'COMMIT') {
      const data = event.data; validateConfig(data.config);
      need(data.preStateHash === state.hash && data.postStateHash === this.stateHash(data.config, state.version + 1)
        && decide({ checks: data.checks, improved: data.confirmedImprovement, omega: data.omega }) === 'COMMIT', 'RESEARCH_STATE_CORRUPT', 409);
      state = { config: clone(data.config), version: state.version + 1, hash: data.postStateHash };
    }
    return state;
  }
  snapshot() {
    const events = this.read(), finishes = new Map(events.filter(e => e.type === 'run-finish').map(e => [e.data.id, e.data]));
    const runs = events.filter(e => e.type === 'run-start').map(e => {
      const finished = finishes.get(e.data.id), active = this.active?.id === e.data.id ? this.active : null;
      return { ...e.data, status: active ? 'RUNNING' : 'INTERRUPTED', reason: active ? null : 'PROCESS_STOPPED_WITHOUT_FINAL_RECORD',
        completedTrials: active?.completedTrials ?? events.filter(t => t.type === 'trial' && t.data.id === e.data.id).length,
        decision: null, finishedAt: null, elapsedMs: active ? Math.ceil(performance.now() - active.start) : null,
        development: null, confirmation: null, resources: null, ...finished };
    }).reverse();
    return { schema: 'qi-research-loop/v1', app: this.app, projectId: this.projectId,
      target: { id: this.target.id, title: this.target.title, description: this.target.description },
      contract: { ...POLICY, datasetHash: this.datasetHash, evaluatorHash: this.evaluatorHash, policyHash: this.policyHash, baseline: this.target.baseline,
        candidateCount: this.target.candidates.length, dataBasis: 'PUBLIC_SYNTHETIC_FIXTURE',
        independence: 'SPLIT_WITHIN_ONE_RUN; REPEATED_RUNS_REUSE_PUBLIC_LABELS',
        isolation: 'FIXED_WORKER_NOT_ARBITRARY_CODE_SANDBOX' },
      accepted: this.accepted(events), active: this.active ? { id: this.active.id, status: 'RUNNING', completedTrials: this.active.completedTrials, maxTrials: this.active.maxTrials } : null,
      runs: runs.slice(0, 20), events: events.slice(-100), degraded: this.degraded };
  }
  start(input) {
    exact(input, ['projectId', 'requestId', 'maxTrials', 'maxWallMs', 'trialTimeoutMs']);
    need(input.projectId === this.projectId, 'RESEARCH_PROJECT_MISMATCH', 409);
    need(typeof input.requestId === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(input.requestId), 'RESEARCH_REQUEST_ID_INVALID');
    need(Number.isSafeInteger(input.maxTrials) && input.maxTrials >= 1 && input.maxTrials <= POLICY.maxTrials
      && Number.isSafeInteger(input.maxWallMs) && input.maxWallMs >= 100 && input.maxWallMs <= POLICY.maxWallMs
      && Number.isSafeInteger(input.trialTimeoutMs) && input.trialTimeoutMs >= 10 && input.trialTimeoutMs <= POLICY.trialTimeoutMs
      && input.trialTimeoutMs <= input.maxWallMs, 'RESEARCH_BUDGET_INVALID');
    const requestHash = digest(input), events = this.read(), prior = events.find(e => e.type === 'run-start' && e.data.requestId === input.requestId);
    if (prior) { need(prior.data.requestHash === requestHash, 'RESEARCH_REPLAY_CONFLICT', 409); return this.snapshot(); }
    need(!this.closed && !this.degraded, 'RESEARCH_UNAVAILABLE', 503);
    need(!this.active, 'RESEARCH_ALREADY_RUNNING', 409);
    need(events.filter(e => e.type === 'run-start').length < MAX_RUNS && events.length + input.maxTrials + 8 <= MAX_EVENTS, 'RESEARCH_EVENT_LIMIT', 413);
    need(!this.resourceJournal.degraded && !this.resourceJournal.snapshot().degraded && typeof this.resourceJournal.append === 'function', 'RESEARCH_ACCOUNTING_UNAVAILABLE', 503);
    const sourceHash = this.readSourceHash(); need(SHA.test(sourceHash), 'RESEARCH_SOURCE_INVALID', 409);
    const accepted = this.accepted(events), id = crypto.randomUUID(), startedAt = new Date().toISOString();
    const run = { ...clone(input), id, requestHash, startedAt, sourceHash, preStateHash: accepted.hash, policyHash: this.policyHash, datasetHash: this.datasetHash, evaluatorHash: this.evaluatorHash };
    this.append('run-start', run);
    const active = { ...run, start: performance.now(), completedTrials: 0, controller: new AbortController(), accepted,
      resources: { inputTokens: 0, outputTokens: 0, providerCostUsd: '0', energyKwh: null, cpuMicros: 0, resultBytes: 0, elapsedMs: 0 }, cpuComplete: true };
    this.active = active;
    try { this.resourceJournal.append(`research:${id}:start`, 'research-start', { id, targetId: this.target.id, startedAt, maxTrials: input.maxTrials, scope: POLICY.scope }); }
    catch { this.append('run-finish', { id, status: 'FAILED', reason: 'RESEARCH_ACCOUNTING_UNAVAILABLE', decision: 'ESCALATE', completedTrials: 0,
      finishedAt: new Date().toISOString(), elapsedMs: 0, preStateHash: accepted.hash, postStateHash: accepted.hash, resources: active.resources }); this.active = null; throw fault('RESEARCH_ACCOUNTING_UNAVAILABLE', 503); }
    this.pending = Promise.resolve().then(() => this.execute(active)).catch(() => { this.degraded = true; }).finally(() => { this.active = null; this.pending = null; });
    return this.snapshot();
  }
  cancel(input) {
    exact(input, ['projectId', 'runId']);
    need(input.projectId === this.projectId, 'RESEARCH_PROJECT_MISMATCH', 409);
    need(typeof input.runId === 'string' && this.read().some(e => e.type === 'run-start' && e.data.id === input.runId), 'RESEARCH_RUN_NOT_FOUND', 404);
    if (this.active?.id === input.runId) this.active.controller.abort();
    return this.snapshot();
  }
  remaining(active) { return active.maxWallMs - (performance.now() - active.start); }
  async evaluate(config, split, active) {
    need(!active.controller.signal.aborted, 'RESEARCH_CANCELLED', 409);
    need(this.remaining(active) > 0, 'RESEARCH_DEADLINE', 409);
    const start = performance.now();
    try {
      const result = await this.runner({ config, documents: this.target.documents, queries: this.target[split],
        timeoutMs: Math.min(active.trialTimeoutMs, this.remaining(active)), signal: active.controller.signal });
      exact(result, ['predictions', 'workerElapsedMs', 'cpuMicros']);
      need(result.cpuMicros === null || Number.isSafeInteger(result.cpuMicros) && result.cpuMicros >= 0, 'RESEARCH_USAGE_INVALID');
      const bytes = Buffer.byteLength(canonical(result));
      need(bytes <= 65536, 'RESEARCH_RESULT_TOO_LARGE', 413);
      active.resources.resultBytes += bytes;
      if (result.cpuMicros === null) active.cpuComplete = false; else active.resources.cpuMicros += result.cpuMicros;
      const score = scorePredictions(result.predictions, this.target[split], this.target.documents);
      return { score, predictions: result.predictions, elapsedMs: Math.ceil(performance.now() - start), cpuMicros: result.cpuMicros, resultBytes: bytes };
    } catch (error) { active.cpuComplete = false; throw error; }
  }
  async execute(active) {
    let status = 'COMPLETED', reason = 'NO_CONFIRMED_GAIN', development = null, confirmation = null, selected = null, confirmedImprovement = false;
    let sawReplay = false, verification = 'PASS';
    try {
      const baseline = await this.evaluate(active.accepted.config, 'development', active);
      this.append('baseline', { id: active.id, ...baseline });
      let best = { config: active.accepted.config, result: baseline };
      const candidates = this.target.candidates.filter(c => digest(c) !== digest(active.accepted.config)).slice(0, active.maxTrials);
      for (const config of candidates) {
        need(!active.controller.signal.aborted, 'RESEARCH_CANCELLED', 409);
        need(this.remaining(active) > 0, 'RESEARCH_DEADLINE', 409);
        active.completedTrials++;
        const contentHash = digest(config), pair = digest({ contentHash, preStateHash: active.preStateHash });
        const replay = this.read().some(e => e.type === 'trial' && e.data.pair === pair);
        if (replay) { sawReplay = true; this.append('trial', { id: active.id, config, contentHash, pair, preStateHash: active.preStateHash, decision: 'ESCALATE', reason: 'REPLAY_PAIR', checks: { verification: 'SKIPPED' } }); continue; }
        try {
          const result = await this.evaluate(config, 'development', active);
          this.append('trial', { id: active.id, config, contentHash, pair, preStateHash: active.preStateHash,
            decision: 'DAMP', reason: 'DEVELOPMENT_ONLY', checks: { shape: 'PASS', verification: 'PASS' }, ...result });
          if (better(result.score, config, best.result.score, best.config)) best = { config, result };
        } catch (error) {
          this.append('trial', { id: active.id, config, contentHash, pair, preStateHash: active.preStateHash, decision: 'REJECT',
            reason: /^RESEARCH_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'RESEARCH_WORKER_ERROR', checks: { shape: 'PASS', verification: 'ERROR' }, score: null });
          if (active.controller.signal.aborted || this.remaining(active) <= 0) throw error;
        }
      }
      development = { baseline: baseline.score, candidate: best.result.score };
      if (digest(best.config) !== digest(active.accepted.config)) {
        selected = best.config;
        // Freeze the finalist before looking at confirmation results. No later
        // candidate can use confirmation feedback within this run.
        this.append('finalist', { id: active.id, config: selected, development });
        const incumbent = await this.evaluate(active.accepted.config, 'confirmation', active);
        const candidate = await this.evaluate(selected, 'confirmation', active);
        confirmation = { baseline: incumbent.score, candidate: candidate.score };
        this.append('confirmation', { id: active.id, incumbent, candidate });
        confirmedImprovement = better(candidate.score, selected, incumbent.score, active.accepted.config);
        if (confirmedImprovement) reason = 'CONFIRMED_FIXTURE_IMPROVEMENT';
      } else if (sawReplay) reason = 'REPLAY_PAIR';
    } catch (error) {
      status = active.controller.signal.aborted ? 'CANCELLED' : this.remaining(active) <= 0 ? 'TIMED_OUT' : 'FAILED';
      reason = /^RESEARCH_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'RESEARCH_EXECUTION_ERROR'; verification = 'ERROR';
    }
    active.resources.elapsedMs = Math.ceil(performance.now() - active.start);
    if (!active.cpuComplete) active.resources.cpuMicros = null;
    let accounting = 'PASS';
    try { this.resourceJournal.append(`research:${active.id}:finish`, 'research-finish', { id: active.id, status: 'EVALUATION_FINISHED',
      evaluationElapsedMs: active.resources.elapsedMs, completedTrials: active.completedTrials, resources: active.resources }); }
    catch { accounting = 'ERROR'; reason = 'RESEARCH_ACCOUNTING_UNAVAILABLE'; this.degraded = true; }
    // Both locks are synchronous. No owner save can interleave source validation
    // with COMMIT, and a second process respecting SQLite locks cannot race it.
    let outcome;
    this.withSourceLock(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const accepted = this.accepted(), stale = this.readSourceHash() !== active.sourceHash || accepted.hash !== active.preStateHash;
        const withinBudget = !active.controller.signal.aborted && this.remaining(active) > 0;
        const checks = { shape: 'PASS', scope: 'PASS', verification, authority: 'PASS', source: stale ? 'FAIL' : 'PASS', budget: withinBudget ? 'PASS' : 'FAIL', accounting };
        const decision = decide({ checks, stale, replay: !selected && sawReplay, improved: confirmedImprovement, omega: null });
        if (stale) reason = 'SOURCE_OR_ACCEPTED_STATE_CHANGED';
        else if (!withinBudget) { reason = active.controller.signal.aborted ? 'RESEARCH_CANCELLED' : 'RESEARCH_DEADLINE'; status = active.controller.signal.aborted ? 'CANCELLED' : 'TIMED_OUT'; }
        active.resources.elapsedMs = Math.ceil(performance.now() - active.start);
        this.append('run-finish', { id: active.id, status, reason, decision, completedTrials: active.completedTrials,
          startedAt: active.startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.ceil(performance.now() - active.start),
          development, confirmation, resources: active.resources, config: selected, checks, confirmedImprovement, omega: null,
          preStateHash: accepted.hash, postStateHash: decision === 'COMMIT' ? this.stateHash(selected, accepted.version + 1) : accepted.hash }, true);
        this.db.exec('COMMIT');
        outcome = { id: active.id, status, decision, elapsedMs: Math.ceil(performance.now() - active.start), completedTrials: active.completedTrials,
          resources: { ...active.resources, elapsedMs: Math.ceil(performance.now() - active.start) }, elapsedBasis: 'THROUGH_RESEARCH_DECISION_EXCLUDES_FINAL_RECEIPT_WRITE' };
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
    // The preceding receipt proves consumption before admission. Only this
    // later receipt reports the terminal outcome; losing it leaves the outcome
    // uncertain in Costs, while the research ledger retains its own decision.
    if (accounting === 'PASS') {
      try { this.resourceJournal.append(`research:${active.id}:outcome`, 'research-outcome', outcome); }
      catch { this.degraded = true; this.resourceJournal.degraded = true; }
    }
  }
  export() { return { ...this.snapshot(), events: this.read(), notice: 'Synthetic research only. Hash chains are local integrity checks, not external anchors. Export separately from creative backups.' }; }
  async close() {
    if (this.closed) return; this.closed = true;
    this.active?.controller.abort();
    if (this.pending) await this.pending;
    this.db.close();
  }
}

/** Research faults never lock the owner out of their creative workspace. */
export function openResearchLoop(options) {
  try { return new ResearchLoop(options); }
  catch (error) {
    const code = /^RESEARCH_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'RESEARCH_UNAVAILABLE';
    const unavailable = () => { throw fault(code, 503); };
    return { snapshot: () => ({ schema: 'qi-research-loop/v1', app: options.app, projectId: options.projectId,
      target: { id: options.target.id, title: options.target.title, description: options.target.description },
      contract: POLICY, accepted: null, active: null, runs: [], events: [], degraded: true, error: code }),
      start: unavailable, cancel: unavailable, export: unavailable, close: async () => {} };
  }
}
