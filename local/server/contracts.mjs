// Record contracts for the local writer workspace.
//
// `screenplay-draft` deliberately matches the QiMovi / FilmStack creative
// screenplay draft (schemaVersion 2, local/contracts/creative-screenplay.mjs in
// the QiMovi checkout) so the same data can be pushed to a QiMovi creative
// project without transformation. The only local addition is an optional
// `logline`, which the QiMovi bridge strips before pushing.
//
// `sync-link` records where a draft revision was carried: to a QiMovi project
// or to the hosted competition system. A link is a receipt, not authority; it
// never changes the draft text and never implies acceptance or submission.
import { ID, SHA, check } from './storage.mjs';
import { validateDevelopment } from './development.mjs';
import { validateSharedWorld } from './shared-world.mjs';
import { validateUniverseReceipt } from './qimovi-universe.mjs';
import { validateRightsRecord } from './rights.mjs';
import { validateSourceImport } from './source-import.mjs';

export const AUTHORING_FORMATS = Object.freeze(['vertical', 'micro', 'short', 'pilot_30', 'pilot_60', 'feature']);
export const SYNC_TARGETS = Object.freeze(['qimovi', 'competition']);
export const MAX_BODY_LENGTH = 200000;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (condition, code) => check(condition, code, 422);
const wellFormed = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0');
const label = (value, max) => wellFormed(value) && value.trim().length > 0 && value.length <= max && !/[\r\n]/.test(value);
function shape(value, required, optional, code) {
  need(object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), code);
}

export function validateScreenplayDraft(data, project) {
  shape(data, ['schemaVersion', 'projectId', 'sourceHash', 'title', 'format', 'body', 'status'], ['genre', 'projectFormat', 'targetPages', 'logline'], 'SCREENPLAY_DRAFT_FIELDS_INVALID');
  need(data.schemaVersion === 2 && data.sourceHash === null && data.status === 'DRAFT', 'SCREENPLAY_DRAFT_AUTHORITY_INVALID');
  need(typeof data.projectId === 'string' && ID.test(data.projectId), 'SCREENPLAY_DRAFT_PROJECT_INVALID');
  if (project) need(data.projectId === project.id, 'SCREENPLAY_DRAFT_PROJECT_MISMATCH');
  need(label(data.title, 200), 'SCREENPLAY_DRAFT_TITLE_INVALID');
  need(data.format === 'FOUNTAIN' && wellFormed(data.body) && data.body.length <= MAX_BODY_LENGTH, 'SCREENPLAY_DRAFT_BODY_INVALID');
  if (Object.hasOwn(data, 'genre')) need(wellFormed(data.genre) && data.genre.length <= 120, 'SCREENPLAY_DRAFT_GENRE_INVALID');
  if (Object.hasOwn(data, 'projectFormat')) need(AUTHORING_FORMATS.includes(data.projectFormat), 'SCREENPLAY_DRAFT_FORMAT_INVALID');
  if (Object.hasOwn(data, 'targetPages')) need(Number.isSafeInteger(data.targetPages) && data.targetPages >= 1 && data.targetPages <= 1000, 'SCREENPLAY_DRAFT_TARGET_PAGES_INVALID');
  if (Object.hasOwn(data, 'logline')) need(wellFormed(data.logline) && data.logline.length <= 1000, 'SCREENPLAY_DRAFT_LOGLINE_INVALID');
  return data;
}

export function validateSyncLink(data, project, context = {}) {
  shape(data, ['schemaVersion', 'projectId', 'draftId', 'draftVersion', 'draftSha256', 'target', 'remote', 'linkedAt'], [], 'SYNC_LINK_FIELDS_INVALID');
  need(data.schemaVersion === 1 && (!project || data.projectId === project.id), 'SYNC_LINK_PROJECT_MISMATCH');
  need(typeof data.draftId === 'string' && data.draftId.startsWith('screenplay-draft:') && ID.test(data.draftId), 'SYNC_LINK_DRAFT_INVALID');
  need(Number.isSafeInteger(data.draftVersion) && data.draftVersion >= 1 && SHA.test(data.draftSha256), 'SYNC_LINK_REVISION_INVALID');
  need(SYNC_TARGETS.includes(data.target), 'SYNC_LINK_TARGET_INVALID');
  need(typeof data.linkedAt === 'string' && !Number.isNaN(Date.parse(data.linkedAt)), 'SYNC_LINK_TIME_INVALID');
  if (context.id) need(context.id === `sync-link:${data.target}:${data.draftId.slice('screenplay-draft:'.length)}`, 'RECORD_IDENTITY_MISMATCH');
  if (data.target === 'qimovi') {
    shape(data.remote, ['origin', 'projectId', 'projectTitle', 'projectProfile', 'recordId', 'version', 'sha256'], [], 'SYNC_LINK_REMOTE_INVALID');
    need(/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(data.remote.origin) && ID.test(data.remote.projectId) && label(data.remote.projectTitle, 240) && label(data.remote.projectProfile, 120), 'SYNC_LINK_REMOTE_INVALID');
    need(ID.test(data.remote.recordId) && Number.isSafeInteger(data.remote.version) && data.remote.version >= 1 && SHA.test(data.remote.sha256), 'SYNC_LINK_REMOTE_INVALID');
  } else {
    shape(data.remote, ['hostedOrigin', 'draftId', 'userId'], ['entryId'], 'SYNC_LINK_REMOTE_INVALID');
    need(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(data.remote.hostedOrigin), 'SYNC_LINK_REMOTE_INVALID');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    need(uuid.test(data.remote.draftId) && uuid.test(data.remote.userId) && (data.remote.entryId === undefined || uuid.test(data.remote.entryId)), 'SYNC_LINK_REMOTE_INVALID');
  }
  // A link must point at a revision this workspace actually holds.
  if (context.store) {
    const draft = context.store.history(data.draftId).find(record => record.version === data.draftVersion);
    need(draft && draft.sha256 === data.draftSha256, 'SYNC_LINK_DRAFT_REVISION_UNKNOWN');
  }
  return data;
}

export function validateRecord(kind, data, project, context = {}) {
  if (validateSourceImport(kind, data, project, context)) return data;
  if (validateRightsRecord(kind, data, project, context)) return data;
  if (kind === 'screenplay-draft') return validateScreenplayDraft(data, project);
  if (kind === 'story-development') return validateDevelopment(data, project, context);
  if (kind === 'sync-link') return validateSyncLink(data, project, context);
  if (kind === 'shared-world') return validateSharedWorld(kind, data, project, context.id);
  if (kind === 'universe-sync') return validateUniverseReceipt(data, project, context);
  check(false, 'UNSUPPORTED_RECORD_KIND', 422);
}

/** Shape a local draft for a QiMovi project. Creative projects take the v2 shape; film projects take the source-bound v1 shape. */
export function toQiMoviDraft(data, remoteProject) {
  const metadata = {};
  for (const key of ['genre', 'projectFormat', 'targetPages']) if (Object.hasOwn(data, key)) metadata[key] = data[key];
  if (remoteProject.profile === 'caniscreenwrite-creative/v1') {
    return { schemaVersion: 2, projectId: remoteProject.id, sourceHash: null, title: data.title, format: 'FOUNTAIN', body: data.body, status: 'DRAFT', ...metadata };
  }
  check(typeof remoteProject.sourceHash === 'string' && SHA.test(remoteProject.sourceHash), 'QIMOVI_PROJECT_SOURCE_UNKNOWN', 422);
  return { sourceHash: remoteProject.sourceHash, title: data.title, format: 'FOUNTAIN', body: data.body, ...metadata };
}

/** Shape a QiMovi draft record for this workspace. Scene maps and source bindings stay in QiMovi. */
export function fromQiMoviDraft(remoteData, localProject, previousLocal) {
  const metadata = {};
  for (const key of ['genre', 'projectFormat', 'targetPages']) if (Object.hasOwn(remoteData, key)) metadata[key] = remoteData[key];
  if (previousLocal && Object.hasOwn(previousLocal, 'logline')) metadata.logline = previousLocal.logline;
  return { schemaVersion: 2, projectId: localProject.id, sourceHash: null, title: remoteData.title, format: 'FOUNTAIN', body: remoteData.body, status: 'DRAFT', ...metadata };
}
