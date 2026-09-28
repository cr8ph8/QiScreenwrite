// Linked shared-world lineage. IDs preserve their supplied spelling; comparisons
// within mappings are case-insensitive. No text, identity or hash is rewritten.
import { check, SHA, hashCanonical } from './storage.mjs';
import { validateWorld } from './world.mjs';
import { validateSharedWorld } from './shared-world.mjs';

export const WORLD_SOURCE_LIMITS = Object.freeze({ sources: 32, elements: 300, links: 1000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const worldId = /^shared-world:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const need = (condition, code) => check(condition, code, 422);
const shape = (value, keys) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable && Object.hasOwn(property, 'value');
  });
const list = (value, max) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
    .every(property => property?.enumerable && Object.hasOwn(property, 'value'));
const identity = value => typeof value === 'string' && UUID.test(value);

/** Standalone frontend-parity contract. context: { projectId, store }.
 * With a store, require the exact saved base revision and its complete source
 * ID sets. Local IDs may be absent (removed locally), but never change kind.
 * Equal source/local IDs support explicitly tracking a published source draft.
 */
export function validateWorldSources(sources, world, context = {}) {
  need(list(sources, WORLD_SOURCE_LIMITS.sources), 'WORLD_SOURCE_LIST_INVALID');
  validateWorld(world);
  const localKinds = new Map();
  for (const kind of ['elements', 'links']) {
    for (const item of world[kind]) localKinds.set(item.id.toLowerCase(), kind);
  }
  const worlds = new Set(), localIds = new Set();
  const counts = { elements: 0, links: 0 };
  for (const source of sources) {
    need(shape(source, ['worldId', 'version', 'sha256', 'elements', 'links']), 'WORLD_SOURCE_FIELDS_INVALID');
    need(typeof source.worldId === 'string' && source.worldId.startsWith('shared-world:') && worldId.test(source.worldId), 'WORLD_SOURCE_ID_INVALID');
    need(!worlds.has(source.worldId.toLowerCase()), 'WORLD_SOURCE_DUPLICATE');
    worlds.add(source.worldId.toLowerCase());
    need(Number.isSafeInteger(source.version) && source.version > 0 && source.version < 2147483647, 'WORLD_SOURCE_VERSION_INVALID');
    need(typeof source.sha256 === 'string' && SHA.test(source.sha256), 'WORLD_SOURCE_HASH_INVALID');
    const sourceIds = new Set();
    for (const kind of ['elements', 'links']) {
      need(list(source[kind], WORLD_SOURCE_LIMITS[kind]), 'WORLD_SOURCE_MAPPINGS_INVALID');
      counts[kind] += source[kind].length;
      need(counts[kind] <= WORLD_SOURCE_LIMITS[kind], kind === 'elements' ? 'WORLD_SOURCE_ELEMENT_LIMIT' : 'WORLD_SOURCE_LINK_LIMIT');
      for (const mapping of source[kind]) {
        need(shape(mapping, ['sourceId', 'localId']), 'WORLD_SOURCE_MAPPING_FIELDS_INVALID');
        need(identity(mapping.sourceId) && identity(mapping.localId), 'WORLD_SOURCE_MAPPING_ID_INVALID');
        const sourceId = mapping.sourceId.toLowerCase(), localId = mapping.localId.toLowerCase();
        need(!sourceIds.has(sourceId), 'WORLD_SOURCE_SOURCE_ID_DUPLICATE');
        need(!localIds.has(localId), 'WORLD_SOURCE_LOCAL_ID_DUPLICATE');
        sourceIds.add(sourceId); localIds.add(localId);
        need(!localKinds.has(localId) || localKinds.get(localId) === kind, 'WORLD_SOURCE_LOCAL_KIND_MISMATCH');
      }
    }
    if (context.store) {
      // Never substitute current(): links continue to refer to immutable bases.
      const revision = context.store.history(source.worldId).find(record => record.version === source.version);
      need(revision, 'WORLD_SOURCE_REVISION_UNKNOWN');
      need(revision.id === source.worldId && revision.kind === 'shared-world', 'WORLD_SOURCE_REVISION_MISMATCH');
      need(typeof context.projectId === 'string' && revision.data?.projectId === context.projectId, 'WORLD_SOURCE_PROJECT_MISMATCH');
      need(revision.sha256 === source.sha256 && hashCanonical(revision.data) === source.sha256, 'WORLD_SOURCE_HASH_MISMATCH');
      validateSharedWorld(revision.kind, revision.data, { id: context.projectId }, revision.id);
      for (const kind of ['elements', 'links']) {
        const expected = new Set(revision.data.world[kind].map(item => item.id.toLowerCase()));
        need(source[kind].length === expected.size && source[kind].every(mapping => expected.has(mapping.sourceId.toLowerCase())),
          kind === 'elements' ? 'WORLD_SOURCE_ELEMENTS_MISMATCH' : 'WORLD_SOURCE_LINKS_MISMATCH');
      }
    }
  }
  return sources;
}
