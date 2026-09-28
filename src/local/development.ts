// Pure local development helpers. No remote services or generated story text.
import { canonicalJson, RECORD_ID } from './model';
import type { RecordInput, WorkspaceRecord } from './types';
import { worldSourcesError, type WorldSource } from './world-sources';
import { worldError, worldMarkdown, worldTextLength, type WorldData } from './world';

export const DEVELOPMENT_KIND = 'story-development';
export const DEVELOPMENT_LIMITS = Object.freeze({
  concept: 4000, logline: 1000, synopsis: 16000, outline: 32000, worldNotes: 24000,
  beats: 200, characters: 100, researchNotes: 100,
  title: 200, description: 4000, name: 120, role: 200, characterNotes: 6000,
  arc: 4000, notes: 6000, source: 2000, totalText: 200000, totalTextV2: 400000,
});

export interface DevelopmentBeat { id: string; title: string; description: string }
export interface DevelopmentCharacter { id: string; name: string; role: string; description: string; arc: string }
export interface DevelopmentResearchNote { id: string; title: string; notes: string; source: string }
interface DevelopmentFields {
  projectId: string;
  draftId: string;
  concept: string;
  logline: string;
  synopsis: string;
  outline: string;
  beats: DevelopmentBeat[];
  characters: DevelopmentCharacter[];
  worldNotes: string;
  researchNotes: DevelopmentResearchNote[];
}
// New worlds are an explicit v2 edit. Existing v1 snapshots retain their exact shape.
export type DevelopmentData = DevelopmentFields & (
  { schemaVersion: 1; world?: never; worldSources?: never } | { schemaVersion: 2; world: WorldData; worldSources?: never } | { schemaVersion: 3; world: WorldData; worldSources: WorldSource[] }
);
export type DevelopmentRecord = WorkspaceRecord<DevelopmentData>;
export type DevelopmentSave = RecordInput<DevelopmentData>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const shape = (value: unknown, keys: string[]): value is Record<string, unknown> => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property?.enumerable && Object.prototype.hasOwnProperty.call(property, 'value');
});
const version = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) < 2147483647;

export function developmentId(draftId: string): string {
  if (typeof draftId !== 'string' || !draftId.startsWith('screenplay-draft:') || !UUID.test(draftId.slice('screenplay-draft:'.length))) throw new Error('Select a screenplay draft with a valid UUID.');
  return `${DEVELOPMENT_KIND}:${draftId.slice('screenplay-draft:'.length)}`;
}

export function createDevelopment(projectId: string, draftId: string): Extract<DevelopmentData, { schemaVersion: 1 }> {
  if (typeof projectId !== 'string' || !RECORD_ID.test(projectId)) throw new Error('Select a valid local project.');
  developmentId(draftId);
  return { schemaVersion: 1, projectId, draftId, concept: '', logline: '', synopsis: '', outline: '', beats: [], characters: [], worldNotes: '', researchNotes: [] };
}
export function withDevelopmentWorld(data: DevelopmentData, world: WorldData, worldNotes = data.worldNotes): DevelopmentData {
  return data.schemaVersion === 3 ? { ...data, world, worldNotes } : { ...data, schemaVersion: 2, world, worldNotes };
}
export const newDevelopmentBeat = (): DevelopmentBeat => ({ id: crypto.randomUUID(), title: '', description: '' });
export const newDevelopmentCharacter = (): DevelopmentCharacter => ({ id: crypto.randomUUID(), name: '', role: '', description: '', arc: '' });
export const newDevelopmentResearchNote = (): DevelopmentResearchNote => ({ id: crypto.randomUUID(), title: '', notes: '', source: '' });
export const cloneDevelopment = (data: DevelopmentData): DevelopmentData => JSON.parse(canonicalJson(data));

/** Strict browser-side validation, including untrusted recovery/initial records. Never truncates text. */
export function developmentError(value: unknown, projectId: string, draftId: string): string | null {
  try { createDevelopment(projectId, draftId); } catch (error) { return (error as Error).message; }
  const schema = plain(value) ? Object.getOwnPropertyDescriptor(value, 'schemaVersion')?.value : undefined;
  const keys = ['schemaVersion', 'projectId', 'draftId', 'concept', 'logline', 'synopsis', 'outline', 'beats', 'characters', 'worldNotes', 'researchNotes'];
  if (schema === 2 || schema === 3) keys.push('world');
  if (schema === 3) keys.push('worldSources');
  if (!shape(value, keys)) return 'Development has unsupported or missing fields.';
  if (![1, 2, 3].includes(schema) || value.projectId !== projectId || value.draftId !== draftId) return 'Development belongs to another project, draft, or format.';
  let total = 0;
  const text = (item: unknown, max: number) => {
    // Match lone surrogates as well as NUL; paired surrogate code points are valid.
    if (typeof item !== 'string' || item.length > max || item.includes('\0') || /[\uD800-\uDFFF]/u.test(item)) return false;
    total += item.length;
    return true;
  };
  for (const key of ['concept', 'logline', 'synopsis', 'outline', 'worldNotes'] as const) {
    if (!text(value[key], DEVELOPMENT_LIMITS[key])) return `${key} contains invalid text or exceeds ${DEVELOPMENT_LIMITS[key].toLocaleString()} characters.`;
  }
  const lists = {
    beats: { title: DEVELOPMENT_LIMITS.title, description: DEVELOPMENT_LIMITS.description },
    characters: { name: DEVELOPMENT_LIMITS.name, role: DEVELOPMENT_LIMITS.role, description: DEVELOPMENT_LIMITS.characterNotes, arc: DEVELOPMENT_LIMITS.arc },
    researchNotes: { title: DEVELOPMENT_LIMITS.title, notes: DEVELOPMENT_LIMITS.notes, source: DEVELOPMENT_LIMITS.source },
  };
  for (const key of Object.keys(lists) as (keyof typeof lists)[]) {
    const rows = value[key];
    if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length > DEVELOPMENT_LIMITS[key] || Reflect.ownKeys(rows).length !== rows.length + 1 || !Array.from({ length: rows.length }, (_, index) => Object.getOwnPropertyDescriptor(rows, String(index))).every(property => property?.enumerable && Object.prototype.hasOwnProperty.call(property, 'value'))) return `Too many or invalid ${key}.`;
    const ids = new Set<string>();
    for (const row of rows) {
      if (!shape(row, ['id', ...Object.keys(lists[key])]) || typeof row.id !== 'string' || !UUID.test(row.id) || ids.has(row.id.toLowerCase())) return `Invalid or duplicate ${key} identity.`;
      ids.add(row.id.toLowerCase());
      for (const [field, max] of Object.entries(lists[key])) if (!text(row[field], max)) return `${key}: ${field} contains invalid text or exceeds ${max.toLocaleString()} characters.`;
    }
  }
  if (schema === 2 || schema === 3) {
    const error = worldError(value.world);
    if (error) return error;
    total += worldTextLength(value.world as WorldData);
  }
  if (schema === 3) { const error = worldSourcesError(value.worldSources, value.world as WorldData); if (error) return error; }
  const limit = schema === 2 || schema === 3 ? DEVELOPMENT_LIMITS.totalTextV2 : DEVELOPMENT_LIMITS.totalText;
  return total <= limit ? null : `Development is limited to ${limit.toLocaleString()} characters in total.`;
}

export function isDevelopmentRecord(value: unknown, projectId: string, draftId: string): value is DevelopmentRecord {
  try {
    return plain(value) && value.kind === DEVELOPMENT_KIND && value.id === developmentId(draftId) && version(value.version) && typeof value.sha256 === 'string' && SHA.test(value.sha256) && !developmentError(value.data, projectId, draftId);
  } catch { return false; }
}

export function developmentSave(data: DevelopmentData, expectedVersion: number | null, requestId = crypto.randomUUID()): DevelopmentSave {
  const error = developmentError(data, data.projectId, data.draftId);
  if (error) throw new Error(error);
  if (expectedVersion !== null && !version(expectedVersion)) throw new Error('Invalid saved development version.');
  if (!RECORD_ID.test(requestId)) throw new Error('Invalid save request identity.');
  return { id: developmentId(data.draftId), kind: DEVELOPMENT_KIND, expectedVersion, requestId, data: cloneDevelopment(data) };
}

export interface DevelopmentRecovery {
  schema: 'caniscreenwrite-story-development-recovery/v1';
  projectId: string;
  draftId: string;
  baseVersion: number | null;
  baseSha256: string | null;
  data: DevelopmentData;
  // Retain an uncertain request verbatim so a lost response can be replayed.
  pendingSave: DevelopmentSave | null;
  savedAt: string;
}
export const developmentRecoveryKey = (projectId: string, draftId: string) => `caniscreenwrite:development-recovery:${projectId}:${draftId}`;

export function readDevelopmentRecovery(storage: Pick<Storage, 'getItem'>, projectId: string, draftId: string): DevelopmentRecovery | null {
  try {
    const raw = storage.getItem(developmentRecoveryKey(projectId, draftId));
    if (!raw || raw.length > 4 * 1024 * 1024) return null;
    const copy = JSON.parse(raw);
    if (!shape(copy, ['schema', 'projectId', 'draftId', 'baseVersion', 'baseSha256', 'data', 'pendingSave', 'savedAt']) || copy.schema !== 'caniscreenwrite-story-development-recovery/v1' || copy.projectId !== projectId || copy.draftId !== draftId || developmentError(copy.data, projectId, draftId)) return null;
    if (copy.baseVersion === null ? copy.baseSha256 !== null : !version(copy.baseVersion) || typeof copy.baseSha256 !== 'string' || !SHA.test(copy.baseSha256)) return null;
    if (typeof copy.savedAt !== 'string' || Number.isNaN(Date.parse(copy.savedAt))) return null;
    const pending = copy.pendingSave;
    if (pending !== null && (!shape(pending, ['id', 'kind', 'expectedVersion', 'requestId', 'data']) || pending.id !== developmentId(draftId) || pending.kind !== DEVELOPMENT_KIND || (pending.expectedVersion !== null && !version(pending.expectedVersion)) || typeof pending.requestId !== 'string' || !RECORD_ID.test(pending.requestId) || developmentError(pending.data, projectId, draftId))) return null;
    return copy as unknown as DevelopmentRecovery;
  } catch { return null; }
}

/** Plain Markdown export of current working text, including unsaved edits. */
export function developmentMarkdown(data: DevelopmentData): string {
  const sections = [
    '# Story development', `Project: ${data.projectId}\nDraft: ${data.draftId}`,
    '## Concept', data.concept, '## Logline', data.logline, '## Synopsis', data.synopsis,
    '## Outline', data.outline, '## Beats',
    ...data.beats.flatMap((beat, index) => [`### ${index + 1}. ${beat.title}`, beat.description]),
    '## Characters',
    ...data.characters.flatMap(character => [`### ${character.name}`, `Role: ${character.role}`, character.description, '#### Arc', character.arc]),
    '## World notes', data.worldNotes,
    ...(data.schemaVersion !== 1 ? [worldMarkdown(data.world)] : []),
    ...(data.schemaVersion === 3 ? ['## Shared world connections', ...data.worldSources.map(source => `${source.worldId} · library v${source.version} · ${source.elements.length} element identities · ${source.links.length} connection identities`)] : []),
    '## Research notes',
    ...data.researchNotes.flatMap(note => [`### ${note.title}`, note.notes, `Source: ${note.source}`]),
  ];
  return sections.join('\n\n') + '\n';
}
