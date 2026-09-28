import { describe, expect, it } from 'vitest';
import {
  WORLD_LIMITS, WORLD_TYPES, createWorld, newWorldElement, newWorldLink,
  removeWorldElement, worldError, worldMarkdown, worldTextLength, type WorldData,
} from './world';
import {
  DEVELOPMENT_LIMITS, cloneDevelopment, createDevelopment, developmentError, developmentId,
  developmentMarkdown, developmentSave, isDevelopmentRecord, newDevelopmentBeat,
  newDevelopmentCharacter, newDevelopmentResearchNote, readDevelopmentRecovery, type DevelopmentData, type DevelopmentRecovery,
} from './development';
import { canonicalJson } from './model';
import { canonicalJson as serverCanonicalJson } from '../../local/server/storage.mjs';
import {
  WORLD_LIMITS as serverLimits, WORLD_TYPES as serverTypes, validateWorld,
  worldError as serverError, worldMarkdown as serverMarkdown, worldTextLength as serverTextLength,
  removeWorldElement as serverRemove,
} from '../../local/server/world.mjs';
import { validateDevelopment, DEVELOPMENT_LIMITS as serverDevelopmentLimits } from '../../local/server/development.mjs';

const projectId = 'local-writer:test';
const draftId = 'screenplay-draft:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
function fixture(): WorldData {
  const first = { ...newWorldElement('location'), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Harbor', order: 1 };
  const second = { ...newWorldElement('prop'), id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Compass', order: 0 };
  return { schemaVersion: 1, elements: [first, second], links: [newWorldLink(first.id, 'element', second.id, second.name)] };
}
const development = (world = fixture()): DevelopmentData => ({ ...createDevelopment(projectId, draftId), schemaVersion: 2, world });
function agrees(value: unknown, valid: boolean) {
  const error = worldError(value);
  expect(serverError(value)).toBe(error);
  if (valid) {
    expect(error).toBeNull();
    expect(validateWorld(value)).toBe(value);
  } else {
    expect(error).toBeTypeOf('string');
    expect(() => validateWorld(value)).toThrow();
  }
  const data = { ...createDevelopment(projectId, draftId), schemaVersion: 2, world: value };
  expect(developmentError(data, projectId, draftId) === null).toBe(valid);
  if (valid) expect(validateDevelopment(data, { id: projectId })).toBe(data);
  else expect(() => validateDevelopment(data, { id: projectId })).toThrow();
}

describe('world model and browser/server contract parity', () => {
  it('exports the locked catalog and limits, and creates independent blank authoring data', () => {
    expect(WORLD_TYPES).toEqual(serverTypes);
    expect(WORLD_LIMITS).toEqual(serverLimits);
    expect(DEVELOPMENT_LIMITS).toEqual(serverDevelopmentLimits);
    expect(WORLD_TYPES.map(item => item.value)).toEqual(['character', 'location', 'world_rule', 'faction', 'timeline_note', 'thematic_note', 'prop', 'relationship']);
    const first = createWorld();
    expect(first).toEqual({ schemaVersion: 1, elements: [], links: [] });
    agrees(first, true);
    first.elements.push(newWorldElement('character'));
    expect(createWorld().elements).toEqual([]);
    for (const type of WORLD_TYPES) {
      expect(type.label && type.plural && type.prompt).toBeTruthy();
      const element = newWorldElement(type.value);
      expect(element).toMatchObject({ type: type.value, name: '', description: '', storyFunction: '', sensoryDetails: '', continuity: '', status: 'idea', order: 0 });
      expect(element.id).not.toBe(newWorldElement(type.value).id);
      for (const status of ['idea', 'established', 'needs_review'] as const) agrees({ ...createWorld(), elements: [{ ...element, status }] }, true);
    }
  });

  /* eslint-disable @typescript-eslint/no-explicit-any -- These untrusted-payload mutators intentionally delete required fields, violate discriminants, and inject array properties, accessors, and prototypes that WorldData cannot represent. */
  it.each([
    ['wrong schema', (w: any) => { w.schemaVersion = 2; }],
    ['missing world field', (w: any) => { delete w.links; }],
    ['extra world field', (w: any) => { w.approval = true; }],
    ['missing element field', (w: any) => { delete w.elements[0].continuity; }],
    ['extra element field', (w: any) => { w.elements[0].approved = true; }],
    ['unsupported type', (w: any) => { w.elements[0].type = 'scene'; }],
    ['production status', (w: any) => { w.elements[0].status = 'approved'; }],
    ['bad UUID', (w: any) => { w.elements[0].id = 'not-a-uuid'; }],
    ['duplicate element UUID case', (w: any) => { w.elements[1].id = w.elements[0].id.toUpperCase(); }],
    ['duplicate link UUID case', (w: any) => { w.links.push({ ...w.links[0], id: w.links[0].id.toUpperCase() }); }],
    ['UUID shared by element and link', (w: any) => { w.links[0].id = w.elements[0].id; }],
    ['missing link field', (w: any) => { delete w.links[0].notes; }],
    ['extra link field', (w: any) => { w.links[0].approved = true; }],
    ['bad link UUID', (w: any) => { w.links[0].id = '../id'; }],
    ['bad source UUID', (w: any) => { w.links[0].elementId = 'location:1'; }],
    ['missing source element', (w: any) => { w.links[0].elementId = otherId; }],
    ['bad target type', (w: any) => { w.links[0].targetType = 'project'; }],
    ['bad internal UUID', (w: any) => { w.links[0].targetRef = 'scene:1'; }],
    ['missing target element', (w: any) => { w.links[0].targetRef = otherId; }],
    ['self link ignoring case', (w: any) => { w.links[0].targetRef = w.elements[0].id.toUpperCase(); }],
    ['empty external ref', (w: any) => { w.links[0].targetType = 'scene'; w.links[0].targetRef = ''; }],
    ['blank external ref', (w: any) => { w.links[0].targetType = 'character'; w.links[0].targetRef = ' \n '; }],
    ['sparse elements', (w: any) => { w.elements = new Array(2); }],
    ['sparse links', (w: any) => { delete w.links[0]; }],
    ['decorated array', (w: any) => { w.links.extra = true; }],
    ['symbol array field', (w: any) => { w.links[Symbol('extra')] = true; }],
    ['array index getter', (w: any) => { Object.defineProperty(w.elements, '0', { get: () => { throw new Error('must not execute'); } }); }],
    ['custom array prototype', (w: any) => { Object.setPrototypeOf(w.links, Object.create(Array.prototype)); }],
    ['custom world prototype', (w: any) => { Object.setPrototypeOf(w, { injected: true }); }],
    ['custom element prototype', (w: any) => { Object.setPrototypeOf(w.elements[0], { injected: true }); }],
    ['custom link prototype', (w: any) => { Object.setPrototypeOf(w.links[0], { injected: true }); }],
    ['own proto key', (w: any) => { Object.defineProperty(w.elements[0], '__proto__', { value: {} }); }],
    ['constructor key', (w: any) => { w.links[0].constructor = 'bad'; }],
    ['symbol key', (w: any) => { w[Symbol('extra')] = true; }],
    ['hidden extra field', (w: any) => { Object.defineProperty(w, 'extra', { value: 1 }); }],
    ['property getter', (w: any) => { Object.defineProperty(w.elements[0], 'description', { get: () => { throw new Error('must not execute'); } }); }],
  ])('rejects %s without changing the contract', (_name, change) => {
    const world = fixture(); change(world); agrees(world, false);
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it.each([null, undefined, false, 'world', [], 1])('rejects non-world input %s', value => agrees(value, false));
  it.each([-1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])('rejects noncanonical order %s', order => {
    const world = fixture(); world.elements[0].order = order as number; agrees(world, false);
  });

  it('preserves well-formed Unicode and rejects NUL or lone surrogates in every authored field', () => {
    for (const [list, fields] of [
      ['elements', ['name', 'description', 'storyFunction', 'sensoryDetails', 'continuity']],
      ['links', ['targetRef', 'targetLabel', 'notes']],
    ] as const) {
      for (const field of fields) {
        const world = fixture(); world.links[0].targetType = 'scene';
        for (const bad of ['\0', '\uD800', '\uDC00', 'x\uD800y', '\uDC00\uD800']) {
          Object.assign(world[list][0], { [field]: bad }); agrees(world, false);
        }
        Object.assign(world[list][0], { [field]: '  café 🎬 字\nAuthor text  ' });
        agrees(world, true);
        expect(developmentSave(development(world), null).data.world[list][0][field]).toBe('  café 🎬 字\nAuthor text  ');
      }
    }
  });

  it('checks every field boundary and counts text from elements and links together', () => {
    for (const field of ['name', 'description', 'storyFunction', 'sensoryDetails', 'continuity', 'targetRef', 'targetLabel', 'notes'] as const) {
      const world = fixture(); world.links[0].targetType = 'scene';
      const row = ['targetRef', 'targetLabel', 'notes'].includes(field) ? world.links[0] : world.elements[0];
      const atLimit = 'x'.repeat(WORLD_LIMITS[field]);
      Object.assign(row, { [field]: atLimit }); agrees(world, true);
      Object.assign(row, { [field]: atLimit + 'x' }); agrees(world, false);
    }
    const world = createWorld();
    world.elements = Array.from({ length: 25 }, () => ({ ...newWorldElement('location'), description: 'x'.repeat(8000) }));
    expect(worldTextLength(world)).toBe(200000);
    expect(serverTextLength(world)).toBe(200000);
    agrees(world, true);
    world.links.push(newWorldLink(world.elements[0].id, 'scene', '1', ''));
    agrees(world, false);
    world.elements[0].description = world.elements[0].description.slice(1);
    agrees(world, true);
  });

  it('enforces collection boundaries independently and accepts forward, case-insensitive internal references', () => {
    const world = fixture();
    world.links[0].elementId = world.elements[0].id.toUpperCase();
    world.links[0].targetRef = world.elements[1].id.toUpperCase();
    agrees(world, true);
    const elements = { ...createWorld(), elements: Array.from({ length: WORLD_LIMITS.elements }, () => newWorldElement('character')) };
    agrees(elements, true);
    elements.elements.push(newWorldElement('character')); agrees(elements, false);
    world.links = Array.from({ length: WORLD_LIMITS.links }, () => newWorldLink(world.elements[0].id, 'character', 'opaque / É # reference', ''));
    agrees(world, true);
    world.links.push(newWorldLink(world.elements[0].id, 'scene', 'scene without UUID', '')); agrees(world, false);
    const plain = fixture();
    for (const object of [plain, ...plain.elements, ...plain.links]) Object.setPrototypeOf(object, null);
    agrees(plain, true);
  });

  it('throws for invalid constructor arguments rather than truncating them', () => {
    expect(() => newWorldElement('scene' as unknown as Parameters<typeof newWorldElement>[0])).toThrow();
    expect(() => newWorldLink('bad', 'scene', 'ref', '')).toThrow();
    expect(() => newWorldLink(otherId, 'scene', 'x'.repeat(501), '')).toThrow();
    expect(() => newWorldLink(otherId, 'character', 'ref', 'x'.repeat(501))).toThrow();
    expect(() => newWorldLink(otherId, 'element', otherId.toUpperCase(), '')).toThrow();
    expect(() => newWorldLink(otherId, 'element', 'bad', '')).toThrow();
    expect(newWorldLink(otherId, 'scene', '  opaque / reference  ', '  Label  ')).toMatchObject({ targetRef: '  opaque / reference  ', targetLabel: '  Label  ', notes: '' });
  });

  it('removes inbound and outbound element links immutably and keeps unrelated external refs opaque', () => {
    const world = fixture(); const [first, second] = world.elements;
    world.links.push(newWorldLink(second.id, 'element', first.id.toUpperCase(), 'Incoming'));
    world.links.push(newWorldLink(first.id, 'scene', 'scene:1', 'Outgoing'));
    const retained = newWorldLink(second.id, 'character', first.id, 'External reference');
    world.links.push(retained);
    const before = structuredClone(world);
    const removed = removeWorldElement(world, first.id.toUpperCase());
    expect(removed.elements).toEqual([second]);
    expect(removed.links).toEqual([retained]);
    expect(removed).toEqual(serverRemove(world, first.id));
    expect(world).toEqual(before);
    agrees(removed, true);
    expect(removeWorldElement(world, otherId)).toEqual(world);
  });

  it('exports ordered authored text, every link, and author status without mutating the world', () => {
    const world = fixture();
    Object.assign(world.elements[0], { description: '  Exact description\n🎬  ', storyFunction: 'Story purpose', sensoryDetails: 'Wet stone', continuity: 'Keep compass cracked', status: 'established' });
    world.links[0].notes = '  Connection note  ';
    const before = structuredClone(world);
    const markdown = worldMarkdown(world);
    expect(markdown).toBe(serverMarkdown(world));
    for (const text of ['  Exact description\n🎬  ', 'Story purpose', 'Wet stone', 'Keep compass cracked', 'Status (author label): Established', '  Connection note  ', world.links[0].targetRef]) expect(markdown).toContain(text);
    expect(markdown.indexOf('### Compass')).toBeLessThan(markdown.indexOf('### Harbor'));
    expect(developmentMarkdown(development(world))).toContain(markdown);
    expect(world).toEqual(before);
  });
});

describe('development schema version compatibility', () => {
  it('retains the exact v1 shape through save, clone, record read, and recovery', () => {
    const data = createDevelopment(projectId, draftId);
    expect(data.schemaVersion).toBe(1);
    expect(Object.keys(data).sort()).toEqual(['schemaVersion', 'projectId', 'draftId', 'concept', 'logline', 'synopsis', 'outline', 'beats', 'characters', 'worldNotes', 'researchNotes'].sort());
    expect(cloneDevelopment(data)).toEqual(data);
    expect(developmentSave(data, null).data).toEqual(data);
    expect(developmentMarkdown(data)).not.toContain('## World\n');
    for (const value of [data, development()]) {
      expect(isDevelopmentRecord({ id: developmentId(draftId), kind: 'story-development', version: 1, sha256: 'a'.repeat(64), data: value }, projectId, draftId)).toBe(true);
      const copy: DevelopmentRecovery = { schema: 'caniscreenwrite-story-development-recovery/v1', projectId, draftId, baseVersion: null, baseSha256: null, data: value, pendingSave: developmentSave(value, null), savedAt: '2026-09-26T12:00:00.000Z' };
      expect(readDevelopmentRecovery({ getItem: () => JSON.stringify(copy) }, projectId, draftId)).toEqual(copy);
    }
  });

  it('requires world only in v2 and rejects malformed worlds in initial records and either recovery body', () => {
    for (const invalid of [
      { ...createDevelopment(projectId, draftId), world: createWorld() },
      { ...createDevelopment(projectId, draftId), schemaVersion: 2 },
      { ...development(), schemaVersion: 3 },
      { ...development(), world: null },
      { ...development(), world: { ...createWorld(), extra: 'bad' } },
    ]) {
      expect(developmentError(invalid, projectId, draftId)).toBeTruthy();
      expect(() => validateDevelopment(invalid, { id: projectId })).toThrow();
      expect(isDevelopmentRecord({ id: developmentId(draftId), kind: 'story-development', version: 1, sha256: 'a'.repeat(64), data: invalid }, projectId, draftId)).toBe(false);
      const copy = { schema: 'caniscreenwrite-story-development-recovery/v1', projectId, draftId, baseVersion: null, baseSha256: null, data: development(), pendingSave: developmentSave(development(), null), savedAt: '2026-09-26T12:00:00.000Z' };
      expect(readDevelopmentRecovery({ getItem: () => JSON.stringify({ ...copy, data: invalid }) }, projectId, draftId)).toBeNull();
      expect(readDevelopmentRecovery({ getItem: () => JSON.stringify({ ...copy, pendingSave: { ...copy.pendingSave, data: invalid } }) }, projectId, draftId)).toBeNull();
    }
  });

  it('clones v2 save data, keeps pending v1 requests intact during upgrade recovery, and never auto-upgrades', () => {
    const legacy = createDevelopment(projectId, draftId);
    const data = development();
    const save = developmentSave(data, 1);
    const before = structuredClone(save);
    data.world.elements[0].description = 'Newer edits';
    data.world.links[0].notes = 'Newer connection';
    expect(save).toEqual(before);
    const copy = { schema: 'caniscreenwrite-story-development-recovery/v1', projectId, draftId, baseVersion: 1, baseSha256: 'b'.repeat(64), data, pendingSave: developmentSave(legacy, null), savedAt: '2026-09-26T12:00:00.000Z' };
    expect(readDevelopmentRecovery({ getItem: () => JSON.stringify(copy) }, projectId, draftId)).toEqual(copy);
    expect(legacy).not.toHaveProperty('world');
  });

  it('preserves the 200000 v1 budget and includes all world text in the 400000 v2 budget', () => {
    const legacy = createDevelopment(projectId, draftId);
    legacy.beats = Array.from({ length: 50 }, () => ({ ...newDevelopmentBeat(), description: 'x'.repeat(4000) }));
    expect(developmentError(legacy, projectId, draftId)).toBeNull();
    const world = createWorld();
    world.elements = Array.from({ length: 25 }, () => ({ ...newWorldElement('location'), description: 'x'.repeat(8000) }));
    const data: DevelopmentData = { ...legacy, schemaVersion: 2, world };
    expect(developmentError(data, projectId, draftId)).toBeNull();
    expect(validateDevelopment(data, { id: projectId })).toBe(data);
    for (const value of [legacy, data]) {
      value.concept = 'x';
      expect(developmentError(value, projectId, draftId)).toMatch(/total/);
      expect(() => validateDevelopment(value, { id: projectId })).toThrow(/TEXT_LIMIT/);
    }
  });
});

describe('bounded world serialization and UI fingerprints', () => {
  function maximumData() {
    const data = { ...createDevelopment(projectId, draftId), schemaVersion: 2 as const, world: createWorld() };
    data.beats = Array.from({ length: 200 }, (_, index) => ({ ...newDevelopmentBeat(), description: index < 50 ? '界'.repeat(4000) : '' }));
    data.characters = Array.from({ length: 100 }, newDevelopmentCharacter);
    data.researchNotes = Array.from({ length: 100 }, newDevelopmentResearchNote);
    data.world.elements = Array.from({ length: 300 }, () => newWorldElement('location'));
    data.world.links = Array.from({ length: 1000 }, () => newWorldLink(data.world.elements[0].id, 'element', data.world.elements[1].id, ''));
    let remaining = 164000;
    for (const element of data.world.elements) {
      element.description = '界'.repeat(Math.min(8000, remaining));
      remaining -= element.description.length;
    }
    return data;
  }

  it('fingerprints standalone maximum worlds and full development/recovery envelopes identically without crashes', () => {
    const data = maximumData();
    expect(developmentError(data, projectId, draftId)).toBeNull();
    const save = developmentSave(data, null);
    const { id: _id, ...requestBody } = save;
    const copy: DevelopmentRecovery = { schema: 'caniscreenwrite-story-development-recovery/v1', projectId, draftId, baseVersion: null, baseSha256: null, data, pendingSave: save, savedAt: '2026-09-26T12:00:00.000Z' };
    const legacy = createDevelopment(projectId, draftId);
    const record = { id: save.id, kind: save.kind, version: 1, sha256: 'a'.repeat(64), data };
    for (const value of [data.world, data, save, requestBody, record, { ...record, replayed: false }, copy, { ...copy, data: legacy }, { ...copy, pendingSave: developmentSave(legacy, null) }]) {
      const text = canonicalJson(value);
      expect(text).toBe(serverCanonicalJson(value));
      expect(JSON.parse(text)).toEqual(value);
    }
    expect(new TextEncoder().encode(canonicalJson(copy)).length).toBeGreaterThan(2 * 1024 * 1024);
    expect(readDevelopmentRecovery({ getItem: () => canonicalJson(copy) }, projectId, draftId)).toEqual(copy);
    const before = canonicalJson(data.world);
    // Same operations used for dirty-state fingerprints, immutable save copies,
    // recovery confirmation, and WorldBuilder's remove/undo fingerprint.
    for (let index = 0; index < 5; index++) {
      data.world.elements[0].description = String(index) + data.world.elements[0].description.slice(1);
      expect(canonicalJson(data)).toBe(serverCanonicalJson(data));
      expect(canonicalJson(data.world)).not.toBe(before);
      expect(developmentSave(data, null).data).toEqual(data);
    }
    expect(save.data.world.elements[0].description).toBe('界'.repeat(8000));
    expect(canonicalJson(removeWorldElement(data.world, data.world.elements[0].id))).toBe(serverCanonicalJson(removeWorldElement(data.world, data.world.elements[0].id)));
  });

  it('keeps ordinary/v1 limits and rejects incomplete, unknown, or decorated budget selectors', () => {
    const data = maximumData();
    const pending = developmentSave(data, null);
    const rawCopy = { schema: 'caniscreenwrite-story-development-recovery/v1', projectId, draftId, baseVersion: null, baseSha256: null, data, pendingSave: pending, savedAt: '2026-09-26T12:00:00.000Z' };
    const v1 = createDevelopment(projectId, draftId);
    for (const value of [
      Array(10000).fill(null),
      { ...v1, beats: Array(10000).fill(null) },
      { ...data.world, schemaVersion: 2 },
      { ...data.world, extra: true },
      { ...data, schemaVersion: 1 },
      { ...data, extra: true },
      { ...data, world: { ...data.world, extra: true } },
      { ...pending, extra: true },
      { ...pending, kind: 'screenplay-draft' },
      { ...rawCopy, schema: 'unrecognized-recovery' },
      { ...rawCopy, extra: true },
      { wrapper: data },
    ]) {
      expect(() => canonicalJson(value)).toThrow(/limits/);
      expect(() => serverCanonicalJson(value)).toThrow(/JSON_TOO_LARGE/);
    }
    expect(canonicalJson(Array(9999).fill(null))).toBe(serverCanonicalJson(Array(9999).fill(null)));
    expect(canonicalJson(v1)).toBe(serverCanonicalJson(v1));
  });

  it('enforces mirrored node, depth and UTF-8 byte ceilings after shape qualification', () => {
    const ordinaryBytes = 2 * 1024 * 1024;
    const worldBytes = 4 * 1024 * 1024;
    for (const serialize of [canonicalJson, serverCanonicalJson]) {
      expect(() => serialize('x'.repeat(ordinaryBytes - 2))).not.toThrow();
      expect(() => serialize('x'.repeat(ordinaryBytes - 1))).toThrow();
      expect(() => serialize('界'.repeat(Math.ceil(ordinaryBytes / 3)))).toThrow();
      const world = { schemaVersion: 1, elements: Array(39996).fill(null), links: [] };
      expect(() => serialize(world)).not.toThrow(); // Root + schema + 2 arrays + 39,996 leaves.
      world.elements.push(null);
      expect(() => serialize(world)).toThrow();
      const byteWorld = { schemaVersion: 1, elements: [''], links: [] };
      const overhead = serialize(byteWorld).length;
      byteWorld.elements[0] = 'x'.repeat(worldBytes - overhead);
      expect(() => serialize(byteWorld)).not.toThrow();
      byteWorld.elements[0] += 'x';
      expect(() => serialize(byteWorld)).toThrow();
      byteWorld.elements[0] = '界'.repeat(Math.ceil(worldBytes / 3));
      expect(() => serialize(byteWorld)).toThrow();
      let nested: unknown = null;
      for (let index = 0; index < 33; index++) nested = [nested];
      expect(() => serialize({ ...createWorld(), elements: [nested] })).toThrow();
    }
  });
});
