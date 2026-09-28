// Maps authored writer worlds to QiMovi's existing universe draft contracts.
// Never derives identities from names or grants source/canon authority.
import { canonicalJson, check, ID, SHA, sha256 } from './storage.mjs';
import { validateDevelopment } from './development.mjs';
import { validateScreenplayDraft } from './contracts.mjs';

const kinds = ['universe-entity', 'universe-claim', 'universe-link'];
const types = { character: 'character', location: 'location', world_rule: 'world_rule', faction: 'group', thematic_note: 'thematic_note', timeline_note: 'reference', prop: 'reference', relationship: 'reference' };
const ref = record => ({ id: record.id, version: record.version, sha256: record.sha256 });
// A native restore of the exact last transferred value is safe to review again.
// The preview and subsequent CAS still bind its current remote version.
const same = (a, b) => a?.sha256 === b?.sha256;
export const universeBinding = config => sha256(canonicalJson(config.binding ? { workspacePath: config.binding.workspacePath, projectId: config.binding.project.id } : { origin: config.origin }));
const receiptId = (binding, draftId, recordId) => `universe-sync:${sha256(canonicalJson([binding, draftId, recordId]))}`;

export function universeSource(store, draftId) {
  check(typeof draftId === 'string' && /^screenplay-draft:[0-9a-f-]{36}$/i.test(draftId), 'INVALID_RECORD_ID', 422);
  const project = store.project(), draft = store.current(draftId), development = store.current(`story-development:${draftId.split(':')[1]}`);
  check(draft?.kind === 'screenplay-draft', 'DRAFT_NOT_FOUND', 404);
  check(development?.kind === 'story-development' && [2, 3].includes(development.data.schemaVersion), 'QIMOVI_WORLD_SAVE_REQUIRED', 409);
  validateScreenplayDraft(draft.data, project); validateDevelopment(development.data, project, { id: development.id, store });
  for (const record of [draft, development]) check(record.sha256 === sha256(canonicalJson(record.data)), 'QIMOVI_LOCAL_REVISION_INVALID', 409);
  return { project, draft, development };
}

export function mapUniverse(source, project) {
  const { draft, development } = source, world = development.data.world;
  check(project.profile === 'caniscreenwrite-creative/v1' ? project.sourceHash === null : SHA.test(project.sourceHash ?? ''), 'QIMOVI_PROJECT_SOURCE_UNKNOWN', 422);
  const base = { schemaVersion: 1, sourceHash: project.sourceHash, ...(project.sourceHash === null ? { projectId: project.id } : {}), citations: [], status: 'DRAFT', review: 'PROPOSED' };
  const namespace = `csw:${sha256(canonicalJson([source.project.id, draft.id])).slice(0, 32)}`;
  const entityId = id => `${namespace}:${id.toLowerCase()}`;
  const entries = [];
  const add = (kind, id, data, label) => {
    // QiMovi rejects control characters. Refuse the transfer before mutation;
    // never normalize or truncate the author's text to make it fit.
    for (const value of Object.values(data)) if (typeof value === 'string') check(value.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'QIMOVI_WORLD_TEXT_INVALID', 422, `Remove unsupported control characters from ${label} before transfer.`);
    entries.push({ id: `${kind}:${id.toLowerCase()}`, kind, data, label });
  };
  const claim = (id, target, title, text, review = 'PROPOSED') => {
    if (!text.length) return;
    // World overview may be 24k. Split without cutting a surrogate pair.
    const parts = []; let rest = text;
    while (rest.length) { let end = Math.min(7800, rest.length); if (!rest.slice(0, end).trim()) end = Math.min(3500, end); if (end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1])) end--; parts.push(rest.slice(0, end)); rest = rest.slice(end); }
    parts.forEach((body, index) => add('universe-claim', `${namespace}:${id}:${index}`, { ...base, review, entityId: target, title: parts.length > 1 ? `${title} (${index + 1}/${parts.length})` : title, body: body.trim() ? body : `Whitespace-only text: ${JSON.stringify(body)}` }, title));
  };
  const root = entityId('world');
  add('universe-entity', root, { ...base, entityId: root, type: 'story', name: draft.data.title, summary: 'World developed in QiCanIScreenwrite. Authored intentions for this draft.', imageHash: null, sceneIds: [] }, draft.data.title);
  claim('overview', root, 'World overview', development.data.worldNotes);
  for (const element of world.elements) {
    const id = entityId(element.id), review = element.status === 'needs_review' ? 'QUESTIONED' : 'PROPOSED';
    add('universe-entity', id, { ...base, review, entityId: id, type: types[element.type], name: element.name, summary: element.description, imageHash: null, sceneIds: [] }, element.name);
    claim(`${element.id}:classification`, id, 'Writer classification', `Writer type: ${element.type}\nAuthor label: ${element.status}\nWriter order: ${element.order}\nLocal entry: ${element.id}\nLocal draft: ${draft.id}\nThese are author intentions; the label does not grant canon or production approval.`, review);
    for (const [field, title] of [['storyFunction', 'Story function'], ['sensoryDetails', 'Sensory details'], ['continuity', 'Continuity notes']]) claim(`${element.id}:${field}`, id, `${element.name} · ${title}`, element[field], review);
    add('universe-link', `${namespace}:member:${element.id}`, { ...base, fromEntityId: id, toEntityId: root, relation: 'related_to', label: 'Developed in this writer world' }, `${element.name} · world membership`);
  }
  for (const link of world.links) {
    const from = entityId(link.elementId);
    if (link.targetType === 'element') add('universe-link', `${namespace}:link:${link.id}`, { ...base, fromEntityId: from, toEntityId: entityId(link.targetRef), relation: 'related_to', label: 'Writer world connection' }, 'World connection');
    // Draft heading/cue links are kept as notes. They are not retained-source
    // scene identities, even when the labels happen to be identical.
    claim(`link:${link.id}`, from, 'Writer connection notes', `Target kind: ${link.targetType}\nTarget reference: ${link.targetRef}\nRecorded label: ${link.targetLabel}\nNotes:\n${link.notes}`);
  }
  check(entries.length <= 2000, 'QIMOVI_UNIVERSE_CAPACITY', 409, 'This world exceeds QiMovi’s 2,000 universe record limit. Use the complete reference export or transfer a smaller world.');
  return entries.map(item => ({ ...item, sha256: sha256(canonicalJson(item.data)) }));
}

export function planUniverse(store, source, project, remoteRecords, binding) {
  const desired = mapUniverse(source, project), current = new Map(remoteRecords.map(record => [record.id, record]));
  const receipts = store.list('universe-sync').filter(record => record.data.draftId === source.draft.id && record.data.binding === binding && record.data.targetProjectId === project.id && record.data.targetSourceHash === project.sourceHash);
  const previous = new Map(receipts.map(record => [record.data.record.id, record]));
  const ids = new Set(desired.map(item => item.id));
  // Removed entries are explicitly set aside, never deleted. A native edit to
  // one is a conflict just like a native edit to a still-present entry.
  for (const receipt of receipts) {
    const remote = current.get(receipt.data.record.id);
    if (!ids.has(receipt.data.record.id) && remote) {
      const data = { ...remote.data, review: 'SET_ASIDE' };
      desired.push({ id: remote.id, kind: remote.kind, data, sha256: sha256(canonicalJson(data)), label: `Set aside: ${remote.data.name ?? remote.data.title ?? remote.data.label ?? remote.id}`, retired: true });
    }
  }
  const items = desired.map(item => {
    const remote = current.get(item.id), receipt = previous.get(item.id);
    if (remote) check(kinds.includes(remote.kind) && remote.kind === item.kind && Number.isSafeInteger(remote.version) && remote.version > 0 && remote.sha256 === sha256(canonicalJson(remote.data)), 'QIMOVI_REMOTE_REVISION_INVALID', 502);
    const matches = remote?.sha256 === item.sha256;
    const tracked = receipt?.data.record;
    const conflict = (remote && !matches && !same(remote, tracked)) || (!remote && tracked);
    return { ...item, current: remote ? ref(remote) : null, receipt: receipt ? ref(receipt) : null, action: conflict ? 'conflict' : matches ? 'unchanged' : remote ? 'update' : 'create', ...(conflict ? { reason: 'QiMovi changed independently. Review that entry in QiMovi before transferring.' } : item.retired ? { reason: 'Removed from this writer world; retained in QiMovi as Set aside.' } : {}) };
  });
  const counts = { create: 0, update: 0, unchanged: 0, conflicts: 0 };
  for (const item of items) counts[item.action === 'conflict' ? 'conflicts' : item.action]++;
  const universeRecords = remoteRecords.filter(record => record.kind.startsWith('universe-'));
  check(universeRecords.length + counts.create <= 2000 && universeRecords.filter(record => record.kind === 'universe-entity').length + items.filter(item => item.kind === 'universe-entity' && item.action === 'create').length <= 1000, 'QIMOVI_UNIVERSE_CAPACITY', 409, 'QiMovi has insufficient universe capacity for this transfer. The complete reference export is still available.');
  const token = sha256(JSON.stringify({ binding, project: { id: project.id, sourceHash: project.sourceHash }, draft: ref(source.draft), development: ref(source.development), items: items.map(item => [item.id, item.sha256, item.current, item.receipt, item.action]) }));
  return { token, project: { id: project.id, title: project.title }, developmentVersion: source.development.version, counts, items, notes: ['Entries and connections become QiMovi Universe drafts. Story function, sensory details and continuity are retained as attributed notes.', 'Faction becomes Group. Props, timeline notes and relationship entries become References, with their original writer type recorded.', 'Scene and character-cue connections remain notes until mapped to QiMovi source identities.', 'Previously transferred entries removed here are set aside in QiMovi after review. Native QiMovi edits block replacement.'] };
}

export const publicUniversePlan = plan => ({ ...plan, items: plan.items.map(({ id, kind, label, action, reason }) => ({ id, kind, label, action, ...(reason ? { reason } : {}) })) });
export function saveUniverseReceipt(store, source, project, binding, record) {
  const id = receiptId(binding, source.draft.id, record.id), current = store.current(id);
  const data = { schemaVersion: 1, projectId: source.project.id, draftId: source.draft.id, draftVersion: source.draft.version, draftSha256: source.draft.sha256, developmentVersion: source.development.version, developmentSha256: source.development.sha256, binding, targetProjectId: project.id, targetSourceHash: project.sourceHash, record: { ...ref(record), kind: record.kind } };
  if (current && canonicalJson(current.data) === canonicalJson(data)) return current;
  return store.save(id, { kind: 'universe-sync', expectedVersion: current?.version ?? null, requestId: `universe-receipt:${sha256(canonicalJson([id, data, current?.version ?? null]))}`, data });
}
export function validateUniverseReceipt(data, project, context = {}) {
  const keys = ['schemaVersion', 'projectId', 'draftId', 'draftVersion', 'draftSha256', 'developmentVersion', 'developmentSha256', 'binding', 'targetProjectId', 'targetSourceHash', 'record'];
  check(data && Object.keys(data).sort().join(',') === keys.sort().join(',') && data.schemaVersion === 1 && data.projectId === project?.id, 'UNIVERSE_SYNC_INVALID', 422);
  check(/^screenplay-draft:[0-9a-f-]{36}$/i.test(data.draftId) && [data.draftVersion, data.developmentVersion].every(n => Number.isSafeInteger(n) && n > 0) && [data.draftSha256, data.developmentSha256, data.binding].every(h => typeof h === 'string' && SHA.test(h)) && typeof data.targetProjectId === 'string' && ID.test(data.targetProjectId) && (data.targetSourceHash === null || typeof data.targetSourceHash === 'string' && SHA.test(data.targetSourceHash)), 'UNIVERSE_SYNC_INVALID', 422);
  const record = data.record;
  check(record && Object.keys(record).sort().join(',') === 'id,kind,sha256,version' && kinds.includes(record.kind) && typeof record.id === 'string' && record.id.startsWith(`${record.kind}:csw:`) && ID.test(record.id) && SHA.test(record.sha256) && Number.isSafeInteger(record.version) && record.version > 0, 'UNIVERSE_SYNC_INVALID', 422);
  check(!context.id || context.id === receiptId(data.binding, data.draftId, record.id), 'RECORD_IDENTITY_MISMATCH', 422);
  if (context.store) {
    check(context.store.history(data.draftId).some(r => r.version === data.draftVersion && r.sha256 === data.draftSha256) && context.store.history(`story-development:${data.draftId.split(':')[1]}`).some(r => r.version === data.developmentVersion && r.sha256 === data.developmentSha256), 'UNIVERSE_SYNC_REVISION_UNKNOWN', 422);
  }
  return data;
}
