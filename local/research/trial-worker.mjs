import { parentPort, workerData } from 'node:worker_threads';

// Trusted, fixed worker: numeric configuration is data, never executable code.
// A Worker bounds execution time; it is NOT a security sandbox for arbitrary code.
const start = performance.now();
const cpuStart = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null;
const words = value => new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const matches = (query, value) => [...query].filter(word => words(value).has(word)).length;
const { config, documents, queries } = workerData;
const predictions = queries.map(query => {
  const terms = words(query.query);
  const ranked = documents.map(doc => ({ id: doc.id, score:
    config.titleWeight * matches(terms, doc.title)
    + config.textWeight * matches(terms, doc.text)
    + config.tagWeight * matches(terms, doc.tags.join(' '))
  })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { queryId: query.id, sourceIds: ranked.slice(0, 3).map(row => row.id) };
});
const cpu = cpuStart ? process.threadCpuUsage(cpuStart) : null;
parentPort.postMessage({ predictions, workerElapsedMs: Math.ceil(performance.now() - start), cpuMicros: cpu ? cpu.user + cpu.system : null });
