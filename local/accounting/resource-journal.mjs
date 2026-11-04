import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { need, exact, text, iso, validateRate, validateEntry, entryTotals, metrics, ollamaMetrics, estimate } from './resource-math.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const GENESIS = '0'.repeat(64), MAX_EVENTS = 20000;

/** Private diagnostic/usage journal. Never writes creative state or financial approval.
 * Keep this separate from the expense budget: a request is not a bill or payment. */
export class ResourceJournal {
  constructor(directory, app, projectId, { now = () => new Date().toISOString() } = {}) {
    need(['qimovi', 'qiscreenwrite'].includes(app) && text(projectId), 'RESOURCE_SCOPE_INVALID');
    this.app = app; this.projectId = projectId; this.now = now; this.degraded = false; this.active = new Set();
    const filename = path.join(directory, 'resource-accounting.sqlite');
    for (const name of [filename, `${filename}-wal`, `${filename}-shm`]) {
      try { const s = fs.lstatSync(name); need(s.isFile() && !s.isSymbolicLink() && (s.mode & 0o077) === 0, 'RESOURCE_STORAGE_UNSAFE', 409); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (!fs.existsSync(filename)) fs.closeSync(fs.openSync(filename, 'wx', 0o600));
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS resource_events(sequence INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS resource_no_update BEFORE UPDATE ON resource_events BEGIN SELECT RAISE(ABORT,'RESOURCE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS resource_no_delete BEFORE DELETE ON resource_events BEGIN SELECT RAISE(ABORT,'RESOURCE_APPEND_ONLY'); END;`);
    try { this.read(); } catch (e) { this.db.close(); throw e; }
  }
  read() {
    const rows = this.db.prepare('SELECT * FROM resource_events ORDER BY sequence LIMIT ?').all(MAX_EVENTS + 1); need(rows.length <= MAX_EVENTS, 'RESOURCE_EVENT_LIMIT', 413);
    let previous = GENESIS;
    return rows.map((r, index) => {
      need(r.sequence === index + 1 && r.previous_hash === previous && r.event_hash === hash(`${r.sequence}\n${r.key}\n${previous}\n${r.payload}`), 'RESOURCE_JOURNAL_CORRUPT', 409);
      const e = JSON.parse(r.payload); need(e.app === this.app && e.projectId === this.projectId && iso(e.at), 'RESOURCE_PROJECT_MISMATCH', 409); previous = r.event_hash;
      return { sequence: r.sequence, key: r.key, previousHash: r.previous_hash, hash: r.event_hash, ...e };
    });
  }
  append(key, type, data) {
    need(text(key, 512) && text(type, 40), 'RESOURCE_EVENT_INVALID');
    const snapshot = stable(data); need(Buffer.byteLength(snapshot) <= 4096, 'RESOURCE_EVENT_TOO_LARGE', 413);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT payload FROM resource_events WHERE key=?').get(key);
      if (prior) { const old = JSON.parse(prior.payload); need(old.type === type && stable(old.data) === snapshot, 'RESOURCE_REPLAY_CONFLICT', 409); this.db.exec('COMMIT'); return { replayed: true }; }
      const tail = this.db.prepare('SELECT sequence,event_hash FROM resource_events ORDER BY sequence DESC LIMIT 1').get();
      const sequence = (tail?.sequence ?? 0) + 1; need(sequence <= MAX_EVENTS, 'RESOURCE_EVENT_LIMIT', 413);
      const payload = stable({ app: this.app, projectId: this.projectId, at: this.now(), type, data: JSON.parse(snapshot) }), previous = tail?.event_hash ?? GENESIS;
      this.db.prepare('INSERT INTO resource_events VALUES(?,?,?,?,?)').run(sequence, key, previous, hash(`${sequence}\n${key}\n${previous}\n${payload}`), payload);
      this.db.exec('COMMIT'); return { replayed: false };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  setRate(rate) { validateRate(rate); return this.append(`rate:${rate.id}`, 'rate', rate); }
  rate(provider, model) { return this.read().filter(e => e.type === 'rate' && e.data.provider === provider && e.data.model === model).at(-1)?.data ?? null; }
  record(entry) { validateEntry(entry); return this.append(`entry:${entry.id}`, 'entry', entry); }
  quote(input) {
    exact(input, ['provider', 'model', 'local', 'usage']); need(text(input.provider) && text(input.model) && typeof input.local === 'boolean', 'RESOURCE_QUOTE_INVALID');
    return { ...estimate(input.usage, this.rate(input.provider, input.model), { local: input.local, at: this.now() }), authority: 'ESTIMATE_ONLY', spendAuthorized: false };
  }
  // Durable start precedes the provider call. Metering is independent of whether
  // the returned text later passes semantic validation. A timed-out call is not free.
  async measure(meta, fn) {
    exact(meta, ['id', 'provider', 'model', 'taskId', 'local', 'requestHash']);
    for (const k of ['id', 'provider', 'model', 'taskId']) need(text(meta[k]), 'RESOURCE_RUN_INVALID');
    need(typeof meta.local === 'boolean' && /^[a-f0-9]{64}$/.test(meta.requestHash), 'RESOURCE_RUN_INVALID');
    const prior = this.read().some(e => e.type === 'run-start' && e.data.id === meta.id);
    need(!prior, 'RESOURCE_RUN_ALREADY_STARTED', 409);
    const startedAt = this.now(), rate = this.rate(meta.provider, meta.model), start = performance.now();
    this.append(`run:${meta.id}:start`, 'run-start', { ...meta, rate, startedAt }); this.active.add(meta.id);
    let result, failure;
    try { result = await fn(); return result; } catch (e) { failure = e; throw e; }
    finally {
      const usage = ollamaMetrics(result, Math.ceil(performance.now() - start));
      try { this.append(`run:${meta.id}:finish`, 'run-finish', { id: meta.id, status: failure ? 'FAILED_OR_UNCERTAIN' : 'PROVIDER_RETURNED', usage,
        estimate: estimate(usage, rate, { local: meta.local, at: startedAt }) }); }
      catch { this.degraded = true; /* Never turn a completed side effect into a retry suggestion. */ }
      this.active.delete(meta.id);
    }
  }
  observeRequest(req, res, pathname) {
    // Exclude credentials, routine polling and this journal's own reads. No body,
    // query, title, filesystem path or URL is stored. HTTP time is not human labor.
    if (!pathname.startsWith('/api/') || /^\/api\/(?:resource-accounting|session|health|bootstrap|security)(?:\/|$)/.test(pathname)) return;
    if (['GET', 'HEAD'].includes(req.method) && !/\/(?:export|backup|download)(?:\/|$)/.test(pathname)) return;
    const category = pathname.split('/')[2];
    const family = /^(?:records|brands|brand-financing|creative-services|model-assistance|studio|higgsfield|dcc|blender|resolve|opencreator|media-takes|storyboard|production-budget|usage-accounting|project-library|caniscreenwrite|connectors|pocket-exchange|phone|phone-previz|writing-production|production-attachment|legacy-production-revision|writing-recovery|recovery|development-recovery|rights|preservation|preservation-integrity|asset-token|comic-packages|node-workflow|admission)$/.test(category) ? category : 'other';
    const id = crypto.randomUUID(), start = performance.now();
    try { this.append(`http:${id}:start`, 'http-start', { id, family, method: req.method }); }
    catch { this.degraded = true; return; } // Authored saves remain usable if diagnostics fill up.
    let done = false;
    const finish = () => { if (done) return; done = true;
      try { this.append(`http:${id}:finish`, 'http-finish', { id, elapsedMs: Math.ceil(performance.now() - start), httpStatus: res.statusCode, disconnected: !res.writableFinished }); }
      catch { this.degraded = true; }
    };
    res.once('finish', finish); res.once('close', finish);
  }
  snapshot() {
    const events = this.read(), starts = events.filter(e => e.type === 'run-start'), finishes = new Map(events.filter(e => e.type === 'run-finish').map(e => [e.data.id, e.data]));
    const runs = starts.map(e => ({ ...e.data, startedAt: e.at, ...(finishes.get(e.data.id) ?? { status: this.active.has(e.data.id) ? 'RUNNING' : 'UNCERTAIN', usage: metrics(), estimate: null }) }));
    const sumCounter = key => { const known = runs.reduce((n, r) => n + BigInt(r.usage[key] ?? 0), 0n); need(known <= BigInt(Number.MAX_SAFE_INTEGER), 'RESOURCE_COUNTER_OVERFLOW', 413); return { known: Number(known), unknown: runs.filter(r => r.usage[key] === null).length }; };
    const counts = new Map(); for (const e of events.filter(e => e.type === 'http-start')) counts.set(e.data.family, (counts.get(e.data.family) ?? 0) + 1);
    const httpStarted = events.filter(e => e.type === 'http-start').length, httpFinished = events.filter(e => e.type === 'http-finish').length;
    const entries = events.filter(e => e.type === 'entry').map(e => e.data);
    return { schema: 'qi-resource-accounting/v1', app: this.app, projectId: this.projectId, authority: 'OBSERVATION_ONLY', spendAuthorized: false,
      degraded: this.degraded || events.length >= MAX_EVENTS, eventCount: events.length, eventLimit: MAX_EVENTS, headHash: events.at(-1)?.hash ?? GENESIS,
      runs, inputTokens: sumCounter('inputTokens'), outputTokens: sumCounter('outputTokens'),
      requestActivity: { started: httpStarted, finished: httpFinished, unresolved: httpStarted - httpFinished, byFamily: [...counts].map(([family, count]) => ({ family, count })) },
      entries, entryTotals: entryTotals(entries), rates: events.filter(e => e.type === 'rate').map(e => e.data),
      coverage: { hardwareEnergy: 'UNMETERED', humanTime: 'MANUAL_ONLY', hostedServices: 'EXISTING_RECEIPTS_OR_MANUAL', outsideApplications: 'UNOBSERVED',
        httpTiming: 'REQUEST_WALL_TIME_NOT_CPU_OR_JOB_TIME', monetaryEstimates: 'OWNER_RATES_NOT_INVOICES', automaticSpendLimits: 'NOT_IMPLEMENTED',
        backup: 'EXPORT_RESOURCE_JOURNAL_SEPARATELY; STANDARD_CREATIVE_BACKUP_DOES_NOT_INCLUDE_THIS_DATABASE' } };
  }
  export() { const events = this.read(); return { schema: 'qi-resource-journal/v1', app: this.app, projectId: this.projectId, events, exportedAt: this.now(), notice: 'Private accounting metadata; no screenplay text. Not an invoice or financial authorization.' }; }
  close() { this.db.close(); }
}

/** A broken diagnostic database must not lock the author out of their writing.
 * It does block newly metered inference; existing authoring storage is untouched. */
export function openResourceJournal(directory, app, projectId) {
  try { return new ResourceJournal(directory, app, projectId); }
  catch {
    const unavailable = () => { throw Object.assign(new Error('RESOURCE_UNAVAILABLE'), { code: 'RESOURCE_UNAVAILABLE', status: 503 }); };
    return { degraded: true, snapshot: unavailable, export: unavailable, setRate: unavailable, record: unavailable, quote: unavailable,
      measure: unavailable, observeRequest() {}, close() {} };
  }
}
