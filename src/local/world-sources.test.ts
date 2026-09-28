import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateWorldSources, WORLD_SOURCE_LIMITS as serverLimits } from '../../local/server/world-sources.mjs';
import { canonicalJson } from './model';
import { publishWorldSnapshot, type SharedWorldRecord } from './shared-world';
import { createWorld, removeWorldElement, worldError, WORLD_LIMITS, type WorldData, type WorldElement, type WorldLink } from './world';
import {
  linkWorldSnapshot, publishConnectedWorld, reviewWorldUpdate, trackPublishedWorld,
  worldSourcesError, WORLD_SOURCE_LIMITS, type WorldSource,
} from './world-sources';

// Synthetic identities deliberately do not assume UUID v4 or lowercase spelling.
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-abcd-0000-ffff-123456abcdef`;
const A = uuid(1).toUpperCase(), B = uuid(2), C = uuid(3), L = uuid(4);
const PROJECT = 'local-project:world-sources-test';
const WORLD = `shared-world:${uuid(100)}`;
const copy = <T,>(value: T): T => structuredClone(value);
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function element(id: string, overrides: Partial<WorldElement> = {}): WorldElement {
  return { id, type: 'location', name: 'Harbor', description: 'Salt water.\n  Exact 海 text.',
    storyFunction: 'A place to return.', sensoryDetails: 'Bells and fog.', continuity: 'Tide falls at dawn.',
    status: 'idea', order: 0, ...overrides };
}
function connection(id: string, elementId = A, targetRef = B, overrides: Partial<WorldLink> = {}): WorldLink {
  return { id, elementId, targetType: 'element', targetRef, targetLabel: 'Key', notes: 'Opens the gate.', ...overrides };
}
function libraryWorld(): WorldData {
  return { schemaVersion: 1, elements: [
    element(B, { name: 'Key', type: 'prop', order: 20 }),
    element(A, { order: 10 }),
    element(C, { name: 'Pilot', type: 'character', order: 30 }),
  ], links: [connection(L, A.toLowerCase(), B.toUpperCase())] };
}
function record(world = libraryWorld(), version = 1, id = WORLD, projectId = PROJECT): SharedWorldRecord {
  const data = { schemaVersion: 1 as const, projectId, name: 'Harbor stories', description: 'Library overview.', world: copy(world) };
  return { id, kind: 'shared-world', version, sha256: createHash('sha256').update(canonicalJson(data)).digest('hex'), data };
}
function revision(base: SharedWorldRecord, edit: (world: WorldData) => void, version = base.version + 1): SharedWorldRecord {
  const world = copy(base.data.world);
  edit(world);
  return record(world, version, base.id, base.data.projectId);
}
function findElement(world: WorldData, id: string): WorldElement {
  const found = world.elements.find(item => item.id.toLowerCase() === id.toLowerCase());
  if (!found) throw new Error(`Missing fixture element ${id}`);
  return found;
}
function mapped(source: WorldSource, id: string, kind: 'elements' | 'links' = 'elements'): string {
  const found = source[kind].find(item => item.sourceId.toLowerCase() === id.toLowerCase());
  if (!found) throw new Error(`Missing fixture mapping ${id}`);
  return found.localId;
}
function fixture() {
  const base = record();
  const linked = linkWorldSnapshot(createWorld(), [], base);
  const source = linked.sources[0];
  return { base, ...linked, a: mapped(source, A), b: mapped(source, B), c: mapped(source, C), link: mapped(source, L, 'links') };
}
function addDraftLinks(world: WorldData, id: string): WorldLink[] {
  const links = [
    connection(uuid(90), id, 'number:3', { targetType: 'scene', targetLabel: 'EXT. HARBOR - DAWN', notes: 'Scene note.\nDo not move.' }),
    connection(uuid(91), id, 'MIRA', { targetType: 'character', targetLabel: 'MIRA', notes: 'Exact cue note.' }),
  ];
  world.links.push(...links);
  return copy(links);
}
function assertValid(world: WorldData, sources: WorldSource[]) {
  expect(worldError(world)).toBeNull();
  expect(worldSourcesError(sources, world)).toBeNull();
  expect(validateWorldSources(sources, world)).toBe(sources);
}
function assertRejectsWithoutMutation(run: () => unknown, inputs: unknown[], message?: string | RegExp) {
  const before = copy(inputs);
  inputs.forEach(frozen);
  expect(run).toThrow(message);
  expect(inputs).toEqual(before);
}

afterEach(() => vi.restoreAllMocks());

describe('linked world identities and original publications', () => {
  it('imports separate identities and remaps internal endpoints without rebinding existing names or scenes', () => {
    const base = record(), target = { ...createWorld(), elements: [element(uuid(80), { order: 9 })] };
    const draftLinks = addDraftLinks(target, target.elements[0].id);
    const before = copy({ target, base });
    const result = linkWorldSnapshot(frozen(target), frozen([]), frozen(base));
    expect(result.world.elements[0]).toEqual(target.elements[0]);
    expect(result.world.links.slice(0, 2)).toEqual(draftLinks);
    expect(result.world.elements.slice(1).map(item => [item.name, item.order])).toEqual([['Harbor', 10], ['Key', 11], ['Pilot', 12]]);
    const source = result.sources[0], newIds = [...result.world.elements.slice(1), ...result.world.links.slice(2)].map(item => item.id.toLowerCase());
    const oldIds = [...base.data.world.elements, ...base.data.world.links, ...target.elements, ...target.links].map(item => item.id.toLowerCase());
    expect(newIds).toHaveLength(4);
    expect(new Set(newIds).size).toBe(4);
    expect(newIds.some(id => oldIds.includes(id))).toBe(false);
    expect(result.world.links[2]).toEqual(connection(mapped(source, L, 'links'), mapped(source, A), mapped(source, B)));
    expect(findElement(result.world, mapped(source, A)).description).toBe(findElement(base.data.world, A).description);
    expect(source).toMatchObject({ worldId: base.id, version: 1, sha256: base.sha256 });
    assertValid(result.world, result.sources);
    result.world.elements[1].description = 'Independent edit';
    result.sources[0].elements[0].localId = uuid(81);
    expect({ target, base }).toEqual(before);
  });

  it('tracks an exact original publication while keeping IDs, order, scene and cue links', () => {
    const world = libraryWorld(), draftLinks = addDraftLinks(world, A);
    const base = record(publishWorldSnapshot(world).world);
    const result = trackPublishedWorld(frozen(world), frozen([]), frozen(base));
    expect(result.world).toEqual(world);
    expect(result.world.links.slice(1)).toEqual(draftLinks);
    expect(result.sources[0].elements).toEqual(base.data.world.elements.map(item => ({ sourceId: item.id, localId: item.id })));
    expect(result.sources[0].links).toEqual([{ sourceId: L, localId: L }]);
    expect(result.world).not.toBe(world);
    assertValid(result.world, result.sources);
  });

  it('refuses to track changed content as an exact publication, without mutating any input', () => {
    const base = record(), world = copy(base.data.world), sources: WorldSource[] = [];
    world.elements[0].description = 'Unpublished change';
    assertRejectsWithoutMutation(() => trackPublishedWorld(world, sources, base), [world, sources, base], /no longer matches/);
  });

  it.each(['link', 'track'] as const)('rejects a repeat %s even when the shared-world UUID spelling changes', action => {
    const { base, world, sources } = fixture();
    const alias = { ...base, id: `shared-world:${base.id.slice('shared-world:'.length).toUpperCase()}` };
    const run = action === 'link' ? linkWorldSnapshot : trackPublishedWorld;
    assertRejectsWithoutMutation(() => run(world, sources, alias), [world, sources, alias], /already linked/);
  });

  it('tracks neither an invalid library record nor an invalid draft', () => {
    const base = record(), sources: WorldSource[] = [], world = createWorld();
    const bad = { ...base, kind: 'screenplay-draft' };
    assertRejectsWithoutMutation(() => linkWorldSnapshot(world, sources, bad), [world, sources, bad], /invalid/);
    const invalid = { ...copy(base.data.world), schemaVersion: 2 } as unknown as WorldData;
    assertRejectsWithoutMutation(() => trackPublishedWorld(invalid, [], base), [invalid, base], /version/);
  });
});

const fieldChanges: Array<[keyof Pick<WorldElement, 'type' | 'name' | 'description' | 'storyFunction' | 'sensoryDetails' | 'continuity' | 'status'>, string, string]> = [
  ['type', 'faction', 'world_rule'], ['name', 'Draft harbor', 'Library harbor'],
  ['description', 'Draft description', 'Library description'], ['storyFunction', 'Draft function', 'Library function'],
  ['sensoryDetails', 'Draft sounds', 'Library sounds'], ['continuity', 'Draft continuity', 'Library continuity'],
  ['status', 'established', 'needs_review'],
];

describe('three-way review preserves authored work', () => {
  it('merges independent fields, keeping local collection order, IDs, scene/cue links and unrelated sources', () => {
    const f = fixture();
    const other = record({ ...createWorld(), elements: [element(uuid(60), { name: 'Other world' })] }, 1, `shared-world:${uuid(101)}`);
    const both = linkWorldSnapshot(f.world, f.sources, other);
    const local = findElement(both.world, f.a);
    local.description = 'Only in this draft.\n  Preserve spacing.';
    local.order = 200;
    both.world.elements.reverse();
    const draftLinks = addDraftLinks(both.world, f.a);
    const latest = revision(f.base, world => {
      findElement(world, A).continuity = 'Tide rises at dusk.';
      findElement(world, A).order = 0;
      findElement(world, B).name = 'Brass key';
    });
    const before = copy(both);
    const result = reviewWorldUpdate(frozen(both.world), frozen(both.sources), frozen(f.base), frozen(latest));
    expect(findElement(result.world, f.a)).toMatchObject({ id: f.a, description: local.description, continuity: 'Tide rises at dusk.', order: 200 });
    expect(result.world.elements.map(item => item.id)).toEqual(before.world.elements.map(item => item.id));
    expect(findElement(result.world, f.b).name).toBe('Brass key');
    expect(result.world.links.slice(-2)).toEqual(draftLinks);
    expect(result.sources[1]).toEqual(before.sources[1]);
    expect(result.sources[0]).toMatchObject({ version: latest.version, sha256: latest.sha256 });
    expect(result.conflicts).toEqual([]);
    expect(result.counts).toMatchObject({ added: 0, updated: 2, keptLocal: 1 });
    expect(both).toEqual(before);
    assertValid(result.world, result.sources);
  });

  it.each(fieldChanges)('reviews %s with explicit draft/library choices and leaves unresolved conflicts local', (field, localValue, libraryValue) => {
    const f = fixture();
    Object.assign(findElement(f.world, f.a), { [field]: localValue });
    const latest = revision(f.base, world => Object.assign(findElement(world, A), { [field]: libraryValue }));
    const before = copy(f.world), pending = reviewWorldUpdate(f.world, f.sources, f.base, latest);
    expect(pending.conflicts).toHaveLength(1);
    const conflict = pending.conflicts[0];
    expect(conflict).toMatchObject({ local: localValue, library: libraryValue });
    expect(findElement(pending.world, f.a)[field]).toBe(localValue);
    for (const choice of ['draft', 'library'] as const) {
      const result = reviewWorldUpdate(f.world, f.sources, f.base, latest, { [conflict.id]: choice });
      expect(findElement(result.world, f.a)[field]).toBe(choice === 'draft' ? localValue : libraryValue);
      expect(findElement(result.world, f.a).id).toBe(f.a);
      assertValid(result.world, result.sources);
    }
    expect(f.world).toEqual(before);
  });

  it('does not conflict when both writers reach the same value or when only the draft changed', () => {
    const f = fixture();
    findElement(f.world, f.a).name = 'Agreed name';
    findElement(f.world, f.a).description = 'Local only';
    const latest = revision(f.base, world => { findElement(world, A).name = 'Agreed name'; });
    const result = reviewWorldUpdate(f.world, f.sources, f.base, latest);
    expect(result.conflicts).toEqual([]);
    expect(findElement(result.world, f.a)).toMatchObject({ name: 'Agreed name', description: 'Local only' });
  });

  it('maps new elements and internal connections once and keeps repeated reviews idempotent', () => {
    const f = fixture();
    const draftLinks = addDraftLinks(f.world, f.a);
    findElement(f.world, f.c).order = 500;
    const latest = revision(f.base, world => {
      world.elements.push(element(uuid(5), { name: 'Beacon', order: 0 }));
      world.links.push(connection(uuid(6), uuid(5).toUpperCase(), A.toLowerCase(), { targetLabel: 'Harbor' }));
    });
    const result = reviewWorldUpdate(f.world, f.sources, f.base, latest);
    const newElementId = mapped(result.sources[0], uuid(5)), newLinkId = mapped(result.sources[0], uuid(6), 'links');
    expect(findElement(result.world, newElementId)).toMatchObject({ name: 'Beacon', order: 501 });
    expect(newElementId.toLowerCase()).not.toBe(uuid(5));
    expect(result.world.links.find(item => item.id === newLinkId)).toMatchObject({ elementId: newElementId, targetRef: f.a, targetLabel: 'Harbor' });
    expect(result.world.links.filter(item => item.targetType !== 'element')).toEqual(draftLinks);
    expect(result.counts.added).toBe(2);
    const repeated = reviewWorldUpdate(result.world, result.sources, latest, latest);
    expect(repeated.world).toEqual(result.world);
    expect(repeated.sources).toEqual(result.sources);
    expect(repeated.counts.added).toBe(0);
    expect(new Set([...repeated.world.elements, ...repeated.world.links].map(item => item.id.toLowerCase())).size).toBe(8);
    assertValid(repeated.world, repeated.sources);
  });

  it('retains library removals and their scene links independently, without silently reconnecting reintroduced IDs', () => {
    const f = fixture(), draftLinks = addDraftLinks(f.world, f.b);
    const latest = revision(f.base, world => {
      world.elements = world.elements.filter(item => item.id !== B);
      world.links = [];
    });
    const result = reviewWorldUpdate(f.world, f.sources, f.base, latest);
    expect(result.world).toEqual(f.world);
    expect(result.world.links.slice(-2)).toEqual(draftLinks);
    expect(result.counts.keptRemoved).toBe(2);
    expect(result.sources[0].elements.some(item => item.sourceId === B)).toBe(false);
    expect(result.sources[0].links).toEqual([]);
    const reintroduced = revision(latest, world => { world.elements.push(element(B, { name: 'Replacement key', order: 40 })); });
    const again = reviewWorldUpdate(result.world, result.sources, latest, reintroduced);
    expect(findElement(again.world, f.b).name).toBe('Key');
    expect(mapped(again.sources[0], B)).not.toBe(f.b);
    expect(again.world.links).toEqual(f.world.links);
    assertValid(again.world, again.sources);
  });

  it('never resurrects locally deleted elements, including their incoming and outgoing connections', () => {
    const f = fixture(), world = removeWorldElement(f.world, f.b);
    const latest = revision(f.base, data => {
      findElement(data, B).name = 'Updated key';
      data.links.push(connection(uuid(7), C, B, { targetLabel: 'Key carried by pilot' }));
    });
    const result = reviewWorldUpdate(world, f.sources, f.base, latest);
    expect(result.world).toEqual(world);
    expect(mapped(result.sources[0], B)).toBe(f.b);
    expect(result.counts.locallyRemoved).toBeGreaterThanOrEqual(1);
    expect(result.notices.some(note => note.includes('removed'))).toBe(true);
    const repeated = reviewWorldUpdate(result.world, result.sources, latest, latest);
    expect(repeated.world).toEqual(world);
    expect(repeated.sources).toEqual(result.sources);
    assertValid(repeated.world, repeated.sources);
  });

  it('does not restore a locally deleted connection when its library endpoint changes', () => {
    const f = fixture();
    f.world.links = [];
    const latest = revision(f.base, world => { world.links[0].targetRef = C; });
    const result = reviewWorldUpdate(f.world, f.sources, f.base, latest);
    expect(result.world.links).toEqual([]);
    expect(mapped(result.sources[0], L, 'links')).toBe(f.link);
    expect(result.counts.locallyRemoved).toBe(1);
    assertValid(result.world, result.sources);
  });

  it('applies an upstream endpoint change through local identities while leaving scene links intact', () => {
    const f = fixture(), draftLinks = addDraftLinks(f.world, f.a);
    const latest = revision(f.base, world => {
      world.links[0].elementId = B.toUpperCase();
      world.links[0].targetRef = C.toUpperCase();
      world.links[0].targetLabel = 'Pilot';
    });
    const result = reviewWorldUpdate(f.world, f.sources, f.base, latest);
    expect(result.conflicts).toEqual([]);
    expect(result.world.links[0]).toMatchObject({ id: f.link, elementId: f.b, targetRef: f.c, targetLabel: 'Pilot' });
    expect(result.world.links.slice(1)).toEqual(draftLinks);
    assertValid(result.world, result.sources);
  });

  it('retains an existing connection when its new library target was locally deleted', () => {
    const f = fixture(), world = removeWorldElement(f.world, f.c);
    const latest = revision(f.base, data => { data.links[0].targetRef = C; data.links[0].targetLabel = 'Pilot'; });
    const result = reviewWorldUpdate(world, f.sources, f.base, latest);
    expect(result.world.links).toEqual(world.links);
    expect(result.world.elements).toEqual(world.elements);
    expect(result.notices.some(note => note.includes('unapplied'))).toBe(true);
    expect(mapped(result.sources[0], C)).toBe(f.c);
    const repeated = reviewWorldUpdate(result.world, result.sources, latest, latest);
    expect(repeated.world).toEqual(world);
    expect(repeated.sources).toEqual(result.sources);
    assertValid(repeated.world, repeated.sources);
  });

  it('merges a library connection endpoint change with an independent local note edit', () => {
    const f = fixture();
    f.world.links[0].notes = 'Draft-only connection note';
    const latest = revision(f.base, world => { world.links[0].targetRef = C; world.links[0].targetLabel = 'Pilot'; });
    const result = reviewWorldUpdate(f.world, f.sources, f.base, latest);
    expect(result.conflicts).toEqual([]);
    expect(result.world.links[0]).toMatchObject({ id: f.link, targetRef: f.c, targetLabel: 'Pilot', notes: 'Draft-only connection note' });
    assertValid(result.world, result.sources);
  });

  it('requires a choice when both sides change the same connection notes', () => {
    const f = fixture();
    f.world.links[0].notes = 'Draft connection note';
    const latest = revision(f.base, world => { world.links[0].notes = 'Library connection note'; });
    const pending = reviewWorldUpdate(f.world, f.sources, f.base, latest);
    expect(pending.conflicts).toHaveLength(1);
    expect(pending.world.links[0].notes).toBe('Draft connection note');
    for (const choice of ['draft', 'library'] as const) {
      const result = reviewWorldUpdate(f.world, f.sources, f.base, latest, { [pending.conflicts[0].id]: choice });
      expect(result.world.links[0].notes).toBe(choice === 'draft' ? 'Draft connection note' : 'Library connection note');
      expect(result.world.links[0].id).toBe(f.link);
    }
  });

  it('compares arbitrary mixed-case UUID refs by identity during review', () => {
    const f = fixture();
    f.sources[0].elements.forEach(item => { item.sourceId = item.sourceId.toUpperCase(); item.localId = item.localId.toUpperCase(); });
    f.sources[0].links.forEach(item => { item.sourceId = item.sourceId.toUpperCase(); item.localId = item.localId.toUpperCase(); });
    f.world.links[0].elementId = f.world.links[0].elementId.toUpperCase();
    const latest = revision(f.base, world => { findElement(world, A).description = 'New description'; world.links[0].targetRef = C.toUpperCase(); });
    const result = reviewWorldUpdate(f.world, f.sources, f.base, latest);
    expect(result.conflicts).toEqual([]);
    expect(findElement(result.world, f.a).description).toBe('New description');
    expect(result.world.links[0].targetRef.toLowerCase()).toBe(f.c.toLowerCase());
    expect(result.world.elements.map(item => item.id)).toEqual(f.world.elements.map(item => item.id));
    assertValid(result.world, result.sources);
  });
});

describe('publishing a connected draft', () => {
  it('restores library identities and endpoints while retaining local additions and excluding scene/cue links', () => {
    const f = fixture(), draftLinks = addDraftLinks(f.world, f.a);
    findElement(f.world, f.a).description = 'Published draft revision';
    f.world.elements.push(element(uuid(70), { name: 'Draft addition', order: 99 }));
    f.world.links.push(connection(uuid(71), f.b.toUpperCase(), uuid(70).toUpperCase()));
    f.sources[0].elements.forEach(item => { item.localId = item.localId.toUpperCase(); });
    const before = copy({ world: f.world, sources: f.sources, base: f.base });
    const result = publishConnectedWorld(frozen(f.world), frozen(f.sources), frozen(f.base));
    expect(result.excluded).toBe(2);
    expect(result.world.elements.map(item => item.id)).toEqual([A, B, C, uuid(70)]);
    expect(findElement(result.world, A).description).toBe('Published draft revision');
    expect(result.world.links[0]).toEqual(connection(L, A, B));
    expect(result.world.links[1]).toMatchObject({ id: uuid(71), elementId: B, targetRef: uuid(70).toUpperCase() });
    expect(result.world.links.every(item => item.targetType === 'element')).toBe(true);
    expect(f.world.links.filter(item => item.targetType !== 'element')).toEqual(draftLinks);
    expect(worldError(result.world)).toBeNull();
    result.world.elements[0].description = 'Independent result';
    expect({ world: f.world, sources: f.sources, base: f.base }).toEqual(before);
  });

  it('publishes an unconnected world with its own identities', () => {
    const world = libraryWorld();
    addDraftLinks(world, A);
    expect(publishConnectedWorld(world, [], record())).toEqual(publishWorldSnapshot(world));
  });

  it.each(['version', 'hash'] as const)('rejects an outdated connected %s without mutating the draft', kind => {
    const f = fixture();
    const latest = kind === 'version' ? revision(f.base, () => {}) : { ...f.base, sha256: 'f'.repeat(64) };
    assertRejectsWithoutMutation(() => publishConnectedWorld(f.world, f.sources, latest), [f.world, f.sources, latest], /Review the latest/);
  });

  it('rejects a publish identity collision without changing the draft or lineage', () => {
    const f = fixture();
    f.world.elements.push(element(A, { name: 'Independent local item' }));
    assertRejectsWithoutMutation(() => publishConnectedWorld(f.world, f.sources, f.base), [f.world, f.sources, f.base], /Nothing was published/);
  });
});

describe('history mismatch and atomic review failures', () => {
  it.each([
    ['missing connection', (f: ReturnType<typeof fixture>) => { f.sources = []; }],
    ['wrong source hash', (f: ReturnType<typeof fixture>) => { f.sources[0].sha256 = 'f'.repeat(64); }],
    ['wrong source version', (f: ReturnType<typeof fixture>) => { f.sources[0].version = 2; }],
    ['incomplete source elements', (f: ReturnType<typeof fixture>) => { f.sources[0].elements.pop(); }],
    ['incomplete source links', (f: ReturnType<typeof fixture>) => { f.sources[0].links = []; }],
    ['substituted source ID', (f: ReturnType<typeof fixture>) => { f.sources[0].elements[0].sourceId = uuid(600); }],
  ] as const)('rejects %s without modifying inputs', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    const latest = revision(f.base, world => { findElement(world, A).name = 'Updated'; });
    assertRejectsWithoutMutation(() => reviewWorldUpdate(f.world, f.sources, f.base, latest), [f.world, f.sources, f.base, latest]);
  });

  it.each(['world', 'project', 'kind', 'rollback'] as const)('rejects a different %s history', kind => {
    const f = fixture();
    if (kind === 'rollback') { f.base.version = 2; f.sources[0].version = 2; }
    const latest = revision(f.base, () => {}, kind === 'rollback' ? 1 : 2);
    if (kind === 'world') latest.id = `shared-world:${uuid(999)}`;
    if (kind === 'project') latest.data.projectId = 'local-project:someone-else';
    if (kind === 'kind') latest.kind = 'screenplay-draft';
    assertRejectsWithoutMutation(() => reviewWorldUpdate(f.world, f.sources, f.base, latest), [f.world, f.sources, f.base, latest], /history/);
  });

  it('rejects different immutable contents presented as the same source revision', () => {
    const f = fixture();
    const divergent = revision(f.base, world => { findElement(world, A).description = 'Different revision-one contents'; }, f.base.version);
    expect(divergent.sha256).not.toBe(f.base.sha256);
    assertRejectsWithoutMutation(() => reviewWorldUpdate(f.world, f.sources, f.base, divergent), [f.world, f.sources, f.base, divergent]);
  });

  it('fails atomically when an update would exceed the draft element limit', () => {
    const f = fixture();
    f.world.elements.push(...Array.from({ length: WORLD_LIMITS.elements - f.world.elements.length }, (_, i) => element(uuid(1000 + i), { order: i + 10 })));
    const latest = revision(f.base, world => { world.elements.push(element(uuid(500), { name: 'One too many' })); });
    assertRejectsWithoutMutation(() => reviewWorldUpdate(f.world, f.sources, f.base, latest), [f.world, f.sources, f.base, latest], /300/);
  });

  it('rejects an update whose combined text exceeds the limit even though both inputs fit', () => {
    const f = fixture();
    f.world.elements.push(...Array.from({ length: 24 }, (_, i) => element(uuid(1000 + i), {
      description: 'x'.repeat(8000), name: '', storyFunction: '', sensoryDetails: '', continuity: '', order: i + 10,
    })));
    const latest = revision(f.base, world => { findElement(world, A).description = 'y'.repeat(8000); });
    expect(worldError(f.world)).toBeNull();
    expect(worldError(latest.data.world)).toBeNull();
    assertRejectsWithoutMutation(() => reviewWorldUpdate(f.world, f.sources, f.base, latest), [f.world, f.sources, f.base, latest], /200000/);
  });

  it('fails atomically if fresh UUID allocation repeatedly collides with a reserved local tombstone', () => {
    const f = fixture(), deleted = removeWorldElement(f.world, f.b);
    const latest = revision(f.base, world => { world.elements.push(element(uuid(500))); });
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(f.b as ReturnType<typeof crypto.randomUUID>);
    assertRejectsWithoutMutation(() => reviewWorldUpdate(deleted, f.sources, f.base, latest), [deleted, f.sources, f.base, latest], /distinct world identity/);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(100);
  });

  it('rejects linked imports past the source limit without changing existing data', () => {
    const sources: WorldSource[] = Array.from({ length: 32 }, (_, i) => ({ worldId: `shared-world:${uuid(200 + i)}`, version: 1, sha256: 'a'.repeat(64), elements: [], links: [] }));
    const world = createWorld(), base = record();
    assertRejectsWithoutMutation(() => linkWorldSnapshot(world, sources, base), [world, sources, base], /32/);
  });
});

describe('world-source validation and backend parity', () => {
  it('shares limits and accepts empty lineage, exact self-maps, and deleted local IDs', () => {
    expect(WORLD_SOURCE_LIMITS).toEqual(serverLimits);
    assertValid(createWorld(), []);
    const base = record(), tracked = trackPublishedWorld(base.data.world, [], base);
    assertValid(tracked.world, tracked.sources);
    assertValid(createWorld(), tracked.sources);
  });

  it.each([
    ['extra source property', (s: WorldSource[]) => { Object.assign(s[0], { extra: true }); }],
    ['missing source property', (s: WorldSource[]) => { Reflect.deleteProperty(s[0], 'version'); }],
    ['invalid world ID', (s: WorldSource[]) => { s[0].worldId = 'shared-world:no-uuid'; }],
    ['uppercase kind prefix', (s: WorldSource[]) => { s[0].worldId = s[0].worldId.toUpperCase(); }],
    ['duplicate world case variant', (s: WorldSource[]) => { s.push({ ...copy(s[0]), worldId: `shared-world:${s[0].worldId.slice(13).toUpperCase()}`, elements: [], links: [] }); }],
    ['zero version', (s: WorldSource[]) => { s[0].version = 0; }],
    ['fractional version', (s: WorldSource[]) => { s[0].version = 1.5; }],
    ['maximum excluded version', (s: WorldSource[]) => { s[0].version = 2147483647; }],
    ['uppercase hash', (s: WorldSource[]) => { s[0].sha256 = 'A'.repeat(64); }],
    ['short hash', (s: WorldSource[]) => { s[0].sha256 = 'a'.repeat(63); }],
    ['extra mapping property', (s: WorldSource[]) => { Object.assign(s[0].elements[0], { extra: true }); }],
    ['invalid source UUID', (s: WorldSource[]) => { s[0].elements[0].sourceId = 'not-a-uuid'; }],
    ['invalid local UUID', (s: WorldSource[]) => { s[0].elements[0].localId = 'not-a-uuid'; }],
    ['duplicate source UUID ignoring case', (s: WorldSource[]) => { s[0].elements[1].sourceId = s[0].elements[0].sourceId.toUpperCase(); }],
    ['duplicate local UUID ignoring case', (s: WorldSource[]) => { s[0].elements[1].localId = s[0].elements[0].localId.toUpperCase(); }],
    ['source UUID reused across kinds', (s: WorldSource[]) => { s[0].links[0].sourceId = s[0].elements[0].sourceId; }],
    ['wrong local kind', (s: WorldSource[]) => { s[0].elements[0].localId = s[0].links[0].localId; s[0].links = []; }],
    ['sparse mapping', (s: WorldSource[]) => { Reflect.deleteProperty(s[0].elements, '0'); }],
    ['named array property', (s: WorldSource[]) => { Object.assign(s[0].elements, { extra: true }); }],
    ['non-plain mapping', (s: WorldSource[]) => { Object.setPrototypeOf(s[0].elements[0], { extra: true }); }],
    ['shared local identity across sources', (s: WorldSource[]) => { s.push({ ...copy(s[0]), worldId: `shared-world:${uuid(101)}` }); }],
  ] as const)('rejects %s in both validators', (_name, mutate) => {
    const f = fixture();
    mutate(f.sources);
    expect(worldSourcesError(f.sources, f.world)).toBeTruthy();
    expect(() => validateWorldSources(f.sources, f.world)).toThrow();
  });

  it('rejects accessors and hidden array properties without executing getters', () => {
    for (const location of ['source', 'mapping', 'array'] as const) {
      const f = fixture(), getter = vi.fn(() => { throw new Error('Getter must never run'); });
      if (location === 'source') Object.defineProperty(f.sources[0], 'version', { enumerable: true, get: getter });
      if (location === 'mapping') Object.defineProperty(f.sources[0].elements[0], 'localId', { enumerable: true, get: getter });
      if (location === 'array') Object.defineProperty(f.sources[0].elements, 'hidden', { value: true, enumerable: false });
      expect(worldSourcesError(f.sources, f.world)).toBeTruthy();
      expect(() => validateWorldSources(f.sources, f.world)).toThrow();
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it('accepts arbitrary UUID spellings without rewriting mappings', () => {
    const f = fixture();
    f.sources[0].elements.forEach(item => { item.sourceId = item.sourceId.toUpperCase(); item.localId = item.localId.toUpperCase(); });
    f.sources[0].links[0].sourceId = L.toUpperCase();
    const before = copy(f.sources);
    assertValid(f.world, frozen(f.sources));
    expect(f.sources).toEqual(before);
  });

  it.each(['elements', 'links', 'sources'] as const)('accepts the exact %s limit and rejects aggregate overflow', kind => {
    const source = (n: number): WorldSource => ({ worldId: `shared-world:${uuid(n)}`, version: 1, sha256: 'a'.repeat(64), elements: [], links: [] });
    const sources = [source(100)];
    if (kind === 'sources') sources.push(...Array.from({ length: 31 }, (_, i) => source(200 + i)));
    else sources[0][kind] = Array.from({ length: WORLD_SOURCE_LIMITS[kind] }, (_, i) => ({ sourceId: uuid(1000 + i), localId: uuid(3000 + i) }));
    assertValid(createWorld(), sources);
    const extra = source(900);
    if (kind !== 'sources') extra[kind] = [{ sourceId: uuid(9000), localId: uuid(9001) }];
    sources.push(extra);
    expect(worldSourcesError(sources, createWorld())).toBeTruthy();
    expect(() => validateWorldSources(sources, createWorld())).toThrow();
  });

  it('backend validates the exact immutable base and its hash, without substituting the current revision', () => {
    const f = fixture(), latest = revision(f.base, world => { findElement(world, A).name = 'Latest title'; });
    const history = vi.fn((id: string) => id === f.base.id ? [f.base, latest] : []);
    const current = vi.fn(() => { throw new Error('Current revision must not replace the linked base'); });
    const context = { projectId: PROJECT, store: { history, current } };
    expect(validateWorldSources(f.sources, f.world, context)).toBe(f.sources);
    expect(current).not.toHaveBeenCalled();
    for (const change of ['hash', 'version', 'identities', 'project', 'corrupt-history'] as const) {
      const sources = copy(f.sources), base = copy(f.base), world = copy(f.world);
      const badContext = { projectId: PROJECT, store: { history: () => [base] } };
      if (change === 'hash') sources[0].sha256 = 'f'.repeat(64);
      if (change === 'version') sources[0].version = 20;
      if (change === 'identities') sources[0].elements.pop();
      if (change === 'project') badContext.projectId = 'local-project:other';
      if (change === 'corrupt-history') base.data.world.elements[0].description = 'Tampered bytes';
      assertRejectsWithoutMutation(() => validateWorldSources(sources, world, badContext), [sources, world, base]);
    }
  });
});
