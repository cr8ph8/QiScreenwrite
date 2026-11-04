import { need } from './resource-math.mjs';
// A captured provider attempt supersedes only its exact native attempt's token
// counters. Imported provider bills and unrelated tasks are never auto-matched.
export function usageView(native, runs) {
  const rows = new Map(native.map(row => [row.key, row]));
  for (const run of runs) {
    const key = `local:${run.taskId}`, prior = rows.get(key);
    need(!prior || prior.model === run.model && prior.provider.toLowerCase() === run.provider.toLowerCase(), 'RESOURCE_ATTEMPT_MISMATCH', 409);
    rows.set(key, { ...prior, key, taskId: run.taskId, origin: 'DIRECT_LOCAL_METER', provider: run.provider, model: run.model,
      inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, status: prior?.status ?? run.status,
      elapsedMs: run.usage.elapsedMs, estimate: run.estimate, timestamp: run.startedAt, currency: run.estimate?.currency ?? null,
      // Counts are provider-reported, not token estimates. The price is separate.
      cost: prior?.cost ?? null, costKind: prior?.costKind ?? 'unknown' });
  }
  const groups = new Map();
  for (const row of rows.values()) {
    const key = JSON.stringify([row.provider, row.model, row.origin]);
    const group = groups.get(key) ?? { provider: row.provider, model: row.model, origin: row.origin, attempts: 0, inputKnown: 0n, outputKnown: 0n, inputUnknown: 0, outputUnknown: 0 };
    group.attempts++;
    for (const [field, total, unknown] of [['inputTokens', 'inputKnown', 'inputUnknown'], ['outputTokens', 'outputKnown', 'outputUnknown']]) {
      if (row[field] === null || row[field] === undefined) group[unknown]++;
      else { need(Number.isSafeInteger(row[field]) && row[field] >= 0, 'RESOURCE_NATIVE_USAGE_INVALID', 409); group[total] += BigInt(row[field]); }
    }
    groups.set(key, group);
  }
  return { totalAttempts: rows.size, groups: [...groups.values()].map(row => ({ ...row, inputKnown: row.inputKnown.toString(), outputKnown: row.outputKnown.toString() })),
    attempts: [...rows.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 100),
    notice: 'Input/output counts are separated. Cached input and reasoning are subsets, not additional tokens. Different providers/accounts are not interchangeable.' };
}
