// Retained original documents and reviewed derivatives. These records establish
// local byte continuity, never production admission or authorship authority.
import { check, ID, SHA, hashCanonical, sha256 } from './storage.mjs';
export const MAX_SOURCE_BYTES = 1024 * 1024;
const fields = (v, keys) => check(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(','), 'SOURCE_FIELDS_INVALID', 422);
const text = (v, n) => typeof v === 'string' && v.isWellFormed() && v.trim() && v.length <= n && !/[\x00-\x1f\x7f]/.test(v);
export const ref = row => ({ id: row.id, version: row.version, sha256: row.sha256 });
export function validateSourceRef(value, kind) {
  fields(value, ['id','version','sha256']);
  check(typeof value.id === 'string' && ID.test(value.id) && value.id.startsWith(kind + ':') && Number.isSafeInteger(value.version) && value.version > 0 && value.version <= 2147483647 && typeof value.sha256 === 'string' && SHA.test(value.sha256), 'SOURCE_REFERENCE_INVALID', 422);
}
export const sourceIdentity = origin => hashCanonical({ domain: 'caniscreenwrite-library-origin/v1', projectId: origin.projectId, recordRef: origin.recordRef });
export function importIds(origin) {
  const hash = sourceIdentity(origin);
  const uuid = `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
  return { document: `source-document:${hash}`, draft: `screenplay-draft:${uuid}`, receipt: `source-import:${uuid}` };
}
export function decodeSource(bytes) {
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { check(false, 'SOURCE_UTF8_REQUIRED', 422); }
  check(!value.includes('\0'), 'SOURCE_UTF8_REQUIRED', 422);
  return value;
}
export function validateSourceDocument(data, project, context = {}) {
  fields(data, ['schemaVersion','projectId','status','origin','filename','mimeType','byteLength','contentSha256','base64']);
  check(data.schemaVersion === 1 && data.projectId === project.id && data.status === 'RETAINED_REFERENCE', 'SOURCE_AUTHORITY_INVALID', 422);
  fields(data.origin, ['system','projectId','projectTitle','projectSourceHash','recordRef']);
  check(data.origin.system === 'qimovi' && typeof data.origin.projectId === 'string' && ID.test(data.origin.projectId) && text(data.origin.projectTitle, 240) && (data.origin.projectSourceHash === null || typeof data.origin.projectSourceHash === 'string' && SHA.test(data.origin.projectSourceHash)), 'SOURCE_ORIGIN_INVALID', 422);
  validateSourceRef(data.origin.recordRef, 'project-asset');
  check(typeof data.contentSha256 === 'string' && SHA.test(data.contentSha256) && data.origin.recordRef.id === `project-asset:${data.contentSha256}`, 'SOURCE_HASH_INVALID', 422);
  check(text(data.filename, 255) && !/[\\/]/.test(data.filename) && /\.(fdx|fountain|txt)$/i.test(data.filename) && ['text/plain','application/xml','application/octet-stream'].includes(data.mimeType), 'SOURCE_FORMAT_INVALID', 422);
  check(Number.isSafeInteger(data.byteLength) && data.byteLength > 0 && data.byteLength <= MAX_SOURCE_BYTES && typeof data.base64 === 'string' && data.base64.length <= Math.ceil(MAX_SOURCE_BYTES / 3) * 4, 'SOURCE_SIZE_INVALID', 413);
  const bytes = Buffer.from(data.base64, 'base64');
  check(bytes.length === data.byteLength && bytes.toString('base64') === data.base64 && sha256(bytes) === data.contentSha256, 'SOURCE_BYTES_INVALID', 422);
  decodeSource(bytes);
  check(!context.id || context.id === importIds(data.origin).document, 'SOURCE_IDENTITY_INVALID', 422);
  check(!context.previous, 'SOURCE_IMMUTABLE', 409);
  return bytes;
}
function saved(store, reference, kind, project) {
  validateSourceRef(reference, kind);
  const row = store.history(reference.id).find(row => row.version === reference.version);
  check(row && row.kind === kind && row.sha256 === reference.sha256 && hashCanonical(row.data) === row.sha256 && row.data.projectId === project.id, 'SOURCE_REVISION_MISSING', 422);
  return row;
}
export function validateSourceImport(kind, data, project, context = {}) {
  if (kind === 'source-document') { validateSourceDocument(data, project, context); return true; }
  if (kind !== 'source-import') return false;
  fields(data, ['schemaVersion','projectId','status','documentRef','draftRef','conversion','bodySha256']);
  check(data.schemaVersion === 1 && data.projectId === project.id && data.status === 'REVIEWED_WORKING_COPY', 'SOURCE_AUTHORITY_INVALID', 422);
  validateSourceRef(data.documentRef, 'source-document'); validateSourceRef(data.draftRef, 'screenplay-draft');
  check(['FDX_REVIEWED','FOUNTAIN_UTF8'].includes(data.conversion) && typeof data.bodySha256 === 'string' && SHA.test(data.bodySha256), 'SOURCE_CONVERSION_INVALID', 422);
  check(!context.previous, 'SOURCE_IMMUTABLE', 409);
  if (context.store) {
    const original = saved(context.store, data.documentRef, 'source-document', project), draft = saved(context.store, data.draftRef, 'screenplay-draft', project);
    const ids = importIds(original.data.origin);
    check(context.id === ids.receipt && data.draftRef.id === ids.draft && data.draftRef.version === 1 && data.documentRef.version === 1 && sha256(draft.data.body) === data.bodySha256, 'SOURCE_DERIVATION_INVALID', 422);
    const bytes = validateSourceDocument(original.data, project, { id: original.id });
    if (data.conversion === 'FOUNTAIN_UTF8') check(!/\.fdx$/i.test(original.data.filename) && draft.data.body === decodeSource(bytes), 'SOURCE_CONVERSION_INVALID', 422);
    else check(/\.fdx$/i.test(original.data.filename), 'SOURCE_CONVERSION_INVALID', 422);
  }
  return true;
}
