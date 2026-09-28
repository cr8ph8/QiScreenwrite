// Reviewed return of existing writer world text. Transfer receipts identify the
// historical base; names, classifications, statuses and remote claims never
// establish identity, authorship rights or canon authority.
import { canonicalJson, check, SHA, sha256 } from './storage.mjs';
import { universeSource, universeBinding, mapUniverse } from './qimovi-universe.mjs';
import { validateDevelopment } from './development.mjs';
import { DevelopmentRecoveryStore } from './recovery.mjs';
import { WORLD_LIMITS } from './world.mjs';

const FIELDS = ['name', 'description', 'storyFunction', 'sensoryDetails', 'continuity'];
const ref = record => ({ id: record.id, version: record.version, sha256: record.sha256 });
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const connection = bridge => sha256(canonicalJson(bridge.config()));
const notes = [
  'Compare text from existing writer entries with the last confirmed transfer. Choose each QiMovi change explicitly; local-only changes stay here.',
  'Types, order, author labels, links, citations, canon, rights and production approvals are retained locally and are not imported.',
  'New, missing, set-aside or untracked QiMovi entries and extra claim parts need a separate review. Nothing is matched by name or deleted.',
  'The saved return is a local development revision. Original transfer receipts stay intact; sending back may still require review of independent QiMovi edits.',
];
const validText = (text, field) => typeof text === 'string' && text.length <= WORLD_LIMITS[field] && text.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
const stale = () => check(false, 'QIMOVI_WORLD_RETURN_PREVIEW_STALE', 409, 'The saved draft, world, connection or QiMovi entries changed. Review the return again.');

function recoveryClear(store, source) {
  // Do not create a recovery table when previewing a bare store.
  if (!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='development_recovery'").get()) return;
  const copy = new DevelopmentRecoveryStore(store).get(source.draft.id);
  const base = copy && store.history(source.development.id).find(r => r.version === copy.baseVersion && r.sha256 === copy.baseSha256);
  const clean = !copy || [source.development, base].filter(Boolean).some(r => same(copy.data, r.data) && (!copy.pendingSave || same(copy.pendingSave.data, r.data)));
  check(clean, 'QIMOVI_WORLD_RETURN_RECOVERY_PENDING', 409, 'Save or resolve the recovered World Builder changes before reviewing a QiMovi return.');
}

function historicalSource(store, source, receipt) {
  const data = receipt.data;
  const draft = store.history(source.draft.id).find(r => r.version === data.draftVersion && r.sha256 === data.draftSha256);
  const development = store.history(source.development.id).find(r => r.version === data.developmentVersion && r.sha256 === data.developmentSha256);
  check(draft && development && draft.sha256 === sha256(canonicalJson(draft.data)) && development.sha256 === sha256(canonicalJson(development.data)), 'QIMOVI_WORLD_RETURN_BASE_INVALID', 409, 'The original transfer revision is unavailable. Its fields cannot be merged safely.');
  return { project: source.project, draft, development };
}

/** Pure three-way planner over saved source and a verified remote snapshot. */
export function planWorldReturn(store, source, project, records, binding, connectionHash) {
  // Also validates that this is a supported creative or source-backed project.
  const mapping = mapUniverse(source, project);
  const receipts = store.list('universe-sync').filter(r => r.data.draftId === source.draft.id && r.data.binding === binding);
  check(!receipts.some(r => r.data.targetProjectId !== project.id || r.data.targetSourceHash !== project.sourceHash), 'QIMOVI_WORLD_RETURN_PROJECT_CHANGED', 409, 'The transfer belongs to a different QiMovi project or screenplay source.');
  check(receipts.length, 'QIMOVI_WORLD_RETURN_NOT_TRANSFERRED', 409, 'Send this saved world to the QiMovi Universe first. Reference-file exports alone do not establish editable entry identities.');
  const receiptMap = new Map(receipts.map(r => [r.data.record.id, r]));
  const remote = new Map();
  for (const record of records) {
    check(!remote.has(record.id), 'QIMOVI_REMOTE_REVISION_INVALID', 502);
    remote.set(record.id, record);
  }
  const bases = new Map();
  const baseFor = receipt => {
    const key = `${receipt.data.developmentVersion}:${receipt.data.developmentSha256}:${receipt.data.draftVersion}:${receipt.data.draftSha256}`;
    if (!bases.has(key)) {
      const value = historicalSource(store, source, receipt);
      bases.set(key, { source: value, mapping: new Map(mapUniverse(value, project).map(r => [r.id, r])) });
    }
    return bases.get(key);
  };
  // Validate every tracked remote record, including unchanged records that bind
  // the preview. An unrelated forged record can never supply a mapped field.
  for (const receipt of receipts) {
    check(receipt.sha256 === sha256(canonicalJson(receipt.data)), 'QIMOVI_WORLD_RETURN_BASE_INVALID', 409);
    const record = remote.get(receipt.data.record.id);
    if (!record) continue;
    check(record.kind === receipt.data.record.kind && Number.isSafeInteger(record.version) && record.version > 0 && record.sha256 === sha256(canonicalJson(record.data)), 'QIMOVI_REMOTE_REVISION_INVALID', 502);
    check(record.data.sourceHash === project.sourceHash && (project.sourceHash !== null || record.data.projectId === project.id), 'QIMOVI_WORLD_RETURN_PROJECT_CHANGED', 409);
  }
  const items = [];
  for (const element of source.development.data.world.elements) {
    const entity = mapping.find(r => r.kind === 'universe-entity' && r.data.entityId.endsWith(`:${element.id.toLowerCase()}`));
    const receipt = receiptMap.get(entity.id), currentEntity = remote.get(entity.id);
    for (const field of FIELDS) {
      const item = { id: `${element.id}:${field}`, elementId: element.id, elementName: element.name, field, base: null, local: element[field], remote: null, state: 'unsupported', selectable: false, remoteRecords: [] };
      const block = reason => { item.reason = reason; items.push(item); };
      if (!receipt) { block('This entry has no confirmed Universe transfer.'); continue; }
      if (!currentEntity) { block('This QiMovi entry is missing. The writer entry is retained.'); continue; }
      check(currentEntity.data.entityId === entity.data.entityId, 'QIMOVI_WORLD_RETURN_IDENTITY_INVALID', 502);
      if (currentEntity.data.review === 'SET_ASIDE') { block('This QiMovi entry is set aside. Review it there before returning text.'); continue; }
      if (currentEntity.data.type !== entity.data.type) { block('QiMovi classification changed. Resolve the classification separately.'); continue; }
      const entityBase = baseFor(receipt), originalEntity = entityBase.mapping.get(entity.id);
      if (!originalEntity || originalEntity.sha256 !== receipt.data.record.sha256) { block('The receipt is not an exact mapped author entry.'); continue; }
      let baseSource = entityBase.source, value;
      if (field === 'name' || field === 'description') {
        item.remoteRecords = [ref(currentEntity)]; value = currentEntity.data[field === 'name' ? 'name' : 'summary'];
      } else {
        const prefix = `universe-claim:${entity.data.entityId}:${field.toLowerCase()}:`;
        // Mapper IDs are lowercased. All expected parts must have a consistent
        // receipt-linked base and exact ordinal identity. Unknown parts block
        // the entire field rather than being discarded or silently concatenated.
        const tracked = receipts.filter(r => r.data.record.id.startsWith(prefix)).sort((a, b) => a.data.record.id.localeCompare(b.data.record.id, undefined, { numeric: true }));
        const present = records.filter(r => r.id.startsWith(prefix));
        if (present.some(r => !receiptMap.has(r.id))) { block('Additional untracked QiMovi claim parts require a separate review.'); continue; }
        if (!tracked.length) {
          item.base = entityBase.source.development.data.world.elements.find(e => e.id.toLowerCase() === element.id.toLowerCase())?.[field] ?? '';
          if (item.base !== '') { block('This field has no confirmed claim transfer. Missing claims are not treated as a request to clear text.'); continue; }
          value = '';
        } else {
          const claimBase = baseFor(tracked[0]); baseSource = claimBase.source;
          const expected = [...claimBase.mapping.values()].filter(r => r.id.startsWith(prefix)).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
          if (tracked.length !== expected.length || tracked.some((r, i) => r.data.record.id !== expected[i].id || r.data.record.sha256 !== expected[i].sha256 || r.data.developmentSha256 !== tracked[0].data.developmentSha256)) { block('Claim parts do not share an intact confirmed transfer.'); continue; }
          const parts = tracked.map(r => remote.get(r.data.record.id));
          item.remoteRecords = parts.filter(Boolean).map(ref);
          if (parts.some(r => !r || r.kind !== 'universe-claim' || r.data.entityId !== entity.data.entityId || r.data.review === 'SET_ASIDE')) { block('A claim part is missing, set aside or points to another entry.'); continue; }
          // The writer mapper uses a literal wrapper for whitespace-only text.
          // Only decode the unchanged mapped wrapper; changed text is literal.
          value = parts.map((r, i) => {
            const body = r.data.body, mappedBody = expected[i].data.body;
            if (body === mappedBody && mappedBody.startsWith('Whitespace-only text: ')) return JSON.parse(mappedBody.slice('Whitespace-only text: '.length));
            return body;
          });
          if (value.some(v => typeof v !== 'string')) { block('A QiMovi claim has no valid text.'); continue; }
          value = value.join('');
        }
      }
      const original = baseSource.development.data.world.elements.find(e => e.id.toLowerCase() === element.id.toLowerCase());
      if (!original) { block('The original writer entry is unavailable.'); continue; }
      item.base ??= original[field];
      item.remote = value;
      if (!validText(value, field)) { block(`QiMovi text exceeds the writer ${field} limit or contains unsupported characters. The complete remote text is retained for review.`); continue; }
      const localChanged = item.local !== item.base, remoteChanged = value !== item.base;
      item.state = item.local === value ? localChanged ? 'converged' : 'unchanged' : localChanged ? remoteChanged ? 'both-changed' : 'local-only' : 'remote-only';
      item.selectable = ['remote-only', 'both-changed'].includes(item.state);
      items.push(item);
    }
  }
  const counts = { unchanged: 0, localOnly: 0, remoteOnly: 0, bothChanged: 0, converged: 0, unsupported: 0 };
  const countKey = { 'local-only': 'localOnly', 'remote-only': 'remoteOnly', 'both-changed': 'bothChanged' };
  items.forEach(item => counts[countKey[item.state] ?? item.state]++);
  const remoteRefs = receipts.map(r => ({ receipt: ref(r), record: remote.has(r.data.record.id) ? ref(remote.get(r.data.record.id)) : { id: r.data.record.id, missing: true } })).sort((a, b) => a.receipt.id.localeCompare(b.receipt.id));
  // Include untracked namespaced records too: adding a claim between preview and
  // apply must invalidate the preview, even though it cannot be imported.
  const namespace = mapping[0].data.entityId.replace(/:world$/, '');
  const extraRefs = records.filter(r => r.id.includes(`:${namespace}:`) && !receiptMap.has(r.id)).map(ref).sort((a, b) => a.id.localeCompare(b.id));
  const basis = { binding, connectionHash, project: { id: project.id, sourceHash: project.sourceHash }, draft: ref(source.draft), development: ref(source.development), remoteRefs, extraRefs };
  // Each referenced record was individually validated; the bounded 2,000-entry
  // identity list can exceed the generic canonical serializer's node ceiling.
  const token = sha256(JSON.stringify(basis));
  return { schemaVersion: 'caniscreenwrite-world-return-preview/v1', token, project: { id: project.id, title: project.title }, draft: ref(source.draft), development: ref(source.development), counts, items, notes, _basis: basis };
}

async function currentPlan(bridge, store, draftId) {
  await bridge.refreshInstalled(); await bridge.ensureConnected();
  check(bridge.capabilities.includes('universe-drafts/v1'), 'QIMOVI_BRIDGE_UPDATE_REQUIRED', 409, 'QiMovi needs the scoped Universe bridge update.');
  await bridge.bootstrap();
  const source = universeSource(store, draftId); recoveryClear(store, source);
  const plan = planWorldReturn(store, source, bridge.remote.project, bridge.remote.records, universeBinding(bridge.config()), connection(bridge));
  return { source, plan };
}

export async function previewWorldReturn(bridge, store, draftId) {
  const { plan } = await currentPlan(bridge, store, draftId);
  const { _basis, ...preview } = plan; return preview;
}

export async function pullWorldReturn(bridge, store, draftId, token, choices) {
  check(typeof token === 'string' && SHA.test(token), 'QIMOVI_WORLD_RETURN_PREVIEW_REQUIRED', 422);
  check(Array.isArray(choices) && choices.length <= WORLD_LIMITS.elements * FIELDS.length && choices.every(c => c && Object.keys(c).sort().join(',') === 'decision,id' && typeof c.id === 'string' && ['keep-local', 'use-qimovi'].includes(c.decision)) && new Set(choices.map(c => c.id)).size === choices.length, 'QIMOVI_WORLD_RETURN_CHOICES_INVALID', 422);
  check(!bridge.universeBusy, 'QIMOVI_UNIVERSE_BUSY', 409); bridge.universeBusy = true;
  try {
    const { source, plan } = await currentPlan(bridge, store, draftId);
    const choicesHash = sha256(canonicalJson([...choices].sort((a,b) => a.id.localeCompare(b.id))));
    const replay = bridge.worldReturnResults?.get(token);
    if (replay) {
      if (replay.choicesHash !== choicesHash || replay.afterToken !== plan.token) stale();
      return { ...replay.result, changed: false, replayed: true };
    }
    if (token !== plan.token) stale();
    const wanted = plan.items.filter(i => i.selectable), selected = new Map(choices.map(c => [c.id, c.decision]));
    check(choices.length === wanted.length && wanted.every(i => selected.has(i.id)), 'QIMOVI_WORLD_RETURN_CHOICES_REQUIRED', 422, 'Choose Keep writer or Use QiMovi for every changed field.');
    const data = JSON.parse(canonicalJson(source.development.data));
    let applied = 0, kept = 0;
    for (const item of wanted) {
      if (selected.get(item.id) === 'keep-local') { kept++; continue; }
      data.world.elements.find(e => e.id === item.elementId)[item.field] = item.remote; applied++;
    }
    validateDevelopment(data, source.project, { id: source.development.id, previous: source.development, store });
    // No await between this check and the single CAS append. Recovery and any
    // concurrent local save are rechecked inside the same SQLite transaction.
    const result = store.atomic(() => {
      const now = universeSource(store, draftId); recoveryClear(store, now);
      if (!same(ref(now.draft), plan.draft) || !same(ref(now.development), plan.development) || connection(bridge) !== plan._basis.connectionHash) stale();
      const changed = !same(data, now.development.data);
      const development = changed ? store.save(now.development.id, { kind: 'story-development', expectedVersion: now.development.version, requestId: `world-return:${sha256(canonicalJson([draftId, token, choicesHash]))}`, data }) : now.development;
      return { changed, development, applied, kept, replayed: false };
    });
    // Bounded in-process retry cache prevents an ambiguous HTTP retry from
    // adding revisions. After restart the current preview is a safe no-op for
    // accepted text. No old preview can override a subsequent local/remote edit.
    const after = planWorldReturn(store, universeSource(store, draftId), bridge.remote.project, bridge.remote.records, universeBinding(bridge.config()), connection(bridge));
    bridge.worldReturnResults ??= new Map();
    bridge.worldReturnResults.set(token, { choicesHash, afterToken: after.token, result });
    if (bridge.worldReturnResults.size > 64) bridge.worldReturnResults.delete(bridge.worldReturnResults.keys().next().value);
    return result;
  } finally { bridge.universeBusy = false; }
}
