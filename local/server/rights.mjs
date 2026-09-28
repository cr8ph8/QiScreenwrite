import crypto from 'node:crypto';
import { check, hashCanonical, canonicalJson } from './storage.mjs';
import { RIGHTS_ID, shape, recordRef, validateRef, validateWriterParticipation, validateEvidence, validateReview, validateTokenDraft, publicTokenMetadata, evidenceHashes } from '../contracts/writer-rights.mjs';

const SUBJECT_KINDS = ['screenplay-draft', 'story-development', 'shared-world', 'rights-evidence', 'source-document'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function exact(store, ref, current = false, kinds = SUBJECT_KINDS) {
  validateRef(ref);
  // Check identity before lookup to prevent recursive self-referential records.
  check(kinds.some(kind => ref.id.startsWith(`${kind}:`)), 'RIGHTS_SUBJECT_KIND_INVALID', 422);
  const record = current ? store.current(ref.id) : store.history(ref.id).find(row => row.version === ref.version);
  check(record && kinds.includes(record.kind) && record.version === ref.version && record.sha256 === ref.sha256 && hashCanonical(record.data) === record.sha256 && record.data.projectId === store.project().id, 'RIGHTS_SOURCE_CHANGED', 409);
  return record;
}
function ledgerReferences(data, project, store, current) {
  for (const row of [...data.contributions, ...data.rights, ...data.pools]) if (row.subject.kind === 'RECORD') {
    const record = exact(store, row.subject.recordRef, current);
    check(record.data.projectId === project.id, 'RIGHTS_FOREIGN_SOURCE', 409);
  }
  for (const sha of evidenceHashes(data)) {
    const record = store.current(`rights-evidence:${sha}`);
    check(record?.kind === 'rights-evidence' && record.data.projectId === project.id, 'RIGHTS_EVIDENCE_MISSING', 409);
    const bytes = validateEvidence(record.data, project);
    check(digest(bytes) === sha, 'RIGHTS_EVIDENCE_HASH_MISMATCH', 422);
  }
}
export function validateRightsRecord(kind, data, project, context = {}) {
  if (kind === 'rights-evidence') {
    const bytes = validateEvidence(data, project);
    check(context.id === `rights-evidence:${data.sha256}` && digest(bytes) === data.sha256, 'RIGHTS_EVIDENCE_HASH_MISMATCH', 422);
    check(!context.previous, 'RIGHTS_EVIDENCE_IMMUTABLE', 409);
  } else if (kind === 'project-participation') {
    check(context.id === RIGHTS_ID, 'RIGHTS_IDENTITY_INVALID', 422);
    validateWriterParticipation(data, project);
    if (context.store) ledgerReferences(data, project, context.store, context.writing === true);
  } else if (kind === 'rights-review') {
    validateReview(data, project);
    check(!context.previous, 'RIGHTS_REVIEW_IMMUTABLE', 409);
    if (context.store) {
      const ledger = exact(context.store, data.participationRef, context.writing === true, ['project-participation']);
      ledgerReferences(ledger.data, project, context.store, context.writing === true);
    }
  } else if (kind === 'token-preparation') {
    validateTokenDraft(data, project);
    check(!context.previous, 'TOKEN_PREPARATION_IMMUTABLE', 409);
    if (context.store) {
      const ledger = exact(context.store, data.participationRef, context.writing === true, ['project-participation']);
      ledgerReferences(ledger.data, project, context.store, context.writing === true);
      exact(context.store, data.subjectRef, context.writing === true);
    }
  } else return false;
  return true;
}
export function retainEvidence(store, input) {
  shape(input, ['name', 'mediaType', 'base64']);
  check(typeof input.base64 === 'string' && input.base64.length <= 1398104, 'RIGHTS_EVIDENCE_SIZE_INVALID', 413);
  const bytes = Buffer.from(input.base64, 'base64');
  const sha256 = digest(bytes), id = `rights-evidence:${sha256}`;
  const data = { schemaVersion: 1, projectId: store.project().id, ...input, byteLength: bytes.length, sha256 };
  validateEvidence(data, store.project());
  const existing = store.current(id);
  if (existing) {
    check(hashCanonical(existing.data) === existing.sha256 && digest(validateEvidence(existing.data, store.project())) === sha256, 'RIGHTS_EVIDENCE_HASH_MISMATCH', 422);
    return existing;
  }
  return store.save(id, { kind: 'rights-evidence', data, expectedVersion: null, requestId: `evidence:${sha256}` });
}
export function privateWorksheet(store, ref) {
  const record = exact(store, ref, true, ['project-participation']);
  ledgerReferences(record.data, store.project(), store, true);
  return { schema: 'caniscreenwrite-private-split-worksheet/v1', status: 'DRAFT', origin: { projectId: store.project().id, recordRef: recordRef(record) },
    participation: record.data, evidenceHashes: evidenceHashes(record.data),
    notice: 'Private draft: contains party names, claims and proposed terms. Evidence bytes are excluded; the full local preservation package retains them. This worksheet records no authenticated assent, grant, payment or token ownership.' };
}
export function tokenPreview(store, ref) {
  const record = exact(store, ref, true, ['token-preparation']);
  const value = record.data;
  validateTokenDraft(value, store.project());
  exact(store, value.subjectRef, true);
  const ledger = exact(store, value.participationRef, true, ['project-participation']);
  ledgerReferences(ledger.data, store.project(), store, true);
  const commitment = hashCanonical({ domain: 'caniscreenwrite-token-basis/v1', nonce: value.nonce, projectId: value.projectId, subjectRef: value.subjectRef, participationRef: value.participationRef });
  const metadata = publicTokenMetadata(value, commitment);
  return { recordRef: recordRef(record), metadata, metadataSha256: hashCanonical(metadata),
    omitted: ['Private parties and split terms', 'Evidence files and filenames', 'Screenplay and world content', 'Source IDs, hashes and private nonce'],
    status: 'LOCAL_DRAFT', executionEnabled: false };
}
export function exportTokenMetadata(store, input) {
  shape(input, ['recordRef', 'metadataSha256']);
  const preview = tokenPreview(store, input.recordRef);
  check(preview.metadataSha256 === input.metadataSha256, 'TOKEN_PREVIEW_CHANGED', 409);
  check(preview.metadata.name.trim(), 'TOKEN_PUBLIC_NAME_REQUIRED', 422);
  return preview.metadata;
}

// Unsaved rights editing is separate from immutable saved records and exports.
export class RightsRecoveryStore {
  constructor(store) { this.store = store; }
  exists() { return Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='rights_recovery'").get()); }
  get() { const row = this.exists() && this.store.db.prepare('SELECT data FROM rights_recovery WHERE id=1').get(); return row ? JSON.parse(row.data) : null; }
  put(input) {
    const value = JSON.parse(canonicalJson(input));
    shape(value, ['schemaVersion', 'projectId', 'baseVersion', 'baseSha256', 'data', 'pendingSave', 'savedAt']);
    check(value.schemaVersion === 1 && value.projectId === this.store.project().id && typeof value.savedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.savedAt) && Number.isFinite(Date.parse(value.savedAt)) && new Date(value.savedAt).toISOString() === value.savedAt, 'RIGHTS_RECOVERY_INVALID', 422);
    validateWriterParticipation(value.data, this.store.project());
    check((value.baseVersion === null && value.baseSha256 === null) || (Number.isInteger(value.baseVersion) && value.baseVersion > 0 && this.store.history(RIGHTS_ID).some(row => row.version === value.baseVersion && row.sha256 === value.baseSha256)), 'RIGHTS_RECOVERY_BASE_INVALID', 422);
    if (value.pendingSave !== null) {
      shape(value.pendingSave, ['id', 'kind', 'expectedVersion', 'requestId', 'data']);
      check(value.pendingSave.id === RIGHTS_ID && value.pendingSave.kind === 'project-participation' && value.pendingSave.expectedVersion === value.baseVersion && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.pendingSave.requestId), 'RIGHTS_RECOVERY_PENDING_INVALID', 422);
      validateWriterParticipation(value.pendingSave.data, this.store.project());
      check(canonicalJson(value.pendingSave.data) === canonicalJson(value.data), 'RIGHTS_RECOVERY_PENDING_INVALID', 422);
    }
    const before = this.get();
    check(!before || before.savedAt < value.savedAt || canonicalJson(before) === canonicalJson(value), 'RIGHTS_RECOVERY_NEWER', 409);
    this.store.db.exec('CREATE TABLE IF NOT EXISTS rights_recovery (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
    this.store.db.prepare('INSERT INTO rights_recovery VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(canonicalJson(value));
    return value;
  }
  clear(savedAt) {
    const before = this.get();
    check(typeof savedAt === 'string' && (!before || before.savedAt === savedAt), 'RIGHTS_RECOVERY_NEWER', 409);
    if (before) this.store.db.prepare('DELETE FROM rights_recovery WHERE id=1').run();
    return { removed: Boolean(before) };
  }
}
