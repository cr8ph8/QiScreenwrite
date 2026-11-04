import { usageView } from '../accounting/resource-view.mjs';
export function resourceSnapshot(journal, creativeServices) {
  const value = journal.snapshot(), jobs = creativeServices.list();
  return { ...value, runs: value.runs.slice(-100), entries: value.entries.slice(-100), rates: value.rates.slice(-100), usage: usageView(jobs.map(job => ({ key: `local:${job.id}`, taskId: job.id, provider: 'OLLAMA', model: job.model, origin: 'LOCAL_ANALYSIS',
    inputTokens: job.report?.usage.inputTokens ?? null, outputTokens: job.report?.usage.outputTokens ?? null, status: job.status, timestamp: job.createdAt,
    cost: null, costKind: 'unknown', currency: null })), value.runs), issues: creativeServices.issues.map(() => 'ANALYSIS_RECEIPT_INVALID'), production: null, financing: null,
    coverage: { ...value.coverage, linkedFilm: 'EXPLICIT_READ_AFTER_SAVED_SCREENPLAY_TRANSFER', hostedAnalysis: 'SEPARATE_SERVICE_NOT_METERED_HERE' } };
}
