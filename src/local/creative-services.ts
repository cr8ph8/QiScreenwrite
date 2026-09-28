import { request } from './api';
import { validateInput, validateReport, type AnalysisInput, type AnalysisReport, type ServiceKind } from '../../shared/creative-services/contract.mjs';
import type { DraftRecord } from './types';
import { canonicalJson } from './model';
export { type AnalysisInput, type AnalysisReport, type ServiceKind };
export const SERVICE_NAMES: Record<ServiceKind, string> = { coverage: 'Screenplay scoring & coverage', screenplay_profile: 'Screenplay profile', character_profile: 'Character profile' };
export interface AnalysisJob { id: string; status: 'running' | 'completed' | 'failed' | 'refunded' | 'uncertain'; credits?: number; input?: AnalysisInput; report: AnalysisReport | null; error: string | null }
export interface ServiceQuote { id: string; kind: ServiceKind; model: string; credits: number; expiresAt: string; input: AnalysisInput }
export interface ServiceCatalog { enabled: boolean; services: { kind: ServiceKind; model: string; credits: number; enabled: boolean }[]; balance: number | null }
export const analysisApi = {
  models: (endpoint: string) => request<{ endpoint: string; models: { name: string; size: number; digest: string }[] }>('/api/creative-services/models', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  run: (requestId: string, endpoint: string, model: string, input: AnalysisInput) => request<AnalysisJob>('/api/creative-services/local', { method: 'POST', body: JSON.stringify({ requestId, endpoint, model, input }) }),
  history: (draftId: string) => request<{ jobs: AnalysisJob[]; issues: { id: string; code: string }[] }>(`/api/creative-services/jobs?draftId=${encodeURIComponent(draftId)}`),
};
export async function prepareAnalysis(draft: DraftRecord, kind: ServiceKind, characterName: string, excerptApproved: boolean): Promise<AnalysisInput> {
  const body = draft.data.body;
  if (body.length > 12000 && !excerptApproved) throw new Error('Review and select the opening-passage option for this longer draft.');
  // Never split a surrogate pair at the passage boundary.
  let excerpt = body.slice(0, 12000); if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return validateInput({ schemaVersion: 1, kind, characterName: kind === 'character_profile' ? characterName.trim() : '', source: { draftId: draft.id, title: draft.data.title, bodySha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''), excerpt, scope: excerpt === body ? 'full' : 'excerpt' } });
}
export function checkedJob(job: AnalysisJob, expected?: AnalysisInput): AnalysisJob {
  if (!job || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(job.id) || !['running', 'completed', 'failed', 'refunded', 'uncertain'].includes(job.status)) throw new Error('The service returned an invalid job receipt.');
  if (job.status === 'completed') {
    validateReport(job.report);
    if (expected && canonicalJson(job.report!.input) !== canonicalJson(expected)) throw new Error('The returned report does not match the reviewed request.');
  } else if (job.report !== null) throw new Error('The service returned an inconsistent job receipt.');
  return job;
}
export function checkedHostedJob(job: AnalysisJob, quote?: ServiceQuote, expectedId?: string): AnalysisJob {
  checkedJob(job, quote?.input);
  if (job.status === 'failed' || !Number.isSafeInteger(job.credits) || job.credits! < 1
    || (expectedId && job.id !== expectedId) || (quote && job.credits !== quote.credits)
    || (job.report && (job.report.provider !== 'hosted' || job.report.id !== job.id || job.report.platformCredits !== job.credits || quote && job.report.model !== quote.model))) {
    throw new Error('The hosted receipt does not match the confirmed model, price or job. Check status before requesting another analysis.');
  }
  return job;
}
/** Loads the optional hosted connector only after an explicit connect action. */
export async function hostedAnalysis<T>(payload: object): Promise<T> {
  const { getClient } = await import('./connectors/competition');
  const client = await getClient();
  const { data, error } = await client.functions.invoke('creative-services', { body: payload });
  if (error) throw new Error('Hosted services are unavailable or need sign-in. No automatic retry was sent. Refresh job status before trying again.');
  if (!data || data.error) throw new Error(typeof data?.error === 'string' ? data.error : 'Invalid service response.');
  return data as T;
}
