import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, LocalError, privateDirectory, atomicPrivateFile, sha256 } from './storage.mjs';
import { validateInput, validateOutput, validateReport, analysisMessages, outputSchema } from '../../shared/creative-services/contract.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const shared = fn => { try { return fn(); } catch (e) { throw new LocalError(/^ANALYSIS_[A-Z_]+$/.test(e?.code ?? '') ? e.code : 'ANALYSIS_INVALID', 422); } };
export function localModelEndpoint(value) {
  check(typeof value === 'string' && value.length <= 100, 'ANALYSIS_ENDPOINT_INVALID', 422);
  let url; try { url = new URL(value); } catch { throw new LocalError('ANALYSIS_ENDPOINT_INVALID', 422); }
  check(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?\/?$/.test(value)
    && Number(url.port || 80) >= 1024 && Number(url.port) <= 65535, 'ANALYSIS_ENDPOINT_INVALID', 422);
  // Use a numeric loopback address, avoiding hostname resolution/rebinding.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}
const remoteMetadata = m => !!(m?.remote_host || m?.remote_model || m?.cloud || m?.details?.remote_host || m?.details?.remote_model || m?.details?.cloud);
const localModel = m => m && typeof m.name === 'string' && m.name.length <= 200 && m.name.trim()
  && !/cloud/i.test(m.name) && !remoteMetadata(m)
  && typeof m.digest === 'string' && /^[a-f0-9]{64}$/i.test(m.digest) && Number.isSafeInteger(m.size) && m.size > 1024 * 1024;
async function readResponse(response) {
  check(response.ok, 'ANALYSIS_MODEL_UNAVAILABLE', 502);
  check(/^application\/json\b/i.test(response.headers.get('content-type') ?? ''), 'ANALYSIS_MODEL_RESPONSE_INVALID', 502);
  check(response.body, 'ANALYSIS_MODEL_RESPONSE_INVALID', 502);
  const reader = response.body.getReader(); const parts = []; let count = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      count += value.length; check(count <= 1024 * 1024, 'ANALYSIS_MODEL_RESPONSE_TOO_LARGE', 502); parts.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (e instanceof LocalError) throw e;
    throw new LocalError('ANALYSIS_MODEL_RESPONSE_INVALID', 502);
  }
}

/** Reports and request receipts are private files, never authored screenplay records. */
export class CreativeServices {
  constructor(directory, store, { fetcher = fetch, timeoutMs = 120000, resourceJournal = null } = {}) {
    this.resourceJournal = resourceJournal;
    this.directory = privateDirectory(path.join(directory, 'creative-analysis'));
    this.store = store; this.fetcher = fetcher; this.timeoutMs = timeoutMs; this.active = false;
    for (const job of this.list()) if (job.status === 'running') {
      this.write({ ...job, status: 'uncertain', error: 'ANALYSIS_INTERRUPTED' });
    }
  }
  file(id) { check(typeof id === 'string' && UUID.test(id), 'ANALYSIS_REQUEST_INVALID', 422); return path.join(this.directory, `${id.toLowerCase()}.json`); }
  write(job) { atomicPrivateFile(this.file(job.id), JSON.stringify(job)); return job; }
  get(id) {
    const file = this.file(id); if (!fs.existsSync(file)) return null;
    check(!fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).size <= 1024 * 1024, 'ANALYSIS_RECEIPT_INVALID', 409);
    let job; try { job = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new LocalError('ANALYSIS_RECEIPT_INVALID', 409); }
    check(exact(job, ['id', 'createdAt', 'input', 'endpoint', 'model', 'fingerprint', 'status', 'report', 'error']) && typeof job.id === 'string' && job.id.toLowerCase() === id.toLowerCase()
      && typeof job.createdAt === 'string' && Number.isFinite(Date.parse(job.createdAt)) && typeof job.model === 'string' && job.model.length <= 200
      && ['running', 'completed', 'failed', 'uncertain'].includes(job.status) && /^[a-f0-9]{64}$/.test(job.fingerprint), 'ANALYSIS_RECEIPT_INVALID', 409);
    shared(() => validateInput(job.input));
    check(localModelEndpoint(job.endpoint) === job.endpoint && job.fingerprint === sha256(JSON.stringify({ endpoint: job.endpoint, model: job.model, input: job.input })), 'ANALYSIS_RECEIPT_INVALID', 409);
    if (job.status === 'completed') {
      shared(() => validateReport(job.report));
      check(job.report.provider === 'ollama' && job.report.model === job.model && JSON.stringify(job.report.input) === JSON.stringify(job.input), 'ANALYSIS_RECEIPT_INVALID', 409);
    }
    else check(job.report === null, 'ANALYSIS_RECEIPT_INVALID', 409);
    return job;
  }
  list(draftId) {
    const jobs = []; this.issues = [];
    for (const file of fs.readdirSync(this.directory)) {
      if (!file.endsWith('.json') || !UUID.test(file.slice(0, -5))) continue;
      // Preserve malformed files; analysis history must never block writing.
      try {
        const job = this.get(file.slice(0, -5));
        if (job && (!draftId || job.input.source.draftId === draftId)) jobs.push(job);
      } catch { this.issues.push({ id: file.slice(0, -5), code: 'ANALYSIS_RECEIPT_INVALID' }); }
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async call(endpoint, route, data, timeoutMs = 8000) {
    try {
      return await readResponse(await this.fetcher(`${endpoint}${route}`, { method: data ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }));
    } catch (e) {
      if (e instanceof LocalError) throw e;
      throw new LocalError('ANALYSIS_MODEL_UNAVAILABLE', 502);
    }
  }
  async models(input) {
    check(exact(input, ['endpoint']), 'ANALYSIS_REQUEST_INVALID', 422);
    const endpoint = localModelEndpoint(input.endpoint);
    const result = await this.call(endpoint, '/api/tags');
    check(Array.isArray(result.models) && result.models.length <= 1000, 'ANALYSIS_MODEL_RESPONSE_INVALID', 502);
    return { endpoint, models: result.models.filter(localModel).map(m => ({ name: m.name, size: m.size, digest: m.digest })) };
  }
  async run(request) {
    check(exact(request, ['requestId', 'endpoint', 'model', 'input']), 'ANALYSIS_REQUEST_INVALID', 422);
    this.file(request.requestId);
    shared(() => validateInput(request.input));
    const endpoint = localModelEndpoint(request.endpoint);
    check(typeof request.model === 'string' && request.model.length <= 200 && request.model.trim(), 'ANALYSIS_MODEL_REQUIRED', 422);
    const fingerprint = sha256(JSON.stringify({ endpoint, model: request.model, input: request.input }));
    const existing = this.get(request.requestId);
    if (existing) { check(existing.fingerprint === fingerprint, 'ANALYSIS_REPLAY_MISMATCH', 409); return existing; }
    check(!this.active, 'ANALYSIS_BUSY', 409);
    const draft = this.store.current(request.input.source.draftId);
    check(draft?.kind === 'screenplay-draft' && draft.data.projectId === this.store.project().id, 'ANALYSIS_DRAFT_NOT_FOUND', 404);
    const { source } = request.input;
    check(sha256(draft.data.body) === source.bodySha256 && draft.data.title === source.title, 'ANALYSIS_DRAFT_CHANGED', 409);
    check(source.scope === 'full' ? source.excerpt === draft.data.body : draft.data.body.includes(source.excerpt), 'ANALYSIS_EXCERPT_CHANGED', 409);
    this.active = true;
    let job;
    try {
      const available = await this.models({ endpoint });
      check(available.models.some(m => m.name === request.model), 'ANALYSIS_LOCAL_MODEL_REQUIRED', 422);
      const details = await this.call(endpoint, '/api/show', { model: request.model });
      check(!remoteMetadata(details) && details.model_info && typeof details.model_info === 'object', 'ANALYSIS_LOCAL_MODEL_REQUIRED', 422);
      const messages = analysisMessages(request.input);
      // UTF-8 byte count is a conservative budget; reject rather than silently
      // request a smaller context that could truncate the reviewed passage.
      const context = Math.ceil((Buffer.byteLength(JSON.stringify(messages)) + 4096) / 1024) * 1024;
      const modelContext = details.model_info[`${details.model_info['general.architecture']}.context_length`];
      check(Number.isSafeInteger(modelContext) && context <= Math.min(modelContext, 65536), 'ANALYSIS_CONTEXT_TOO_SMALL', 422);
      job = this.write({ id: request.requestId.toLowerCase(), createdAt: new Date().toISOString(), input: request.input, endpoint, model: request.model, fingerprint, status: 'running', report: null, error: null });
      const invoke = () => this.call(endpoint, '/api/chat', { model: request.model, messages, format: outputSchema(request.input.kind), stream: false, think: false,
        options: { temperature: 0.2, num_predict: 4096, num_ctx: context } }, this.timeoutMs);
      const result = this.resourceJournal ? await this.resourceJournal.measure({ id: job.id, provider: 'OLLAMA', model: request.model, taskId: job.id, local: true, requestHash: fingerprint }, invoke) : await invoke();
      const absentOrEmpty = value => value === undefined || Array.isArray(value) && value.length === 0;
      check(result.model === request.model && !remoteMetadata(result) && result.done === true && result.done_reason === 'stop'
        && result.message?.role === 'assistant' && absentOrEmpty(result.message.tool_calls) && absentOrEmpty(result.message.images)
        && result.message.function_call === undefined && typeof result.message.content === 'string', 'ANALYSIS_INCOMPLETE', 422);
      let output; try { output = JSON.parse(result.message.content); } catch { throw new LocalError('ANALYSIS_OUTPUT_INVALID', 422); }
      shared(() => validateOutput(output, request.input));
      const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
      const report = { schemaVersion: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), input: request.input, provider: 'ollama', model: request.model, platformCredits: 0, output,
        usage: { inputTokens: count(result.prompt_eval_count), outputTokens: count(result.eval_count) } };
      shared(() => validateReport(report));
      return this.write({ ...job, status: 'completed', report });
    } catch (e) {
      if (job) return this.write({ ...job, status: 'failed', error: e instanceof LocalError ? e.code : 'ANALYSIS_FAILED' });
      throw e;
    } finally { this.active = false; }
  }
}
