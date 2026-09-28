// Workspace-wide creative references. These records do not grant production authority.
import { ID, check } from './storage.mjs';
import { validateWorld } from './world.mjs';

export const SHARED_WORLD_KIND = 'shared-world';
export const SHARED_WORLD_LIMITS = Object.freeze({ name: 160, description: 24000 });
const sharedId = /^shared-world:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shape = (value, keys) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable && Object.hasOwn(property, 'value');
  });
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value);

/** Dispatch from validateRecord with context.id. Never changes supplied text. */
export function validateSharedWorld(kind, data, project, id) {
  const need = (condition, code) => check(condition, code, 422);
  need(kind === SHARED_WORLD_KIND, 'SHARED_WORLD_KIND_INVALID');
  need(typeof id === 'string' && id.startsWith('shared-world:') && sharedId.test(id), 'SHARED_WORLD_ID_INVALID');
  need(shape(data, ['schemaVersion', 'projectId', 'name', 'description', 'world']), 'SHARED_WORLD_FIELDS_INVALID');
  need(data.schemaVersion === 1, 'SHARED_WORLD_SCHEMA_INVALID');
  need(typeof data.projectId === 'string' && ID.test(data.projectId) && (!project || data.projectId === project.id), 'SHARED_WORLD_PROJECT_MISMATCH');
  need(text(data.name, SHARED_WORLD_LIMITS.name) && data.name.trim().length > 0 && !/[\r\n]/.test(data.name), 'SHARED_WORLD_NAME_INVALID');
  need(text(data.description, SHARED_WORLD_LIMITS.description), 'SHARED_WORLD_DESCRIPTION_INVALID');
  validateWorld(data.world);
  need(data.world.links.every(link => link.targetType === 'element'), 'SHARED_WORLD_SOURCE_LINK_FORBIDDEN');
  return data;
}
