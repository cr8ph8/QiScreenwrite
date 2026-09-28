import { canonicalJson } from './model';
import { appendWorldSnapshot, isSharedWorldRecord, publishWorldSnapshot, SHARED_WORLD_ID, type SharedWorldRecord } from './shared-world';
import { worldError, type WorldData, type WorldElement, type WorldLink } from './world';

export interface WorldIdentityMap { sourceId: string; localId: string }
export interface WorldSource {
  worldId: string; version: number; sha256: string;
  elements: WorldIdentityMap[]; links: WorldIdentityMap[];
}
export const WORLD_SOURCE_LIMITS = Object.freeze({ sources: 32, elements: 300, links: 1000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (value: string) => value.toLowerCase();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const shape = (value: unknown, keys: string[]): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length
  && keys.every(name => { const field = Object.getOwnPropertyDescriptor(value, name); return field?.enumerable && Object.prototype.hasOwnProperty.call(field, 'value'); });
const list = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).every(field => field?.enumerable && Object.prototype.hasOwnProperty.call(field, 'value'));

/** The service additionally checks each immutable library revision and its full source identity set. */
export function worldSourcesError(value: unknown, world: WorldData): string | null {
  const invalidWorld = worldError(world);
  if (invalidWorld) return invalidWorld;
  if (!list(value, WORLD_SOURCE_LIMITS.sources)) return 'A draft can link at most 32 shared worlds.';
  const worlds = new Set<string>(), locals = new Set<string>();
  let elements = 0, links = 0;
  for (const source of value) {
    if (!shape(source, ['worldId', 'version', 'sha256', 'elements', 'links']) || typeof source.worldId !== 'string' || !SHARED_WORLD_ID.test(source.worldId)
      || worlds.has(key(source.worldId)) || !Number.isSafeInteger(source.version) || Number(source.version) < 1 || Number(source.version) >= 2147483647
      || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) return 'Invalid or duplicate shared world source.';
    worlds.add(key(source.worldId));
    const ids = new Set<string>();
    for (const kind of ['elements', 'links'] as const) {
      if (!list(source[kind], WORLD_SOURCE_LIMITS[kind])) return 'Invalid shared world identity map.';
      for (const entry of source[kind]) {
        if (!shape(entry, ['sourceId', 'localId']) || typeof entry.sourceId !== 'string' || !UUID.test(entry.sourceId)
          || typeof entry.localId !== 'string' || !UUID.test(entry.localId) || ids.has(key(entry.sourceId)) || locals.has(key(entry.localId))) return 'Duplicate or invalid shared world identity.';
        ids.add(key(entry.sourceId)); locals.add(key(entry.localId));
        const other = kind === 'elements' ? world.links : world.elements;
        if (other.some(item => key(item.id) === key(entry.localId as string))) return 'A shared world identity points to the wrong kind of item.';
      }
    }
    elements += (source.elements as unknown[]).length; links += (source.links as unknown[]).length;
  }
  return elements <= WORLD_SOURCE_LIMITS.elements && links <= WORLD_SOURCE_LIMITS.links ? null : 'Linked worlds exceed the draft identity limit (300 elements and 1,000 connections).';
}

function checkSource(record: SharedWorldRecord, sources: WorldSource[]) {
  if (!isSharedWorldRecord(record, record.data.projectId)) throw new Error('The saved shared world is invalid. Refresh the library.');
  if (sources.some(item => key(item.worldId) === key(record.id))) throw new Error('This world is already linked. Review its updates instead of importing it again.');
}
function binding(record: SharedWorldRecord, elements: WorldIdentityMap[], links: WorldIdentityMap[]): WorldSource {
  return { worldId: record.id, version: record.version, sha256: record.sha256, elements, links };
}
function checked(world: WorldData, sources: WorldSource[]) {
  const error = worldError(world) || worldSourcesError(sources, world);
  if (error) throw new Error(`Nothing was changed. ${error}`);
  return { world, sources };
}

/** New local identities preserve each draft's writing and scene references. */
export function linkWorldSnapshot(world: WorldData, sources: WorldSource[], record: SharedWorldRecord) {
  checkSource(record, sources);
  const copied = appendWorldSnapshot(world, record.data.world);
  const originals = [...record.data.world.elements].sort((a, b) => a.order - b.order);
  const elements = copied.elements.slice(world.elements.length).map((item, i) => ({ sourceId: originals[i].id, localId: item.id }));
  const links = copied.links.slice(world.links.length).map((item, i) => ({ sourceId: record.data.world.links[i].id, localId: item.id }));
  return checked(copied, [...clone(sources), binding(record, elements, links)]);
}

/** Explicitly track an exact publication without duplicating its existing local items. */
export function trackPublishedWorld(world: WorldData, sources: WorldSource[], record: SharedWorldRecord) {
  checkSource(record, sources);
  if (!same(publishWorldSnapshot(world).world, record.data.world)) throw new Error('The draft no longer matches this publication. Publish its current world first, or import a linked copy.');
  return checked(clone(world), [...clone(sources), binding(record, record.data.world.elements.map(item => ({ sourceId: item.id, localId: item.id })), record.data.world.links.map(item => ({ sourceId: item.id, localId: item.id })))]);
}

/** Retain library identities when publishing edits from a linked draft copy. */
export function publishConnectedWorld(world: WorldData, sources: WorldSource[], record: SharedWorldRecord) {
  const snapshot = publishWorldSnapshot(world);
  const source = sources.find(item => item.worldId === record.id);
  if (!source) return snapshot;
  if (source.version !== record.version || source.sha256 !== record.sha256) throw new Error('Review the latest library update before publishing from this linked draft.');
  const elements = new Map(source.elements.map(item => [key(item.localId), item.sourceId]));
  const links = new Map(source.links.map(item => [key(item.localId), item.sourceId]));
  const remapped: WorldData = {
    schemaVersion: 1,
    elements: snapshot.world.elements.map(item => ({ ...item, id: elements.get(key(item.id)) ?? item.id })),
    links: snapshot.world.links.map(item => ({ ...item, id: links.get(key(item.id)) ?? item.id,
      elementId: elements.get(key(item.elementId)) ?? item.elementId, targetRef: elements.get(key(item.targetRef)) ?? item.targetRef })),
  };
  const error = worldError(remapped);
  if (error) throw new Error(`Nothing was published. ${error}`);
  return { world: remapped, excluded: snapshot.excluded };
}

export interface WorldMergeConflict {
  id: string; name: string; field: string; local: string; library: string;
}
export type WorldMergeChoices = Record<string, 'draft' | 'library'>;
export interface WorldUpdatePlan {
  world: WorldData; sources: WorldSource[]; conflicts: WorldMergeConflict[];
  counts: { added: number; updated: number; keptLocal: number; keptRemoved: number; locallyRemoved: number };
  notices: string[];
}
const elementFields = ['type', 'name', 'description', 'storyFunction', 'sensoryDetails', 'continuity', 'status'] as const;
const labels: Record<typeof elementFields[number], string> = { type: 'Type', name: 'Name', description: 'Description', storyFunction: 'Story function', sensoryDetails: 'On screen & in sound', continuity: 'Continuity', status: 'Story status' };
const linkFields = (link: WorldLink) => ({ elementId: key(link.elementId), targetType: link.targetType, targetRef: link.targetType === 'element' ? key(link.targetRef) : link.targetRef, targetLabel: link.targetLabel, notes: link.notes });

/** Three-way field review. Never deletes local items or rebinds by names/row position. */
export function reviewWorldUpdate(world: WorldData, sources: WorldSource[], base: SharedWorldRecord, latest: SharedWorldRecord, choices: WorldMergeChoices = {}): WorldUpdatePlan {
  const source = sources.find(item => item.worldId === base.id);
  if (!source || !isSharedWorldRecord(base, latest.data.projectId) || !isSharedWorldRecord(latest, base.data.projectId)
    || base.id !== latest.id || source.version !== base.version || source.sha256 !== base.sha256 || latest.version < base.version
    || latest.version === base.version && (latest.sha256 !== base.sha256 || !same(latest.data, base.data))) throw new Error('This shared world history does not match the draft connection. Refresh before reviewing.');
  const problem = worldError(world) || worldSourcesError(sources, world);
  if (problem) throw new Error(problem);
  for (const kind of ['elements', 'links'] as const) {
    const sourceIds = source[kind].map(item => key(item.sourceId)).sort();
    if (!same(sourceIds, base.data.world[kind].map(item => key(item.id)).sort())) throw new Error('The draft connection has incomplete source identities.');
  }
  const result = clone(world), nextSource = clone(source);
  const conflicts: WorldMergeConflict[] = [], notices: string[] = [];
  const counts = { added: 0, updated: 0, keptLocal: 0, keptRemoved: 0, locallyRemoved: 0 };
  const used = new Set([...world.elements, ...world.links, ...latest.data.world.elements, ...latest.data.world.links].map(item => key(item.id)));
  sources.forEach(item => [...item.elements, ...item.links].forEach(map => used.add(key(map.localId))));
  const fresh = () => {
    for (let n = 0; n < 100; n++) { const id = crypto.randomUUID(); if (!used.has(key(id))) { used.add(key(id)); return id; } }
    throw new Error('Could not allocate a distinct world identity.');
  };
  let order = Math.max(-1, ...world.elements.map(item => item.order));
  const map = new Map(nextSource.elements.map(item => [key(item.sourceId), item.localId]));
  const latestElementIds = new Set(latest.data.world.elements.map(item => key(item.id)));
  const latestLinkIds = new Set(latest.data.world.links.map(item => key(item.id)));
  for (const kind of ['elements', 'links'] as const) {
    const remaining = kind === 'elements' ? latestElementIds : latestLinkIds;
    for (const entry of source[kind]) if (!remaining.has(key(entry.sourceId)) && result[kind].some(item => key(item.id) === key(entry.localId))) counts.keptRemoved++;
    nextSource[kind] = nextSource[kind].filter(entry => remaining.has(key(entry.sourceId)));
  }
  for (const incoming of [...latest.data.world.elements].sort((a, b) => a.order - b.order)) {
    let localId = map.get(key(incoming.id));
    if (!localId) {
      localId = fresh(); map.set(key(incoming.id), localId); nextSource.elements.push({ sourceId: incoming.id, localId });
      result.elements.push({ ...incoming, id: localId, order: ++order }); counts.added++; continue;
    }
    const local = result.elements.find(item => key(item.id) === key(localId!));
    const previous = base.data.world.elements.find(item => key(item.id) === key(incoming.id));
    if (!previous) throw new Error('The base world is missing a mapped element.');
    if (!local) { counts.locallyRemoved++; continue; }
    let changed = false, kept = false;
    for (const field of elementFields) {
      if (local[field] === incoming[field]) continue;
      if (incoming[field] === previous[field]) { kept = true; continue; }
      if (local[field] === previous[field]) { (local as WorldElement)[field] = incoming[field] as never; changed = true; continue; }
      const id = `${key(local.id)}:${field}`;
      conflicts.push({ id, name: local.name || incoming.name || 'Untitled element', field: labels[field], local: local[field], library: incoming[field] });
      if (choices[id] === 'library') { (local as WorldElement)[field] = incoming[field] as never; changed = true; } else kept = true;
    }
    if (changed) counts.updated++; if (kept) counts.keptLocal++;
  }
  const localElementIds = new Set(result.elements.map(item => key(item.id)));
  const mappedLink = (link: WorldLink, id: string): WorldLink => ({ ...link, id, elementId: map.get(key(link.elementId))!, targetRef: map.get(key(link.targetRef))! });
  for (const incoming of latest.data.world.links) {
    let entry = nextSource.links.find(item => key(item.sourceId) === key(incoming.id));
    const isNew = !entry;
    if (!entry) { entry = { sourceId: incoming.id, localId: fresh() }; nextSource.links.push(entry); }
    const candidate = mappedLink(incoming, entry.localId);
    if (!candidate.elementId || !candidate.targetRef || !localElementIds.has(key(candidate.elementId)) || !localElementIds.has(key(candidate.targetRef))) {
      notices.push(`Connection “${incoming.targetLabel || 'Untitled'}” stays unapplied because a linked element was removed from this draft.`); continue;
    }
    if (isNew) { result.links.push(candidate); counts.added++; continue; }
    const index = result.links.findIndex(item => key(item.id) === key(entry!.localId));
    if (index < 0) { counts.locallyRemoved++; continue; }
    const previous = base.data.world.links.find(item => key(item.id) === key(incoming.id));
    if (!previous) throw new Error('The base world is missing a mapped connection.');
    const old = mappedLink(previous, entry.localId), local = result.links[index];
    const target = (link: WorldLink) => { const { notes: _notes, ...value } = linkFields(link); return value; };
    const groups = [
      { field: 'target', label: 'Connection target', value: target, apply: () => { local.elementId = candidate.elementId; local.targetType = candidate.targetType; local.targetRef = candidate.targetRef; local.targetLabel = candidate.targetLabel; } },
      { field: 'notes', label: 'Connection notes', value: (link: WorldLink) => link.notes, apply: () => { local.notes = candidate.notes; } },
    ];
    let changed = false, kept = false;
    for (const group of groups) {
      const localValue = group.value(local), incomingValue = group.value(candidate), baseValue = group.value(old);
      if (same(localValue, incomingValue)) continue;
      if (same(incomingValue, baseValue)) { kept = true; continue; }
      if (same(localValue, baseValue)) { group.apply(); changed = true; continue; }
      const id = `${key(local.id)}:connection:${group.field}`;
      const display = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      conflicts.push({ id, name: local.targetLabel || 'Connection', field: group.label, local: display(localValue), library: display(incomingValue) });
      if (choices[id] === 'library') { group.apply(); changed = true; } else kept = true;
    }
    if (changed) counts.updated++; if (kept) counts.keptLocal++;
  }
  nextSource.version = latest.version; nextSource.sha256 = latest.sha256;
  const nextSources = sources.map(item => item === source ? nextSource : clone(item));
  checked(result, nextSources);
  if (counts.keptRemoved) notices.push(`${counts.keptRemoved} item(s) removed from the library remain as independent draft items, with their connections intact.`);
  if (counts.locallyRemoved) notices.push(`${counts.locallyRemoved} item(s) removed in this draft stay removed.`);
  return { world: result, sources: nextSources, conflicts, counts, notices };
}
