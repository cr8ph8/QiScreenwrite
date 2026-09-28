// A creative workspace can exist before it has a screenplay. Empty source
// fields are intentional and confer no screenplay or production authority.
export const CREATIVE_PROJECT_PROFILE = 'caniscreenwrite-creative/v1';
export const CREATIVE_PROJECT_RECORD_KINDS = Object.freeze(['asset-token-preparation', 'project-participation', 'writing-production-plan', 'production-budget', 'usage-observation', 'project-direction', 'studio-operation', 'studio-media', 'screenplay-draft', 'concept-draft', 'story-plan-draft', 'pitch-draft', 'writing-note', 'studio-generation', 'studio-reference', 'asset-market-profile', 'project-asset', 'asset-curation', 'universe-entity', 'universe-profile', 'universe-claim', 'universe-link', 'universe-continuity-plan', 'universe-production-plan']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (value, code) => { if (!value) throw Object.assign(new Error(code), { code, status: 422 }); };
export const isCreativeProject = project => project?.profile === CREATIVE_PROJECT_PROFILE;

export function validateCreativeProject(project) {
  const required = ['id', 'title', 'profile', 'sourceHash', 'sourceStatus', 'scenes', 'cells', 'characters', 'continuityQuestions'];
  const optional = ['cellBasisHashes', 'cellRevisionSceneIds'];
  need(object(project) && required.every(key => Object.hasOwn(project, key)) && Object.keys(project).every(key => required.includes(key) || optional.includes(key)), 'CREATIVE_PROJECT_FIELDS_INVALID');
  need(typeof project.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(project.id), 'CREATIVE_PROJECT_ID_INVALID');
  need(typeof project.title === 'string' && project.title.trim().length > 0 && project.title.length <= 240 && project.title.isWellFormed() && !/[\x00-\x1f\x7f]/.test(project.title), 'CREATIVE_PROJECT_TITLE_INVALID');
  need(isCreativeProject(project) && project.sourceHash === null && project.sourceStatus === 'NO_SCREENPLAY', 'CREATIVE_PROJECT_SOURCE_INVALID');
  for (const key of ['scenes', 'cells', 'characters', 'continuityQuestions']) need(Array.isArray(project[key]) && project[key].length === 0, 'CREATIVE_PROJECT_SOURCE_REQUIRED');
  if (Object.hasOwn(project, 'cellBasisHashes')) need(object(project.cellBasisHashes) && Object.keys(project.cellBasisHashes).length === 0, 'CREATIVE_PROJECT_SOURCE_REQUIRED');
  if (Object.hasOwn(project, 'cellRevisionSceneIds')) need(Array.isArray(project.cellRevisionSceneIds) && project.cellRevisionSceneIds.length === 0, 'CREATIVE_PROJECT_SOURCE_REQUIRED');
  return project;
}


/** Recover the unchanged development identity for project-owned records only.
 * An attachment never rewrites a draft's source or grants production authority.
 */
export function projectOwnedContext(project, kind, data) {
  if (!project?.creativeOrigin || data?.sourceHash !== null || !CREATIVE_PROJECT_RECORD_KINDS.includes(kind)) return project;
  const original = validateCreativeProject(project.creativeOrigin);
  need(original.id === project.id && original.title === project.title, 'CREATIVE_ORIGIN_PROJECT_MISMATCH');
  const validRef = ref => object(ref) && Object.keys(ref).sort().join(',') === 'id,sha256,version'
    && typeof ref.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(ref.id)
    && Number.isSafeInteger(ref.version) && ref.version > 0 && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256);
  need(typeof project.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(project.sourceHash)
    && validRef(project.productionAttachmentRef) && project.productionAttachmentRef.version === 1
    && project.productionAttachmentRef.id === `production-attachment:${original.id}`
    && validRef(project.productionDraftRef) && project.productionDraftRef.id.startsWith('screenplay-draft:')
    && validRef(project.productionPlanRef) && /^writing-production-plan:[a-f0-9]{64}$/.test(project.productionPlanRef.id), 'CREATIVE_ORIGIN_ATTACHMENT_INVALID');
  // Project direction's project identity is bound by its exact record ID.
  if (kind !== 'project-direction') need(data.projectId === original.id, 'CREATIVE_ORIGIN_RECORD_PROJECT_MISMATCH');
  return original;
}
