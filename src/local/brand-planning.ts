import { request, localApi } from './api';
import type { DraftRecord, RecordInput, WorkspaceRecord } from './types';
export type BrandReviewData = { schemaVersion: 1; projectId: string; draftId: string; sourceRef: { id: string; version: number; sha256: string };
  reviews: { opportunityId: string; decision: 'approved' | 'rejected'; reason: string }[]; approvalGranted: false };
export type BrandPlan = { schemaVersion: 'qiscreenwrite-brand-planning/v1'; projectId: string; source: { id: string; fingerprint: string; sourceHash: string; recordRef: { id: string; version: number; sha256: string } };
  opportunities: { id: string; heading: string; category: string; quote: string; context: string; start: number; end: number }[];
  reviewId: string; reviewRecord: WorkspaceRecord<BrandReviewData> | null; stale: boolean; truncated: boolean; authority: 'CREATIVE_PLANNING_ONLY'; approvalGranted: false };
export type BrandContext = { schemaVersion: 'qimovi-brand-context/v1'; projectId: string; draftId: string; draftVersion: number; draftSha256: string;
  ledgerVersion: number; readOnly: true; approvalGranted: false; externalVerification: false; authority: 'OWNER_RECORDED_PLANNING_ONLY'; totalsScope: 'PROJECT_NOT_DRAFT';
  reviews: { id: string; heading: string; decision: string; stale: boolean; reason: string }[];
  deals: { id: string; sponsor: string; status: string; currency: string; cash: string }[];
  totals: { currency: string; signedCash: string; receivedCash: string; remainingBeforeOtherFunding: string | null }[] };
export type BrandPlanningApi = { scan(draft: DraftRecord): Promise<BrandPlan>; save(input: RecordInput<BrandReviewData>): Promise<WorkspaceRecord<BrandReviewData>>; context(draft: DraftRecord): Promise<BrandContext> };
export const brandPlanningApi: BrandPlanningApi = {
  async scan(draft) {
    const data = await request<BrandPlan>('/api/brands/scan', { method: 'POST', body: JSON.stringify({ draftId: draft.id, draftVersion: draft.version, draftSha256: draft.sha256 }) });
    if (data?.schemaVersion !== 'qiscreenwrite-brand-planning/v1' || data.projectId !== draft.data.projectId
      || data.source?.recordRef?.id !== draft.id || data.source.recordRef.version !== draft.version || data.source.recordRef.sha256 !== draft.sha256
      || data.authority !== 'CREATIVE_PLANNING_ONLY' || data.approvalGranted !== false || !Array.isArray(data.opportunities)
      || typeof data.reviewId !== 'string' || !/^brand-review:[a-f0-9]{64}$/.test(data.reviewId)) throw new Error('The local brand scan did not match this saved draft.');
    return data;
  },
  save: input => localApi.save(input),
  async context(draft) {
    const data = await request<BrandContext>('/api/brands/qimovi-context', { method: 'POST', body: JSON.stringify({ draftId: draft.id }) });
    if (data?.schemaVersion !== 'qimovi-brand-context/v1' || data.draftId !== draft.id || data.draftVersion !== draft.version
      || data.draftSha256 !== draft.sha256 || data.readOnly !== true || data.approvalGranted !== false || data.externalVerification !== false
      || data.authority !== 'OWNER_RECORDED_PLANNING_ONLY' || data.totalsScope !== 'PROJECT_NOT_DRAFT'
      || ![data.reviews, data.deals, data.totals].every(Array.isArray)) throw new Error('The connected context did not match this transferred revision.');
    return data;
  },
};
