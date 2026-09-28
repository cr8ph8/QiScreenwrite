import { RECORD_ID } from './model';
import { createWorld, worldError, type WorldData } from './world';
import type { RecordInput, WorkspaceRecord } from './types';

export const SHARED_WORLD_KIND = 'shared-world';
export const SHARED_WORLD_LIMITS = Object.freeze({ name: 160, description: 24000 });
export const SHARED_WORLD_ID = /^shared-world:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface SharedWorldData { schemaVersion: 1; projectId: string; name: string; description: string; world: WorldData }
export type SharedWorldRecord = WorkspaceRecord<SharedWorldData>;
export type SharedWorldSave = RecordInput<SharedWorldData>;
const shape = (value: unknown, keys: string[]): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable && Object.prototype.hasOwnProperty.call(property, 'value');
  });
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value);
export const cloneSharedWorld = (data: SharedWorldData): SharedWorldData => JSON.parse(JSON.stringify(data));
export const newSharedWorldId = () => `${SHARED_WORLD_KIND}:${crypto.randomUUID()}`;
export const createSharedWorld = (projectId: string): SharedWorldData => ({ schemaVersion: 1, projectId, name: '', description: '', world: createWorld() });

/** Strict canonical library data; draft authoring remains in DevelopmentData. */
export function sharedWorldError(value: unknown, projectId?: string): string | null {
  if (!shape(value, ['schemaVersion', 'projectId', 'name', 'description', 'world'])) return 'Shared world has unsupported or missing fields.';
  if (value.schemaVersion !== 1) return 'Shared world has an unsupported version.';
  if (typeof value.projectId !== 'string' || !RECORD_ID.test(value.projectId) || (projectId !== undefined && value.projectId !== projectId)) return 'Shared world belongs to another workspace.';
  if (!text(value.name, SHARED_WORLD_LIMITS.name) || /[\r\n]/.test(value.name) || !value.name.trim()) return 'Give this shared world a name of at most 160 characters.';
  if (!text(value.description, SHARED_WORLD_LIMITS.description)) return 'Shared world overview exceeds 24,000 characters or contains invalid text.';
  const error = worldError(value.world);
  if (error) return error;
  if ((value.world as WorldData).links.some(link => link.targetType !== 'element')) return 'Shared worlds can only link their own elements. Scene and screenplay character connections stay in their source draft.';
  return null;
}

export function isSharedWorldRecord(value: WorkspaceRecord | undefined | null, projectId: string): value is SharedWorldRecord {
  return !!value && value.kind === SHARED_WORLD_KIND && SHARED_WORLD_ID.test(value.id)
    && Number.isSafeInteger(value.version) && value.version >= 1 && /^[a-f0-9]{64}$/.test(value.sha256)
    && sharedWorldError(value.data, projectId) === null;
}
export function sharedWorldSave(id: string, data: SharedWorldData, expectedVersion: number | null): SharedWorldSave {
  const error = sharedWorldError(data);
  if (error) throw new Error(error);
  if (!SHARED_WORLD_ID.test(id) || (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))) throw new Error('Invalid shared world save identity.');
  return { id, kind: SHARED_WORLD_KIND, expectedVersion, requestId: crypto.randomUUID(), data: cloneSharedWorld(data) };
}

/** Copy only portable links. Excluded link notes remain untouched in the source draft. */
export function publishWorldSnapshot(world: WorldData): { world: WorldData; excluded: number } {
  const error = worldError(world);
  if (error) throw new Error(error);
  const snapshot = JSON.parse(JSON.stringify(world)) as WorldData;
  snapshot.links = snapshot.links.filter(link => link.targetType === 'element');
  return { world: snapshot, excluded: world.links.length - snapshot.links.length };
}

/** Append a snapshot, always remapping every copied identity; existing data is never rebound. */
export function appendWorldSnapshot(target: WorldData, source: WorldData, uuid: () => string = () => crypto.randomUUID()): WorldData {
  const error = worldError(target) || worldError(source);
  if (error) throw new Error(error);
  if (source.links.some(link => link.targetType !== 'element')) throw new Error('Copy only library elements and their internal connections.');
  const used = new Set([...target.elements, ...target.links, ...source.elements, ...source.links].map(item => item.id.toLowerCase()));
  const fresh = () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = uuid();
      if (UUID.test(id) && !used.has(id.toLowerCase())) { used.add(id.toLowerCase()); return id; }
    }
    throw new Error('Could not create distinct copy identities. No world was changed.');
  };
  const mapping = new Map<string, string>();
  const firstOrder = Math.max(-1, ...target.elements.map(item => item.order)) + 1;
  const elements = [...source.elements].sort((a, b) => a.order - b.order).map((item, index) => {
    const id = fresh(); mapping.set(item.id.toLowerCase(), id);
    return { ...item, id, order: firstOrder + index };
  });
  const links = source.links.map(link => ({ ...link, id: fresh(), elementId: mapping.get(link.elementId.toLowerCase())!, targetRef: mapping.get(link.targetRef.toLowerCase())! }));
  const result: WorldData = { schemaVersion: 1, elements: [...target.elements.map(item => ({ ...item })), ...elements], links: [...target.links.map(item => ({ ...item })), ...links] };
  const problem = worldError(result);
  if (problem) throw new Error(`Nothing was copied. ${problem}`);
  return result;
}

export function appendSharedWorldNotes(existing: string, shared: SharedWorldData, version: number): string {
  if (!shared.description) return existing;
  const result = [existing, `From shared world: ${shared.name} (v${version})\n\n${shared.description}`].filter(Boolean).join('\n\n');
  if (result.length > 24000) throw new Error('Nothing was copied. The combined world overview exceeds 24,000 characters. Shorten it before adding this snapshot.');
  return result;
}
