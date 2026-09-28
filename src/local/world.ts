// Local authoring data only. Status describes the author's notes, never production approval.
export type WorldElementType = 'character' | 'location' | 'world_rule' | 'faction' | 'timeline_note' | 'thematic_note' | 'prop' | 'relationship';
export type WorldStatus = 'idea' | 'established' | 'needs_review';
export interface WorldElement {
  id: string;
  type: WorldElementType;
  name: string;
  description: string;
  storyFunction: string;
  sensoryDetails: string;
  continuity: string;
  status: WorldStatus;
  order: number;
}
export interface WorldLink {
  id: string;
  elementId: string;
  targetType: 'element' | 'scene' | 'character';
  targetRef: string;
  targetLabel: string;
  notes: string;
}
export interface WorldData { schemaVersion: 1; elements: WorldElement[]; links: WorldLink[] }

export const WORLD_TYPES: ReadonlyArray<Readonly<{ value: WorldElementType; label: string; plural: string; prompt: string }>> = Object.freeze([
  { value: 'character', label: 'Character', plural: 'Characters', prompt: 'Who belongs to this world, and what shapes their choices?' },
  { value: 'location', label: 'Location', plural: 'Locations', prompt: 'What happens here, and what makes this place distinctive?' },
  { value: 'world_rule', label: 'World rule', plural: 'World rules', prompt: 'What is possible here, and what are its limits or costs?' },
  { value: 'faction', label: 'Faction', plural: 'Factions', prompt: 'What holds this group together, and what does it want?' },
  { value: 'timeline_note', label: 'Timeline note', plural: 'Timeline notes', prompt: 'What happened, when, and how does it affect the story?' },
  { value: 'thematic_note', label: 'Thematic note', plural: 'Thematic notes', prompt: 'What question or recurring idea does the story explore?' },
  { value: 'prop', label: 'Prop', plural: 'Props', prompt: 'What does this object do or mean, and who uses it?' },
  { value: 'relationship', label: 'Relationship', plural: 'Relationships', prompt: 'What connects these people or groups, and how does it change?' },
].map(item => Object.freeze(item as { value: WorldElementType; label: string; plural: string; prompt: string })));

// Mirrored in local/server/world.mjs; parity is exercised by world.test.ts.
// Text lengths use UTF-16 code units, like the existing development contract.
export const WORLD_LIMITS = Object.freeze({
  elements: 300, links: 1000, name: 160, description: 8000, storyFunction: 4000,
  sensoryDetails: 4000, continuity: 4000, targetRef: 500, targetLabel: 500,
  notes: 2000, totalText: 200000,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identity = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value);
const shape = (value: unknown, keys: string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable && Object.prototype.hasOwnProperty.call(property, 'value');
  });
};
const list = (value: unknown, max: number): value is unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return false;
  const keys = Reflect.ownKeys(value).filter(key => key !== 'length');
  return keys.length === value.length && keys.every(key => {
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return false;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    return property.enumerable && Object.prototype.hasOwnProperty.call(property, 'value');
  });
};
const elementFields = ['id', 'type', 'name', 'description', 'storyFunction', 'sensoryDetails', 'continuity', 'status', 'order'];
const linkFields = ['id', 'elementId', 'targetType', 'targetRef', 'targetLabel', 'notes'];
const elementTextFields = ['name', 'description', 'storyFunction', 'sensoryDetails', 'continuity'] as const;
const linkTextFields = ['targetRef', 'targetLabel', 'notes'] as const;

export const createWorld = (): WorldData => ({ schemaVersion: 1, elements: [], links: [] });
export function newWorldElement(type: WorldElementType): WorldElement {
  if (!WORLD_TYPES.some(item => item.value === type)) throw new Error('Unknown world element type.');
  return { id: crypto.randomUUID(), type, name: '', description: '', storyFunction: '', sensoryDetails: '', continuity: '', status: 'idea', order: 0 };
}
const targetError = (link: Record<string, unknown>): string | null => {
  if (!identity(link.elementId)) return 'World link has an invalid source identity.';
  if (!['element', 'scene', 'character'].includes(link.targetType as string)) return 'World link has an unsupported target type.';
  for (const field of linkTextFields) {
    if (!text(link[field], WORLD_LIMITS[field])) return `World link ${field} contains invalid text or exceeds ${WORLD_LIMITS[field]} characters.`;
  }
  if (!(link.targetRef as string).trim()) return 'World link needs a target reference.';
  if (link.targetType === 'element') {
    if (!identity(link.targetRef)) return 'World link has an invalid target identity.';
    if (link.elementId.toLowerCase() === link.targetRef.toLowerCase()) return 'A world element cannot link to itself.';
  }
  return null;
};
export function newWorldLink(elementId: string, targetType: WorldLink['targetType'], targetRef: string, targetLabel: string): WorldLink {
  const link = { id: crypto.randomUUID(), elementId, targetType, targetRef, targetLabel, notes: '' };
  const error = targetError(link);
  if (error) throw new Error(error);
  return link;
}

/** Sum editable text and link references; fixed enums and UUID identity fields are excluded. Call after validation. */
export function worldTextLength(world: WorldData): number {
  return world.elements.reduce((total, element) => total + elementTextFields.reduce((sum, field) => sum + element[field].length, 0), 0)
    + world.links.reduce((total, link) => total + linkTextFields.reduce((sum, field) => sum + link[field].length, 0), 0);
}

/** Validate exact JSON shapes without normalizing, truncating, or resolving external references. */
export function worldError(value: unknown): string | null {
  if (!shape(value, ['schemaVersion', 'elements', 'links'])) return 'World has unsupported or missing fields.';
  if (value.schemaVersion !== 1) return 'World has an unsupported schema version.';
  if (!list(value.elements, WORLD_LIMITS.elements)) return `World must contain at most ${WORLD_LIMITS.elements} elements in a plain, dense array.`;
  if (!list(value.links, WORLD_LIMITS.links)) return `World must contain at most ${WORLD_LIMITS.links} links in a plain, dense array.`;
  const ids = new Set<string>();
  const elements = new Set<string>();
  for (const element of value.elements) {
    if (!shape(element, elementFields)) return 'World element has unsupported or missing fields.';
    if (!identity(element.id) || ids.has(element.id.toLowerCase())) return 'Invalid or duplicate world element identity.';
    ids.add(element.id.toLowerCase());
    elements.add(element.id.toLowerCase());
    if (!WORLD_TYPES.some(item => item.value === element.type)) return 'Unknown world element type.';
    if (!['idea', 'established', 'needs_review'].includes(element.status as string)) return 'Unknown world author status.';
    if (!Number.isSafeInteger(element.order) || Number(element.order) < 0 || Object.is(element.order, -0)) return 'World element order must be a nonnegative safe integer.';
    for (const field of elementTextFields) {
      if (!text(element[field], WORLD_LIMITS[field])) return `World ${field} contains invalid text or exceeds ${WORLD_LIMITS[field]} characters.`;
    }
  }
  for (const link of value.links) {
    if (!shape(link, linkFields)) return 'World link has unsupported or missing fields.';
    if (!identity(link.id) || ids.has(link.id.toLowerCase())) return 'Invalid or duplicate world link identity.';
    ids.add(link.id.toLowerCase());
    const error = targetError(link);
    if (error) return error;
    if (!elements.has((link.elementId as string).toLowerCase())) return 'World link source element does not exist.';
    if (link.targetType === 'element' && !elements.has((link.targetRef as string).toLowerCase())) return 'World link target element does not exist.';
  }
  return worldTextLength(value as unknown as WorldData) <= WORLD_LIMITS.totalText ? null : `World is limited to ${WORLD_LIMITS.totalText} characters in total.`;
}

/** Return a new collection, dropping every incoming and outgoing internal element link. */
export function removeWorldElement(world: WorldData, id: string): WorldData {
  const key = id.toLowerCase();
  return {
    ...world,
    elements: world.elements.filter(element => element.id.toLowerCase() !== key),
    links: world.links.filter(link => link.elementId.toLowerCase() !== key && !(link.targetType === 'element' && link.targetRef.toLowerCase() === key)),
  };
}

/** Plain authored-text export, retaining link labels, references, and notes verbatim. */
export function worldMarkdown(world: WorldData): string {
  const error = worldError(world);
  if (error) throw new Error(error);
  const sections = ['## World', 'Statuses are author labels, not production approval.'];
  const statusLabels: Record<WorldStatus, string> = { idea: 'Idea', established: 'Established', needs_review: 'Needs review' };
  for (const element of [...world.elements].sort((a, b) => a.order - b.order)) {
    sections.push(`### ${element.name || 'Untitled ' + WORLD_TYPES.find(type => type.value === element.type)!.label.toLowerCase()}`,
      `Type: ${WORLD_TYPES.find(type => type.value === element.type)!.label}\nStatus (author label): ${statusLabels[element.status]}`,
      '#### Description', element.description, '#### Story function', element.storyFunction,
      '#### Sensory details', element.sensoryDetails, '#### Continuity', element.continuity);
    const links = world.links.filter(link => link.elementId.toLowerCase() === element.id.toLowerCase());
    if (links.length) sections.push('#### Links');
    for (const link of links) {
      sections.push(`Target (${link.targetType}): ${link.targetLabel}\nReference: ${link.targetRef}`, link.notes);
    }
  }
  return sections.join('\n\n') + '\n';
}
