// Local, speculative story development. Dispatch this validator from
// contracts.mjs; WorkspaceStore supplies immutable history, CAS and replay.
import { ID, check } from './storage.mjs';
import { validateWorld, worldTextLength } from './world.mjs';
import { validateWorldSources } from './world-sources.mjs';

export const DEVELOPMENT_KIND = 'story-development';
// Mirrored in src/local/development.ts; the contract tests check parity.
export const DEVELOPMENT_LIMITS = Object.freeze({
  concept: 4000, logline: 1000, synopsis: 16000, outline: 32000, worldNotes: 24000,
  beats: 200, characters: 100, researchNotes: 100,
  title: 200, description: 4000, name: 120, role: 200, characterNotes: 6000,
  arc: 4000, notes: 6000, source: 2000, totalText: 200000, totalTextV2: 400000,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_ID = /^screenplay-draft:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const need = (condition, code) => check(condition, code, 422);
const shape = (value, keys) => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable && Object.hasOwn(property, 'value');
  });

/** context: { id, previous, store }, exactly as supplied by WorkspaceStore.save. */
export function validateDevelopment(data, project, context = {}) {
  const schema = data && typeof data === 'object' ? Object.getOwnPropertyDescriptor(data, 'schemaVersion')?.value : undefined;
  const keys = ['schemaVersion', 'projectId', 'draftId', 'concept', 'logline', 'synopsis', 'outline', 'beats', 'characters', 'worldNotes', 'researchNotes'];
  if (schema === 2 || schema === 3) keys.push('world');
  if (schema === 3) keys.push('worldSources');
  need(shape(data, keys), 'STORY_DEVELOPMENT_FIELDS_INVALID');
  need(schema === 1 || schema === 2 || schema === 3, 'STORY_DEVELOPMENT_SCHEMA_INVALID');
  need(typeof data.projectId === 'string' && ID.test(data.projectId), 'STORY_DEVELOPMENT_PROJECT_INVALID');
  if (project) need(data.projectId === project.id, 'STORY_DEVELOPMENT_PROJECT_MISMATCH');
  const match = typeof data.draftId === 'string' && DRAFT_ID.exec(data.draftId);
  need(match && data.draftId.startsWith('screenplay-draft:'), 'STORY_DEVELOPMENT_DRAFT_INVALID');
  const id = `${DEVELOPMENT_KIND}:${match[1]}`;
  if (context.id !== undefined) need(context.id === id, 'RECORD_IDENTITY_MISMATCH');
  if (context.previous) {
    need(context.previous.kind === DEVELOPMENT_KIND && context.previous.id === id &&
      context.previous.data.projectId === data.projectId && context.previous.data.draftId === data.draftId,
    'STORY_DEVELOPMENT_IDENTITY_IMMUTABLE');
  }
  if (context.store) {
    const draft = context.store.current(data.draftId);
    need(draft && draft.id === data.draftId && draft.kind === 'screenplay-draft', 'STORY_DEVELOPMENT_DRAFT_UNKNOWN');
    need(draft.data.projectId === data.projectId, 'STORY_DEVELOPMENT_DRAFT_PROJECT_MISMATCH');
  }

  let total = 0;
  const text = (value, limit) => {
    need(typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && value.length <= limit, 'STORY_DEVELOPMENT_TEXT_INVALID');
    total += value.length;
  };
  for (const key of ['concept', 'logline', 'synopsis', 'outline', 'worldNotes']) text(data[key], DEVELOPMENT_LIMITS[key]);
  const rows = (key, fields) => {
    const values = data[key];
    need(Array.isArray(values) && Object.getPrototypeOf(values) === Array.prototype && values.length <= DEVELOPMENT_LIMITS[key] && Reflect.ownKeys(values).length === values.length + 1 && Array.from({ length: values.length }, (_, index) => Object.getOwnPropertyDescriptor(values, String(index))).every(property => property?.enumerable && Object.hasOwn(property, 'value')), 'STORY_DEVELOPMENT_LIST_INVALID');
    const ids = new Set();
    for (const value of values) {
      need(shape(value, ['id', ...Object.keys(fields)]), 'STORY_DEVELOPMENT_ITEM_INVALID');
      need(typeof value.id === 'string' && UUID.test(value.id) && !ids.has(value.id.toLowerCase()), 'STORY_DEVELOPMENT_ITEM_ID_INVALID');
      ids.add(value.id.toLowerCase());
      for (const [field, limit] of Object.entries(fields)) text(value[field], limit);
    }
  };
  rows('beats', { title: DEVELOPMENT_LIMITS.title, description: DEVELOPMENT_LIMITS.description });
  rows('characters', { name: DEVELOPMENT_LIMITS.name, role: DEVELOPMENT_LIMITS.role, description: DEVELOPMENT_LIMITS.characterNotes, arc: DEVELOPMENT_LIMITS.arc });
  rows('researchNotes', { title: DEVELOPMENT_LIMITS.title, notes: DEVELOPMENT_LIMITS.notes, source: DEVELOPMENT_LIMITS.source });
  if (schema === 2 || schema === 3) {
    validateWorld(data.world);
    total += worldTextLength(data.world);
  }
  if (schema === 3) validateWorldSources(data.worldSources, data.world, { projectId: data.projectId, store: context.store });
  need(total <= (schema === 1 ? DEVELOPMENT_LIMITS.totalText : DEVELOPMENT_LIMITS.totalTextV2), 'STORY_DEVELOPMENT_TEXT_LIMIT');
  return data;
}
