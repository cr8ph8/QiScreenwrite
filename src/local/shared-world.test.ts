import { describe, expect, it } from 'vitest';
import { validateSharedWorld, SHARED_WORLD_LIMITS as serverLimits } from '../../local/server/shared-world.mjs';
import { appendSharedWorldNotes, appendWorldSnapshot, createSharedWorld, isSharedWorldRecord, newSharedWorldId, publishWorldSnapshot, sharedWorldError, sharedWorldSave, SHARED_WORLD_LIMITS } from './shared-world';
import { createWorld, newWorldElement, newWorldLink, worldError } from './world';

const project = { id: 'local-project:library-test' };
const id = 'shared-world:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const data = () => ({ ...createSharedWorld(project.id), name: 'Harbor stories', description: 'Owner overview.\nExact text.' });
const linkedWorld = () => {
  const place = { ...newWorldElement('location'), name: 'Harbor', description: 'Authored place.', continuity: 'Always flooded.' };
  const prop = { ...newWorldElement('prop'), name: 'Key', description: 'Authored prop.', order: 1 };
  return { schemaVersion: 1 as const, elements: [place, prop], links: [{ ...newWorldLink(place.id, 'element', prop.id.toUpperCase(), 'Key'), notes: 'Opens the gate.' }] };
};

describe('shared world contracts', () => {
  it('accepts only the exact shared world shape without rewriting text', () => {
    const value = { ...data(), world: linkedWorld() };
    expect(serverLimits).toEqual(SHARED_WORLD_LIMITS);
    expect(sharedWorldError(value, project.id)).toBeNull();
    expect(validateSharedWorld('shared-world', value, project, id)).toBe(value);
    const request = sharedWorldSave(id, value, 2);
    expect(request).toMatchObject({ id, kind: 'shared-world', expectedVersion: 2, data: value });
    request.data.description = 'An independent copy.';
    expect(value.description).toBe('Owner overview.\nExact text.');
    expect(newSharedWorldId()).toMatch(/^shared-world:[a-f0-9-]{36}$/);
    expect(isSharedWorldRecord({ id, kind: 'shared-world', version: 2, sha256: 'a'.repeat(64), data: value }, project.id)).toBe(true);
  });
  it.each([
    ['unknown field', (value: ReturnType<typeof data>) => ({ ...value, authority: 'CANONICAL' })],
    ['wrong schema', (value: ReturnType<typeof data>) => ({ ...value, schemaVersion: 2 })],
    ['different project', (value: ReturnType<typeof data>) => ({ ...value, projectId: 'other-project' })],
    ['empty name', (value: ReturnType<typeof data>) => ({ ...value, name: '  ' })],
    ['long name', (value: ReturnType<typeof data>) => ({ ...value, name: 'x'.repeat(161) })],
    ['line break in name', (value: ReturnType<typeof data>) => ({ ...value, name: 'A\nB' })],
    ['long overview', (value: ReturnType<typeof data>) => ({ ...value, description: 'x'.repeat(24001) })],
    ['NUL overview', (value: ReturnType<typeof data>) => ({ ...value, description: '\0' })],
    ['unpaired surrogate', (value: ReturnType<typeof data>) => ({ ...value, description: '\uD800' })],
    ['invalid world', (value: ReturnType<typeof data>) => ({ ...value, world: {} })],
  ])('rejects %s in both validators', (_name, mutate) => {
    const value = mutate(data());
    expect(sharedWorldError(value, project.id)).toBeTruthy();
    expect(() => validateSharedWorld('shared-world', value, project, id)).toThrow();
  });
  it('rejects getters without executing them', () => {
    const value = Object.defineProperty(data(), 'name', { get() { throw new Error('getter executed'); }, enumerable: true });
    expect(sharedWorldError(value, project.id)).toContain('unsupported');
    expect(() => validateSharedWorld('shared-world', value, project, id)).toThrow('SHARED_WORLD_FIELDS_INVALID');
  });
  it.each(['scene', 'character'] as const)('rejects draft-scoped %s links in library records', type => {
    const world = linkedWorld();
    world.links.push(newWorldLink(world.elements[0].id, type, type === 'scene' ? 'number:1' : 'MIRA', 'Source label'));
    const value = { ...data(), world };
    expect(sharedWorldError(value)).toContain('source draft');
    expect(() => validateSharedWorld('shared-world', value, project, id)).toThrow('SHARED_WORLD_SOURCE_LINK_FORBIDDEN');
  });
  it('rejects invalid record identities and kinds', () => {
    for (const bad of ['shared-world:abc', id.replace('shared-world:', 'screenplay-draft:'), id.replace('shared-world:', 'SHARED-WORLD:')]) {
      expect(() => validateSharedWorld('shared-world', data(), project, bad)).toThrow();
      expect(() => sharedWorldSave(bad, data(), null)).toThrow();
    }
    expect(() => validateSharedWorld('story-development', data(), project, id)).toThrow();
    expect(() => sharedWorldSave(id, data(), 0)).toThrow();
    expect(isSharedWorldRecord({ id, kind: 'shared-world', version: 1, sha256: 'a'.repeat(64), data: data() }, 'other-project')).toBe(false);
  });
  it('accepts full overview and the maximum valid world, including multibyte text', () => {
    const elements = Array.from({ length: 300 }, (_, order) => ({ ...newWorldElement('location'), name: '港', order }));
    const world = { schemaVersion: 1 as const, elements, links: Array.from({ length: 1000 }, () => newWorldLink(elements[0].id, 'element', elements[1].id, '港')) };
    const value = { ...data(), name: 'W'.repeat(160), description: '港'.repeat(24000), world };
    expect(sharedWorldError(value)).toBeNull();
    expect(validateSharedWorld('shared-world', value, project, id)).toBe(value);
  });
});

describe('shared world snapshots', () => {
  it('publishes full text and internal links while leaving source-scoped links and notes untouched', () => {
    const world = linkedWorld();
    world.links.push({ ...newWorldLink(world.elements[0].id, 'scene', 'number:1', 'INT. HARBOR - DAY'), notes: 'Scene-specific note stays here.' });
    world.links.push({ ...newWorldLink(world.elements[1].id, 'character', 'MIRA', 'MIRA'), notes: 'Cue-specific note stays here.' });
    const before = structuredClone(world);
    const result = publishWorldSnapshot(world);
    expect(result.excluded).toBe(2);
    expect(result.world.elements).toEqual(world.elements);
    expect(result.world.links).toEqual([world.links[0]]);
    expect(world).toEqual(before);
    result.world.elements[0].description = 'Later library text.';
    expect(world).toEqual(before);
  });
  it('remaps every copied ID and internal reference, retaining existing links and text exactly', () => {
    const world = linkedWorld();
    const original = structuredClone(world);
    const scene = newWorldLink(world.elements[0].id, 'scene', 'number:1', 'INT. HARBOR - DAY');
    const target = { ...world, links: [...world.links, scene] };
    const result = appendWorldSnapshot(target, world);
    expect(result.elements.slice(0, 2)).toEqual(target.elements);
    expect(result.links.slice(0, 2)).toEqual(target.links);
    expect(result.elements[2].id).not.toBe(world.elements[0].id);
    expect(result.links[2]).toMatchObject({ elementId: result.elements[2].id, targetRef: result.elements[3].id, notes: 'Opens the gate.' });
    expect(result.links[2].id).not.toBe(world.links[0].id);
    expect(worldError(result)).toBeNull();
    expect(world).toEqual(original);
    const second = appendWorldSnapshot(result, world);
    expect(second.elements).toHaveLength(6);
    expect(new Set(second.elements.map(item => item.id)).size).toBe(6);
    expect(() => appendWorldSnapshot(world, target)).toThrow('internal');
  });
  it('fails atomically when world size, order or fresh identity cannot fit', () => {
    const world = linkedWorld(), before = structuredClone(world);
    const full = { ...createWorld(), elements: Array.from({ length: 300 }, () => newWorldElement('location')) };
    expect(() => appendWorldSnapshot(full, world)).toThrow('Nothing was copied');
    expect(full.elements).toHaveLength(300);
    expect(() => appendWorldSnapshot(world, world, () => world.elements[0].id)).toThrow('identities');
    expect(() => appendWorldSnapshot({ ...world, elements: world.elements.map(item => ({ ...item, order: Number.MAX_SAFE_INTEGER })) }, world)).toThrow('Nothing was copied');
    expect(world).toEqual(before);
  });
  it('preserves overview text exactly, marks the imported revision, and never truncates overflow', () => {
    expect(appendSharedWorldNotes('Existing notes.\n', data(), 3)).toBe('Existing notes.\n\n\nFrom shared world: Harbor stories (v3)\n\nOwner overview.\nExact text.');
    expect(appendSharedWorldNotes('Keep this.', { ...data(), description: '' }, 1)).toBe('Keep this.');
    expect(() => appendSharedWorldNotes('x'.repeat(24000), data(), 1)).toThrow('Nothing was copied');
  });
});
