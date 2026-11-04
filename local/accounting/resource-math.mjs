// Exact resource accounting. Quantities are not interchangeable currencies.
export const SCALE = 1_000_000_000n;
const MAX = 10n ** 27n - 1n;
export const need = (ok, code, status = 422) => { if (!ok) throw Object.assign(new Error(code), { code, status }); };
export const text = (v, max = 240) => typeof v === 'string' && v.length > 0 && v.length <= max && v.isWellFormed() && !/[\x00-\x1f\x7f]/.test(v);
export function exact(v, keys) { need(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(','), 'RESOURCE_FIELDS_INVALID'); }
export function units(v) {
  need(typeof v === 'string' && /^(0|[1-9]\d{0,11})(?:\.\d{1,9})?$/.test(v), 'RESOURCE_DECIMAL_INVALID');
  const [a, b = ''] = v.split('.'); return BigInt(a) * SCALE + BigInt(b.padEnd(9, '0'));
}
export function decimal(n) {
  need(typeof n === 'bigint' && n >= 0n && n <= MAX, 'RESOURCE_TOTAL_OVERFLOW', 413);
  return `${n / SCALE}.${String(n % SCALE).padStart(9, '0')}`.replace(/\.?0+$/, '') || '0';
}
export function sum(values) { return decimal(values.reduce((a, b) => a + units(b), 0n)); }
export function product(a, b, divisor = '1') {
  const d = units(divisor); need(d > 0n, 'RESOURCE_DIVISOR_INVALID');
  return decimal((units(a) * units(b) + d / 2n) / d);
}
export function iso(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v; }
export const METRICS = Object.freeze(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'elapsedMs', 'providerMs']);
export function metrics(value = {}) {
  need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => METRICS.includes(k)), 'RESOURCE_METRIC_INVALID');
  const result = Object.fromEntries(METRICS.map(k => [k, value[k] === undefined ? null : value[k]]));
  for (const v of Object.values(result)) need(v === null || Number.isSafeInteger(v) && v >= 0 && v < 1e12, 'RESOURCE_METRIC_INVALID');
  need(result.cachedInputTokens === null || result.inputTokens !== null && result.cachedInputTokens <= result.inputTokens, 'RESOURCE_TOKEN_SUBSET_INVALID');
  need(result.reasoningTokens === null || result.outputTokens !== null && result.reasoningTokens <= result.outputTokens, 'RESOURCE_TOKEN_SUBSET_INVALID');
  return result;
}
export function ollamaMetrics(result, elapsedMs) {
  const count = v => Number.isSafeInteger(v) && v >= 0 && v < 1e12 ? v : null;
  const input = count(result?.prompt_eval_count), cached = count(result?.prompt_eval_cached_count);
  return metrics({ inputTokens: input, cachedInputTokens: input !== null && cached !== null && cached <= input ? cached : null, outputTokens: count(result?.eval_count), elapsedMs: count(elapsedMs),
    providerMs: Number.isSafeInteger(result?.total_duration) && result.total_duration >= 0 ? count(Math.ceil(result.total_duration / 1e6)) : null });
}
export function validateRate(rate) {
  exact(rate, ['id', 'provider', 'model', 'currency', 'inputPerMillion', 'outputPerMillion', 'cachedPerMillion', 'watts', 'electricityPerKwh', 'validFrom', 'expiresAt', 'basis']);
  for (const key of ['id', 'provider', 'model', 'basis']) need(text(rate[key]), 'RESOURCE_RATE_INVALID');
  need(/^[A-Z]{3}$/.test(rate.currency) && iso(rate.validFrom) && iso(rate.expiresAt) && rate.validFrom < rate.expiresAt, 'RESOURCE_RATE_INVALID');
  for (const key of ['inputPerMillion', 'outputPerMillion', 'cachedPerMillion', 'watts', 'electricityPerKwh']) if (rate[key] !== null) units(rate[key]);
  need((rate.watts === null) === (rate.electricityPerKwh === null), 'RESOURCE_ENERGY_ASSUMPTION_INCOMPLETE');
  return rate;
}
export function estimate(value, rate, { at = new Date().toISOString(), local = false } = {}) {
  const usage = metrics(value); if (rate) validateRate(rate);
  const usable = rate && rate.validFrom <= at && at < rate.expiresAt;
  if (!usable) return { currency: rate?.currency ?? null, modelCost: null, energyKwh: null, electricityCost: null, basis: rate ? 'RATE_EXPIRED_OR_NOT_ACTIVE' : 'RATE_UNKNOWN' };
  let input = null, output = null;
  if (usage.inputTokens !== null && rate.inputPerMillion !== null) {
    // A distinct cache rate requires a known cache count; never guess zero.
    if (rate.cachedPerMillion === null || rate.cachedPerMillion === rate.inputPerMillion) input = product(String(usage.inputTokens), rate.inputPerMillion, '1000000');
    else if (usage.cachedInputTokens !== null) input = sum([product(String(usage.inputTokens - usage.cachedInputTokens), rate.inputPerMillion, '1000000'), product(String(usage.cachedInputTokens), rate.cachedPerMillion, '1000000')]);
  }
  if (usage.outputTokens !== null && rate.outputPerMillion !== null) output = product(String(usage.outputTokens), rate.outputPerMillion, '1000000');
  const energyKwh = local && rate.watts !== null && usage.elapsedMs !== null ? product(rate.watts, String(usage.elapsedMs), '3600000000') : null;
  return { currency: rate.currency, modelCost: input !== null && output !== null ? sum([input, output]) : null,
    energyKwh, electricityCost: energyKwh === null ? null : product(energyKwh, rate.electricityPerKwh), basis: 'OWNER_RATE_ESTIMATE_NOT_BILL', energyAllocation: 'PER_RUN_NOT_ADDITIVE_DURING_OVERLAP', rateId: rate.id };
}
export function validateEntry(entry) {
  exact(entry, ['id', 'stage', 'unit', 'amount', 'provider', 'account', 'taskId', 'evidence', 'recordedAt']);
  for (const k of ['id', 'provider', 'account', 'taskId', 'evidence']) need(text(entry[k]), 'RESOURCE_ENTRY_INVALID');
  need(['estimate', 'incurred', 'paid', 'received', 'refund', 'allocation'].includes(entry.stage), 'RESOURCE_STAGE_INVALID');
  need(typeof entry.unit === 'string' && /^(money:[A-Z]{3}|credits|tokens:input|tokens:output|energy:kWh|time:hours|storage:GB-month|compute:seconds)$/.test(entry.unit), 'RESOURCE_UNIT_INVALID');
  units(entry.amount); if (entry.unit.startsWith('tokens:')) need(/^(0|[1-9]\d{0,11})$/.test(entry.amount), 'RESOURCE_TOKEN_INTEGER_REQUIRED'); need(iso(entry.recordedAt), 'RESOURCE_TIMESTAMP_INVALID');
  return entry;
}
export function entryTotals(entries) {
  const groups = new Map();
  for (const entry of entries) { validateEntry(entry); const key = JSON.stringify([entry.stage, entry.unit, entry.provider, entry.account]);
    const row = groups.get(key) ?? { stage: entry.stage, unit: entry.unit, provider: entry.provider, account: entry.account, amount: 0n, entries: 0 };
    row.amount += units(entry.amount); row.entries++; groups.set(key, row);
  }
  return [...groups.values()].map(row => ({ ...row, amount: decimal(row.amount), basis: 'OWNER_RECORDED_NOT_EXTERNALLY_VERIFIED' }));
}
