// Local creative planning only. Financial authority remains in QiMovi.
import { check, ID, SHA, canonicalJson, sha256 } from './storage.mjs';
import { scanBrandOpportunities, BRAND_SCAN_LIMITS } from '../contracts/brand-scanner.mjs';

export const brandReviewId = draftId => `brand-review:${sha256(draftId)}`;
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ref = row => ({ id: row.id, version: row.version, sha256: row.sha256 });
function checkedDraft(row, project) {
  check(row?.kind === 'screenplay-draft' && row.data.projectId === project.id, 'BRAND_DRAFT_NOT_FOUND', 404);
  check(sha256(canonicalJson(row.data)) === row.sha256, 'BRAND_DRAFT_CORRUPT', 409);
  check(typeof row.data.body === 'string' && Buffer.byteLength(row.data.body, 'utf8') <= BRAND_SCAN_LIMITS.sourceBytes, 'BRAND_SOURCE_TOO_LARGE', 413);
  return row;
}
export function sourceForBrandDraft(draft) {
  return { id: draft.id, label: `${draft.data.title} · saved v${draft.version}`, fingerprint: sha256(canonicalJson(ref(draft))),
    sourceHash: sha256(draft.data.body), recordRef: ref(draft) };
}
export function scanWriterBrands(store, input) {
  check(shape(input, ['draftId', 'draftVersion', 'draftSha256']), 'BRAND_SCAN_FIELDS_INVALID', 422);
  check(typeof input.draftId === 'string' && ID.test(input.draftId), 'BRAND_DRAFT_INVALID', 422);
  const draft = checkedDraft(store.current(input.draftId), store.project());
  check(draft.version === input.draftVersion && draft.sha256 === input.draftSha256, 'BRAND_SOURCE_CHANGED', 409);
  const source = sourceForBrandDraft(draft), record = store.current(brandReviewId(draft.id));
  if (record) {
    check(sha256(canonicalJson(record.data)) === record.sha256, 'BRAND_REVIEW_CORRUPT', 409);
    validateBrandReview(record.data, store.project(), { id: record.id, store });
  }
  return { schemaVersion: 'qiscreenwrite-brand-planning/v1', projectId: store.project().id, source,
    ...scanBrandOpportunities(draft.data.body, source, sha256), reviewId: brandReviewId(draft.id), reviewRecord: record,
    stale: Boolean(record && (record.data.sourceRef.sha256 !== draft.sha256 || record.data.sourceRef.version !== draft.version)),
    method: 'LOCAL_KEYWORD_HEURISTIC', authority: 'CREATIVE_PLANNING_ONLY', approvalGranted: false };
}
export function validateBrandReview(data, project, context = {}) {
  check(shape(data, ['schemaVersion', 'projectId', 'draftId', 'sourceRef', 'reviews', 'approvalGranted'])
    && data.schemaVersion === 1 && data.projectId === project.id && data.approvalGranted === false, 'BRAND_REVIEW_FIELDS_INVALID', 422);
  check(typeof data.draftId === 'string' && data.draftId.startsWith('screenplay-draft:') && ID.test(data.draftId)
    && (!context.id || context.id === brandReviewId(data.draftId)), 'BRAND_REVIEW_ID_INVALID', 422);
  check(shape(data.sourceRef, ['id', 'version', 'sha256']) && data.sourceRef.id === data.draftId
    && Number.isSafeInteger(data.sourceRef.version) && data.sourceRef.version > 0 && SHA.test(data.sourceRef.sha256), 'BRAND_REVIEW_SOURCE_INVALID', 422);
  check(Array.isArray(data.reviews) && data.reviews.length <= BRAND_SCAN_LIMITS.opportunities, 'BRAND_REVIEW_LIMIT', 422);
  const ids = new Set();
  for (const review of data.reviews) {
    check(shape(review, ['opportunityId', 'decision', 'reason']) && typeof review.opportunityId === 'string'
      && /^placement:[a-f0-9]{40}$/.test(review.opportunityId) && !ids.has(review.opportunityId)
      && ['approved', 'rejected'].includes(review.decision) && typeof review.reason === 'string'
      && review.reason.trim().length > 0 && review.reason.length <= 1000 && review.reason.isWellFormed()
      && !/[\x00-\x1f\x7f]/.test(review.reason), 'BRAND_REVIEW_INVALID', 422);
    ids.add(review.opportunityId);
  }
  if (context.store) {
    const draft = checkedDraft(context.store.history(data.draftId).find(row => row.version === data.sourceRef.version), project);
    check(draft.sha256 === data.sourceRef.sha256, 'BRAND_REVIEW_SOURCE_INVALID', 409);
    if (context.writing) {
      const current = context.store.current(data.draftId);
      check(current?.version === draft.version && current.sha256 === draft.sha256, 'BRAND_SOURCE_CHANGED', 409);
    }
    const found = new Set(scanBrandOpportunities(draft.data.body, sourceForBrandDraft(draft), sha256).opportunities.map(row => row.id));
    check(data.reviews.every(review => found.has(review.opportunityId)), 'BRAND_OPPORTUNITY_MISSING', 409);
  }
  return data;
}
