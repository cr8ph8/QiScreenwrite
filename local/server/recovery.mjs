// Mutable recovery copies have their own table. Nothing here calls save(),
// appends a revision, changes request receipts or rewrites authored history.
import { ID, SHA, check, canonicalJson, sha256, MAX_CANONICAL_BYTES, MAX_WORLD_CANONICAL_BYTES } from './storage.mjs';
import { validateScreenplayDraft } from './contracts.mjs';
import { DEVELOPMENT_KIND, validateDevelopment } from './development.mjs';
import { isoTimestamp } from './backup.mjs';

export const RECOVERY_SCHEMA = 'caniscreenwrite-local-writer-recovery/v1';
export const DEVELOPMENT_RECOVERY_SCHEMA = 'caniscreenwrite-story-development-recovery/v1';
// HTTP uses this ceiling before decoding. Only development v2/v3 envelopes may
// use the larger budget; screenplay and development v1 copies retain 2 MiB.
export const MAX_RECOVERY_BYTES = MAX_WORLD_CANONICAL_BYTES;
const LEGACY_RECOVERY_BYTES = MAX_CANONICAL_BYTES;
export const MAX_RECOVERY_COPIES = 100;
export const MAX_RECOVERY_TOTAL_BYTES = 32 * 1024 * 1024;

export function validateDraftId(id) {
  check(typeof id === 'string' && ID.test(id) && id.startsWith('screenplay-draft:') && id.length > 'screenplay-draft:'.length, 'RECOVERY_DRAFT_ID_INVALID', 422);
}

export function validateRecovery(copy, draftId, store) {
  validateDraftId(draftId);
  check(copy && typeof copy === 'object' && !Array.isArray(copy) && Object.keys(copy).sort().join(',') === 'baseSha256,baseVersion,data,draftId,savedAt,schema', 'RECOVERY_FIELDS_INVALID', 422);
  check(copy.schema === RECOVERY_SCHEMA && copy.draftId === draftId, 'RECOVERY_IDENTITY_INVALID', 422);
  check(isoTimestamp(copy.savedAt), 'RECOVERY_TIMESTAMP_INVALID', 422);
  check((copy.baseVersion === null && copy.baseSha256 === null) || (Number.isSafeInteger(copy.baseVersion) && copy.baseVersion >= 1 && copy.baseVersion <= 2147483647 && typeof copy.baseSha256 === 'string' && SHA.test(copy.baseSha256)), 'RECOVERY_BASE_INVALID', 422);
  const project = store.project();
  check(project, 'PROJECT_NOT_INITIALIZED', 409);
  validateScreenplayDraft(copy.data, project);
  if (copy.baseVersion !== null) {
    const base = store.db.prepare('SELECT sha256 FROM records WHERE id=? AND kind=? AND version=?').get(draftId, 'screenplay-draft', copy.baseVersion);
    check(base && base.sha256 === copy.baseSha256, 'RECOVERY_BASE_UNKNOWN', 409);
  }
  return copy;
}

const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
const developmentDraftId = id => {
  check(typeof id === 'string' && /^screenplay-draft:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id), 'RECOVERY_DRAFT_ID_INVALID', 422);
};
const developmentVersion = value => Number.isSafeInteger(value) && value >= 1 && value < 2147483647;

export function validateDevelopmentRecovery(copy, draftId, store) {
  developmentDraftId(draftId);
  check(shape(copy, 'baseSha256,baseVersion,data,draftId,pendingSave,projectId,savedAt,schema'), 'RECOVERY_FIELDS_INVALID', 422);
  check(copy.schema === DEVELOPMENT_RECOVERY_SCHEMA && copy.draftId === draftId, 'RECOVERY_IDENTITY_INVALID', 422);
  check(isoTimestamp(copy.savedAt), 'RECOVERY_TIMESTAMP_INVALID', 422);
  check((copy.baseVersion === null && copy.baseSha256 === null) || (developmentVersion(copy.baseVersion) && typeof copy.baseSha256 === 'string' && SHA.test(copy.baseSha256)), 'RECOVERY_BASE_INVALID', 422);
  const project = store.project();
  check(project, 'PROJECT_NOT_INITIALIZED', 409);
  check(copy.projectId === project.id, 'RECOVERY_PROJECT_MISMATCH', 422);
  const id = `${DEVELOPMENT_KIND}:${draftId.slice('screenplay-draft:'.length)}`;
  validateDevelopment(copy.data, project, { id, store }); // Requires an existing saved screenplay.
  const revision = version => store.db.prepare('SELECT sha256 FROM records WHERE id=? AND kind=? AND version=?').get(id, DEVELOPMENT_KIND, version);
  if (copy.baseVersion !== null) {
    check(revision(copy.baseVersion)?.sha256 === copy.baseSha256, 'RECOVERY_BASE_UNKNOWN', 409);
  }
  const pending = copy.pendingSave;
  if (pending !== null) {
    check(shape(pending, 'data,expectedVersion,id,kind,requestId') && pending.id === id && pending.kind === DEVELOPMENT_KIND && typeof pending.requestId === 'string' && ID.test(pending.requestId), 'RECOVERY_PENDING_SAVE_INVALID', 422);
    check(pending.expectedVersion === null || developmentVersion(pending.expectedVersion), 'RECOVERY_PENDING_SAVE_INVALID', 422);
    validateDevelopment(pending.data, project, { id, store });
    if (pending.expectedVersion !== null) check(revision(pending.expectedVersion), 'RECOVERY_BASE_UNKNOWN', 409);
    // Keep the exact uncertain request independently of newer working edits.
    // A known request ID must still replay the body originally submitted.
    const receipt = store.db.prepare('SELECT request_sha256 FROM requests WHERE id=?').get(pending.requestId);
    check(!receipt || receipt.request_sha256 === sha256(canonicalJson(pending)), 'RECOVERY_PENDING_SAVE_CONFLICT', 409);
  }
  return copy;
}

export class RecoveryStore {
  constructor(store, development = false) {
    this.store = store;
    this.db = store.db;
    // Table names are fixed server literals, never derived from route input.
    this.table = development ? 'development_recovery' : 'recovery';
    this.validateId = development ? developmentDraftId : validateDraftId;
    this.validateCopy = development ? validateDevelopmentRecovery : validateRecovery;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (draft_id TEXT PRIMARY KEY, data TEXT NOT NULL, sha256 TEXT NOT NULL, received_at TEXT NOT NULL)`);
  }
  byteLimit(copy) {
    return this.table === 'development_recovery' && ([2, 3].includes(copy?.data?.schemaVersion) || [2, 3].includes(copy?.pendingSave?.data?.schemaVersion))
      ? MAX_RECOVERY_BYTES : LEGACY_RECOVERY_BYTES;
  }
  decode(row) {
    if (!row) return null;
    check(Buffer.byteLength(row.data) <= MAX_RECOVERY_BYTES && sha256(row.data) === row.sha256, 'RECOVERY_CORRUPT', 409);
    const copy = JSON.parse(row.data);
    check(Buffer.byteLength(row.data) <= this.byteLimit(copy), 'RECOVERY_CORRUPT', 409);
    return this.validateCopy(copy, row.draft_id, this.store);
  }
  get(draftId) {
    this.validateId(draftId);
    return this.decode(this.db.prepare(`SELECT * FROM ${this.table} WHERE draft_id=?`).get(draftId));
  }
  list() {
    const rows = this.db.prepare(`SELECT * FROM ${this.table} ORDER BY received_at DESC, draft_id LIMIT ?`).all(MAX_RECOVERY_COPIES + 1);
    check(rows.length <= MAX_RECOVERY_COPIES, 'RECOVERY_LIMIT_REACHED', 409);
    return rows.map(row => this.decode(row));
  }
  put(draftId, input) {
    let text;
    try { text = canonicalJson(input); }
    catch (error) {
      // Report the same payload-too-large status whether the HTTP ceiling or
      // the narrower legacy/structural budget rejected this recovery copy.
      if (error.code === 'JSON_TOO_LARGE') check(false, 'RECOVERY_TOO_LARGE', 413);
      throw error;
    }
    const copy = JSON.parse(text);
    check(Buffer.byteLength(text) <= this.byteLimit(copy), 'RECOVERY_TOO_LARGE', 413);
    this.validateCopy(copy, draftId, this.store);
    check(Date.parse(copy.savedAt) <= Date.now() + 300000, 'RECOVERY_TIMESTAMP_INVALID', 422);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.get(draftId);
      // Delayed autosave requests must not replace a newer recovery copy.
      check(!current || current.savedAt < copy.savedAt || canonicalJson(current) === text, 'RECOVERY_CONFLICT', 409);
      const usage = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM ${this.table} WHERE draft_id != ?`).get(draftId);
      check(usage.count < MAX_RECOVERY_COPIES && usage.bytes + Buffer.byteLength(text) <= MAX_RECOVERY_TOTAL_BYTES, 'RECOVERY_LIMIT_REACHED', 409);
      this.db.prepare(`INSERT INTO ${this.table} VALUES(?,?,?,?) ON CONFLICT(draft_id) DO UPDATE SET data=excluded.data, sha256=excluded.sha256, received_at=excluded.received_at`).run(draftId, text, sha256(text), new Date().toISOString());
      this.db.exec('COMMIT');
      return copy;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  delete(draftId, savedAt = null) {
    this.validateId(draftId);
    check(savedAt === null || isoTimestamp(savedAt), 'RECOVERY_TIMESTAMP_INVALID', 422);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.get(draftId);
      check(!current || savedAt === null || current.savedAt === savedAt, 'RECOVERY_CONFLICT', 409);
      const result = this.db.prepare(`DELETE FROM ${this.table} WHERE draft_id=?`).run(draftId);
      this.db.exec('COMMIT');
      return { deleted: result.changes > 0 };
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
}

export class DevelopmentRecoveryStore extends RecoveryStore {
  constructor(store) { super(store, true); }
}
