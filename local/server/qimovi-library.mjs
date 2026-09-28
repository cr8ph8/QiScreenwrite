import crypto from 'node:crypto';
import { check, SHA, canonicalJson, hashCanonical, sha256 } from './storage.mjs';
import { validateScreenplayDraft } from './contracts.mjs';
import { MAX_SOURCE_BYTES, ref, importIds, decodeSource } from './source-import.mjs';

const exactFields = (value, keys) => check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(','), 'QIMOVI_LIBRARY_FIELDS_INVALID', 422);
const same = (a,b) => a.id === b.id && a.version === b.version && a.sha256 === b.sha256;
const string = (v,n) => typeof v === 'string' && v.isWellFormed() && v.trim() && v.length <= n && !/[\x00-\x1f\x7f]/.test(v);
const TTL = 15 * 60 * 1000;

/** One service session's bounded review cache. Saved imports have durable,
 * deterministic identity and one atomic original/draft/receipt transaction. */
export class QiMoviLibrary {
  constructor(bridge, store, { now = Date.now } = {}) { this.bridge = bridge; this.store = store; this.now = now; this.previews = new Map(); }
  binding() { return hashCanonical(this.bridge.config()); }
  async snapshot() {
    await this.bridge.refreshInstalled();
    const binding = this.binding();
    await this.bridge.bootstrap();
    check(binding === this.binding(), 'QIMOVI_LIBRARY_STALE', 409);
    return { binding, project: { ...this.bridge.remote.project }, records: this.bridge.remote.records };
  }
  asset(row, project) {
    const d = row.data, a = d?.asset;
    check(row.kind === 'project-asset' && Number.isSafeInteger(row.version) && row.version > 0 && typeof row.sha256 === 'string' && SHA.test(row.sha256) && hashCanonical(d) === row.sha256 && a && typeof a.sha256 === 'string' && SHA.test(a.sha256) && row.id === `project-asset:${a.sha256}`, 'QIMOVI_LIBRARY_RECORD_INVALID', 502);
    check(d.scope === 'PROJECT_REFERENCE' && d.review === 'PENDING' && d.sourceHash === project.sourceHash && (d.schemaVersion === 2 && d.projectId === project.id && d.sourceHash === null || d.schemaVersion === 1 && typeof project.sourceHash === 'string' && SHA.test(project.sourceHash)), 'QIMOVI_LIBRARY_SCOPE_INVALID', 502);
    check(string(d.originalFilename,255) && !/[\\/]/.test(d.originalFilename) && string(d.title,240) && string(a.mimeType,120) && Number.isSafeInteger(a.byteLength) && a.byteLength > 0, 'QIMOVI_LIBRARY_RECORD_INVALID', 502);
    const ext = /\.(fdx|fountain|txt)$/i.exec(d.originalFilename)?.[1].toLowerCase();
    const format = ext === 'fdx' && ['application/xml','application/octet-stream','text/plain'].includes(a.mimeType) ? 'FDX'
      : ['fountain','txt'].includes(ext) && ['text/plain','application/octet-stream'].includes(a.mimeType) ? 'FOUNTAIN' : 'REFERENCE';
    const origin = { system: 'qimovi', projectId: project.id, projectTitle: project.title, projectSourceHash: project.sourceHash, recordRef: ref(row) };
    const receipt = this.store.current(importIds(origin).receipt);
    return { id: row.id, version: row.version, sha256: row.sha256, title: d.title, filename: d.originalFilename, mimeType: a.mimeType, byteLength: a.byteLength, contentSha256: a.sha256, format,
      reason: format === 'REFERENCE' ? 'Reference only. Use a Fountain, text or Final Draft (.fdx) original for an editable draft.' : a.byteLength > MAX_SOURCE_BYTES ? 'This original exceeds the 1 MiB retained-document limit.' : null,
      importedDraftId: receipt?.data.draftRef.id ?? null };
  }
  async list() {
    const { project, records } = await this.snapshot();
    return { project: { id: project.id, title: project.title }, assets: records.filter(row => row.kind === 'project-asset' && ['TEXT','DOCUMENT'].includes(row.data?.family)).map(row => this.asset(row, project)).sort((a,b) => a.filename.localeCompare(b.filename)) };
  }
  prune() { for (const [token, value] of this.previews) if (value.expires <= this.now()) this.previews.delete(token); }
  async preview(input) {
    exactFields(input, ['recordId']); check(typeof input.recordId === 'string' && /^project-asset:[a-f0-9]{64}$/.test(input.recordId), 'QIMOVI_LIBRARY_RECORD_INVALID', 422);
    const snapshot = await this.snapshot(), { project, binding, records } = snapshot;
    const row = records.find(row => row.id === input.recordId); check(row, 'QIMOVI_LIBRARY_NOT_FOUND', 404);
    const asset = this.asset(row, project); check(!asset.reason, 'QIMOVI_LIBRARY_UNSUPPORTED', 422, asset.reason);
    const response = await this.bridge.request(`/api/project-library/assets/${encodeURIComponent(row.id)}`, { responseType: 'bytes', maxBytes: MAX_SOURCE_BYTES });
    check(binding === this.binding() && response.bytes.length === asset.byteLength && sha256(response.bytes) === asset.contentSha256 && response.response.headers.get('x-asset-sha256') === asset.contentSha256 && response.response.headers.get('content-type') === asset.mimeType, 'QIMOVI_LIBRARY_BYTES_MISMATCH', 502);
    const text = decodeSource(response.bytes);
    if (asset.format === 'FDX') check(!/<!\s*(DOCTYPE|ENTITY)\b/i.test(text) && /<FinalDraft[\s>]/.test(text), 'SOURCE_FDX_INVALID', 422);
    this.prune(); while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value);
    const token = crypto.randomBytes(32).toString('hex'), expires = this.now() + TTL;
    this.previews.set(token, { ...snapshot, records: undefined, asset, bytes: Buffer.from(response.bytes), expires });
    return { token, project: { id: project.id, title: project.title }, asset, text, expiresAt: new Date(expires).toISOString() };
  }
  async import(input) {
    exactFields(input, ['token','title','body','conversion']);
    check(typeof input.token === 'string' && SHA.test(input.token), 'QIMOVI_LIBRARY_PREVIEW_REQUIRED', 422);
    this.prune(); const preview = this.previews.get(input.token); check(preview, 'QIMOVI_LIBRARY_PREVIEW_EXPIRED', 409);
    check(preview.binding === this.binding(), 'QIMOVI_LIBRARY_STALE', 409);
    const snapshot = await this.snapshot();
    check(snapshot.binding === preview.binding && snapshot.project.id === preview.project.id && snapshot.project.sourceHash === preview.project.sourceHash && this.now() < preview.expires, 'QIMOVI_LIBRARY_STALE', 409);
    const row = snapshot.records.find(row => row.id === preview.asset.id);
    check(row && same(this.asset(row, snapshot.project), preview.asset), 'QIMOVI_LIBRARY_STALE', 409);
    const data = { schemaVersion: 2, projectId: this.store.project().id, sourceHash: null, title: input.title, format: 'FOUNTAIN', body: input.body, status: 'DRAFT' };
    validateScreenplayDraft(data, this.store.project()); check(input.body.trim(), 'SOURCE_EMPTY_DRAFT', 422);
    check(input.conversion === (preview.asset.format === 'FDX' ? 'FDX_REVIEWED' : 'FOUNTAIN_UTF8'), 'SOURCE_CONVERSION_INVALID', 422);
    if (input.conversion === 'FOUNTAIN_UTF8') check(input.body === decodeSource(preview.bytes), 'SOURCE_CONVERSION_INVALID', 422);
    const origin = { system: 'qimovi', projectId: preview.project.id, projectTitle: preview.project.title, projectSourceHash: preview.project.sourceHash, recordRef: ref(preview.asset) }, ids = importIds(origin);
    return this.store.atomic(() => {
      const existing = this.store.current(ids.receipt);
      if (existing) {
        const draft = this.store.history(ids.draft).find(row => row.version === existing.data.draftRef.version), document = this.store.current(ids.document);
        check(draft && document && canonicalJson(draft.data) === canonicalJson(data) && existing.data.conversion === input.conversion, 'QIMOVI_LIBRARY_ALREADY_IMPORTED', 409);
        return { replayed: true, draft, document, receipt: existing };
      }
      const document = this.store.save(ids.document, { kind: 'source-document', expectedVersion: null, requestId: ids.document,
        data: { schemaVersion: 1, projectId: data.projectId, status: 'RETAINED_REFERENCE', origin, filename: preview.asset.filename, mimeType: preview.asset.mimeType, byteLength: preview.bytes.length, contentSha256: preview.asset.contentSha256, base64: preview.bytes.toString('base64') } });
      const draft = this.store.save(ids.draft, { kind: 'screenplay-draft', expectedVersion: null, requestId: `library:${ids.draft}`, data });
      const receipt = this.store.save(ids.receipt, { kind: 'source-import', expectedVersion: null, requestId: ids.receipt, data: { schemaVersion: 1, projectId: data.projectId, status: 'REVIEWED_WORKING_COPY', documentRef: ref(document), draftRef: ref(draft), conversion: input.conversion, bodySha256: sha256(data.body) } });
      return { replayed: false, document, draft, receipt };
    });
  }
}
