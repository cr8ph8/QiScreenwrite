import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mapUniverse, planUniverse } from '../server/qimovi-universe.mjs';
import { canonicalJson, sha256 } from '../server/storage.mjs';
const creative = { id: 'creative-fixture', profile: 'caniscreenwrite-creative/v1', sourceHash: null, title: 'Fixture' };
const elem = (type = 'location') => ({ id: crypto.randomUUID(), type, name: 'Harbor 海', description: '  exact text\n🎬', storyFunction: 'Choice', sensoryDetails: 'Waves', continuity: 'Unresolved', status: 'established', order: 0 });
function source(elements = [elem()]) {
  const draft = { id: `screenplay-draft:${crypto.randomUUID()}`, version: 1, sha256: '1'.repeat(64), data: { title: 'Fixture world' } };
  const development = { id: 'story-development:fixture', version: 1, sha256: '2'.repeat(64), data: { worldNotes: '', world: { schemaVersion: 1, elements, links: [] } } };
  return { project: { id: 'local-fixture' }, draft, development };
}
const empty = { list: () => [] };
test('all local types map explicitly without granting canon or inventing source scene refs', () => {
  const localTypes = ['character','location','world_rule','faction','timeline_note','thematic_note','prop','relationship'];
  const src = source(localTypes.map(elem));
  const mapped = mapUniverse(src, creative), entities = mapped.filter(r => r.kind === 'universe-entity');
  assert.deepEqual(entities.slice(1).map(r => r.data.type), ['character','location','world_rule','group','reference','thematic_note','reference','reference']);
  assert.equal(entities[1].data.summary, src.development.data.world.elements[0].description);
  for (const item of mapped) { assert.equal(item.data.status, 'DRAFT'); assert.equal(item.data.review, 'PROPOSED'); assert.deepEqual(item.data.citations, []); assert.equal(item.data.projectId, creative.id); assert.equal(item.sha256, sha256(canonicalJson(item.data))); }
  assert.ok(entities.every(r => r.data.sceneIds.length === 0));
  assert.deepEqual(mapUniverse(src, creative), mapped);
  const film = mapUniverse(src, { ...creative, profile: 'drifter-hybrid-film/v1', sourceHash: 'f'.repeat(64) });
  assert.ok(film.every(r => !Object.hasOwn(r.data, 'projectId') && r.data.sourceHash === 'f'.repeat(64)));
});
test('long overview, unicode boundaries and whitespace remain intact within QiMovi text bounds', () => {
  for (const text of ['a'.repeat(7799) + '🎬' + '海'.repeat(10000), '\n'.repeat(24000)]) {
    const src = source(); src.development.data.worldNotes = text;
    const claims = mapUniverse(src, creative).filter(r => r.kind === 'universe-claim' && r.id.includes(':overview:'));
    assert.ok(claims.every(r => r.data.body.length <= 8000 && r.data.body.isWellFormed()));
    const actual = claims.map(r => r.data.body.startsWith('Whitespace-only text: ') ? JSON.parse(r.data.body.slice('Whitespace-only text: '.length)) : r.data.body).join('');
    assert.equal(actual, text);
  }
});
test('unsupported controls fail before transfer; same names retain independent identities', () => {
  const a = elem(), b = elem(), src = source([a,b]);
  const identities = mapUniverse(src, creative).filter(r => r.kind === 'universe-entity').map(r => r.id);
  assert.equal(new Set(identities).size, 3);
  a.description = 'bad\x01text';
  assert.throws(() => mapUniverse(src, creative), { code: 'QIMOVI_WORLD_TEXT_INVALID' });
});
test('draft scene/cue connections retain labels and notes without converting them to production identities', () => {
  const src = source(), elementId = src.development.data.world.elements[0].id;
  src.development.data.world.links = [{ id: crypto.randomUUID(), elementId, targetType: 'scene', targetRef: 'number:7', targetLabel: 'INT. HARBOR - NIGHT', notes: 'Timing uncertain' }];
  const mapped = mapUniverse(src, creative), note = mapped.find(r => r.kind === 'universe-claim' && r.data.title === 'Writer connection notes');
  assert.match(note.data.body, /number:7/); assert.match(note.data.body, /Timing uncertain/);
  assert.ok(mapped.filter(r => r.kind === 'universe-link').every(r => r.data.toEntityId.endsWith(':world')));
});
test('plan binds saved revisions, independent target edits and receipt baseline; never overwrites unknown entries', () => {
  const src = source(), binding = 'b'.repeat(64), plan = planUniverse(empty, src, creative, [], binding);
  const mapped = mapUniverse(src, creative), remote = mapped.map(r => ({ ...r, version: 1 }));
  assert.equal(plan.counts.create, mapped.length);
  assert.equal(planUniverse(empty, src, creative, remote, binding).counts.unchanged, mapped.length);
  remote[0].data = { ...remote[0].data, summary: 'Changed in QiMovi' }; remote[0].sha256 = sha256(canonicalJson(remote[0].data));
  assert.equal(planUniverse(empty, src, creative, remote, binding).counts.conflicts, 1);
  const changed = structuredClone(src); changed.development.version++;
  assert.notEqual(planUniverse(empty, changed, creative, [], binding).token, plan.token);
  assert.notEqual(planUniverse(empty, src, creative, [], 'c'.repeat(64)).token, plan.token);
});
test('capacity check rejects a too-large transfer before exposing an applicable plan', () => {
  const src = source();
  const remote = Array.from({ length: 1999 }, (_, i) => ({ id: `universe-claim:existing-${i}`, kind: 'universe-claim' }));
  assert.throws(() => planUniverse(empty, src, creative, remote, 'b'.repeat(64)), { code: 'QIMOVI_UNIVERSE_CAPACITY' });
});
