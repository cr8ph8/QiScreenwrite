import crypto from 'node:crypto';

export const need = (ok, code, status = 422) => { if (!ok) throw Object.assign(new Error(code), { code, status }); };
export const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function exact(value, keys) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'RESEARCH_FIELDS_INVALID');
}
export function validateConfig(config) {
  exact(config, ['titleWeight', 'textWeight', 'tagWeight']);
  need(Object.values(config).every(v => Number.isSafeInteger(v) && v >= 0 && v <= 8)
    && Object.values(config).some(v => v > 0), 'RESEARCH_CONFIG_INVALID');
  return config;
}
export const complexity = config => Object.values(validateConfig(config)).filter(v => v > 0).length;

// This evaluator owns the labels. The candidate worker returns source IDs only;
// a candidate-supplied score, loss or PASS is never acceptance evidence.
export function scorePredictions(predictions, queries, documents) {
  need(Array.isArray(predictions) && predictions.length === queries.length, 'RESEARCH_PREDICTIONS_INVALID');
  const ids = new Set(documents.map(d => d.id));
  const byQuery = new Map();
  for (const row of predictions) {
    exact(row, ['queryId', 'sourceIds']);
    need(typeof row.queryId === 'string' && !byQuery.has(row.queryId) && Array.isArray(row.sourceIds)
      && row.sourceIds.length >= 1 && row.sourceIds.length <= 3
      && new Set(row.sourceIds).size === row.sourceIds.length && row.sourceIds.every(id => ids.has(id)), 'RESEARCH_PROVENANCE_INVALID');
    byQuery.set(row.queryId, row.sourceIds);
  }
  let correct = 0;
  for (const query of queries) {
    need(byQuery.has(query.id), 'RESEARCH_QUERY_MISSING');
    if (query.relevantIds.includes(byQuery.get(query.id)[0])) correct++;
  }
  return { correct, total: queries.length, accuracy: correct / queries.length };
}
export function better(candidateScore, candidateConfig, incumbentScore, incumbentConfig) {
  need(candidateScore.total === incumbentScore.total, 'RESEARCH_SCORE_SCOPE_INVALID');
  return candidateScore.correct > incumbentScore.correct
    || candidateScore.correct === incumbentScore.correct && complexity(candidateConfig) < complexity(incumbentConfig);
}

export const REQUIRED_CHECKS = Object.freeze(['shape', 'scope', 'verification', 'authority', 'source', 'budget', 'accounting']);
export function decide({ checks, governance = false, replay = false, stale = false, improved = false, omega = null }) {
  if (checks?.shape === 'FAIL') return 'REJECT';
  if (governance || replay || stale) return 'ESCALATE';
  const statuses = REQUIRED_CHECKS.map(key => checks?.[key]);
  if (statuses.some(v => v === 'ERROR' || v === 'FAIL')) return 'REJECT';
  if (statuses.some(v => v !== 'PASS')) return 'ESCALATE';
  const base = improved ? 'COMMIT' : 'DAMP';
  // Omega can only withhold an otherwise available admission. Null is recorded
  // as absent telemetry, never as a new source of permission.
  return ['DAMP', 'ESCALATE', 'REJECT'].includes(omega) ? omega : base;
}
