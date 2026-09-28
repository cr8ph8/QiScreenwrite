import { validateParticipation, defaultParticipation, calculateParticipationPool } from './qimovi/project-participation.mjs';
export { validateParticipation, defaultParticipation, calculateParticipationPool };
// One ledger per private writer workspace. Avoid prefix + project-id overflow;
// the project identity remains inside the shared QiMovi data, not inferred here.
export const RIGHTS_ID = 'project-participation:workspace';
export const MAX_EVIDENCE_BYTES = 1024 * 1024;
export const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code, status: 422 }); };
export const shape = (value, keys) => need(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'RIGHTS_FIELDS_INVALID');
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && value.isWellFormed();
export const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const integer = (value, max) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= max;
export const recordRef = record => ({ id: record.id, version: record.version, sha256: record.sha256 });
export function validateRef(ref) {
  shape(ref, ['id', 'version', 'sha256']);
  need(id(ref.id) && integer(ref.version, 2147483647) && ref.version > 0 && hash(ref.sha256), 'RIGHTS_REFERENCE_INVALID');
}
export const projectSubject = () => ({ kind: 'PROJECT', label: '', assetHash: null, recordRef: null });
export function validateWriterParticipation(value, project) {
  validateParticipation(value, project);
  need(value.sourceHash === null, 'RIGHTS_SOURCE_INVALID');
  // Production budget links belong to QiMovi. They require an explicit mapping
  // before a future importer can carry them into this writer workspace.
  need(value.contributions.every(row => row.budgetLineIds.length === 0), 'RIGHTS_BUDGET_MAPPING_REQUIRED');
  return value;
}
export function evidenceHashes(value) {
  return [...new Set([...value.contributions, ...value.rights, ...value.pools].flatMap(row => [
    ...(row.subject.kind === 'ASSET' ? [row.subject.assetHash] : []), ...(row.evidenceHashes ?? []),
    ...(row.allocations ?? []).flatMap(item => item.evidenceHashes),
  ]))].sort();
}
export function validateEvidence(value, project) {
  shape(value, ['schemaVersion', 'projectId', 'name', 'mediaType', 'byteLength', 'sha256', 'base64']);
  need(value.schemaVersion === 1 && value.projectId === project.id, 'RIGHTS_EVIDENCE_PROJECT_INVALID');
  need(text(value.name, 240) && value.name.trim() && !/[\\/\r\n]/.test(value.name), 'RIGHTS_EVIDENCE_NAME_INVALID');
  need(['application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'application/octet-stream'].includes(value.mediaType), 'RIGHTS_EVIDENCE_TYPE_INVALID');
  need(integer(value.byteLength, MAX_EVIDENCE_BYTES) && value.byteLength > 0 && hash(value.sha256), 'RIGHTS_EVIDENCE_SIZE_INVALID');
  need(typeof value.base64 === 'string' && value.base64.length <= Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64), 'RIGHTS_EVIDENCE_ENCODING_INVALID');
  const decoded = atob(value.base64);
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  need(bytes.length === value.byteLength && btoa(decoded) === value.base64, 'RIGHTS_EVIDENCE_SIZE_INVALID');
  return bytes;
}
export function validateReview(value, project) {
  shape(value, ['schemaVersion', 'projectId', 'status', 'participationRef', 'note', 'actor']);
  need(value.schemaVersion === 1 && value.projectId === project.id && value.status === 'LOCAL_REVIEW' && value.actor === 'local-owner', 'RIGHTS_REVIEW_AUTHORITY_INVALID');
  validateRef(value.participationRef); need(value.participationRef.id === RIGHTS_ID && text(value.note, 4000), 'RIGHTS_REVIEW_INVALID');
  return value;
}
export const emptyPublicFields = () => ({ name: '', description: '', imageUri: '', licenceUri: '', licenceSummary: '' });
export function validatePublicUri(value) {
  if (value === '') return;
  need(text(value, 2048) && !/[\s\\<>]/.test(value), 'TOKEN_PUBLIC_URI_INVALID');
  let url; try { url = new URL(value); } catch { need(false, 'TOKEN_PUBLIC_URI_INVALID'); }
  need(!url.username && !url.password && !url.search && !url.hash && !/[?#]/.test(value), 'TOKEN_PUBLIC_URI_INVALID');
  if (url.protocol === 'ipfs:') need(!url.port && /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(url.hostname), 'TOKEN_PUBLIC_URI_INVALID');
  else need(url.protocol === 'https:' && (!url.port || url.port === '443') && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(url.hostname) && !/(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion)$/i.test(url.hostname), 'TOKEN_PUBLIC_URI_INVALID');
  let decoded; try { decoded = decodeURIComponent(url.pathname); } catch { need(false, 'TOKEN_PUBLIC_URI_INVALID'); }
  need(!/[\x00-\x1f\x7f<>\\]/.test(decoded), 'TOKEN_PUBLIC_URI_INVALID');
}
export function validateTokenDraft(value, project) {
  shape(value, ['schemaVersion', 'projectId', 'status', 'subjectRef', 'participationRef', 'standard', 'editionCap', 'royaltyRequestBps', 'publicFields', 'nonce']);
  need(value.schemaVersion === 1 && value.projectId === project.id && value.status === 'DRAFT', 'TOKEN_AUTHORITY_INVALID');
  validateRef(value.subjectRef); validateRef(value.participationRef);
  need(value.participationRef.id === RIGHTS_ID && hash(value.nonce), 'TOKEN_BASIS_INVALID');
  need(['UNDECIDED', 'ERC721', 'ERC1155'].includes(value.standard), 'TOKEN_STANDARD_INVALID');
  need(value.editionCap === null || integer(value.editionCap, 1000000) && value.editionCap > 0, 'TOKEN_EDITION_INVALID');
  need(value.royaltyRequestBps === null || integer(value.royaltyRequestBps, 10000), 'TOKEN_ROYALTY_INVALID');
  shape(value.publicFields, ['name', 'description', 'imageUri', 'licenceUri', 'licenceSummary']);
  for (const [key, limit] of [['name', 240], ['description', 8000], ['licenceSummary', 4000]]) need(text(value.publicFields[key], limit) && !/[<>]/.test(value.publicFields[key]), 'TOKEN_PUBLIC_TEXT_INVALID');
  validatePublicUri(value.publicFields.imageUri); validatePublicUri(value.publicFields.licenceUri);
  return value;
}
/** Explicit public projection. No record IDs, source hashes, parties, private
 * terms, evidence, filenames, nonce, or screenplay text are copied into it. */
export function publicTokenMetadata(value, commitment) {
  const p = value.publicFields;
  return { name: p.name, description: p.description, ...(p.imageUri ? { image: p.imageUri } : {}), properties: { qicaniscreenwrite: {
    format: 'caniscreenwrite-token-metadata-draft/v1', status: 'LOCAL_DRAFT', standard: value.standard,
    editionCap: value.editionCap, royaltyRequestBps: value.royaltyRequestBps,
    licenceUri: p.licenceUri, licenceSummary: p.licenceSummary, commitment,
  } } };
}
