import { describe, expect, it } from 'vitest';
import { parseScreenplay } from '@/lib/fountain/spec';
import { resolveWorldLink, worldContext } from './world-context';
import type { WorldLink } from './world';

const sceneLink = (targetRef: string, targetLabel: string): WorldLink => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  elementId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  targetType: 'scene', targetRef, targetLabel, notes: 'Authored connection.',
});

describe('world screenplay context', () => {
  it('prefers unique authored scene numbers, never positional scene indexes', () => {
    const source = 'INT. LAB - DAY #12A#\n\nA bell rings.\n\nEXT. PIER - NIGHT\n\nRain falls.';
    expect(worldContext(parseScreenplay(source))).toMatchObject({
      scenes: [
        { ref: 'number:12A', label: 'INT. LAB - DAY', offset: 0 },
        { ref: 'heading:EXT. PIER - NIGHT', label: 'EXT. PIER - NIGHT', offset: source.indexOf('EXT.') },
      ], ambiguousScenes: 0,
    });
  });

  it('falls back to unique headings when authored numbers are duplicated', () => {
    const context = worldContext(parseScreenplay('INT. LAB - DAY #7#\n\nA bell rings.\n\nEXT. PIER - NIGHT #7#\n\nRain falls.'));
    expect(context.scenes.map(scene => scene.ref)).toEqual(['heading:INT. LAB - DAY', 'heading:EXT. PIER - NIGHT']);
    expect(context.ambiguousScenes).toBe(0);
  });

  it('allows repeated headings only when a unique authored number identifies each scene', () => {
    const context = worldContext(parseScreenplay('INT. LAB - DAY #7#\n\nFirst visit.\n\nINT. LAB - DAY #9#\n\nSecond visit.'));
    expect(context.scenes.map(scene => scene.ref)).toEqual(['number:7', 'number:9']);
    expect(context.ambiguousScenes).toBe(0);
  });

  it.each(['', ' #7#'])('excludes ambiguous repeated headings with number suffix %j', suffix => {
    const context = worldContext(parseScreenplay(`INT. LAB - DAY${suffix}\n\nFirst visit.\n\nINT. LAB - DAY${suffix}\n\nSecond visit.\n\nEXT. PIER - NIGHT\n\nRain falls.`));
    expect(context.scenes.map(scene => scene.ref)).toEqual(['heading:EXT. PIER - NIGHT']);
    expect(context.ambiguousScenes).toBe(2);
    expect(resolveWorldLink(sceneLink('heading:INT. LAB - DAY', 'INT. LAB - DAY'), context)).toBeUndefined();
    expect(resolveWorldLink(sceneLink('number:7', 'INT. LAB - DAY'), context)).toBeUndefined();
  });

  it.each(['', ' #12A#'])('resolves a moved scene at its current offset with number suffix %j', suffix => {
    const lab = `INT. LAB - DAY${suffix}\n\nA bell rings.`;
    const pier = 'EXT. PIER - NIGHT\n\nRain falls.';
    const original = worldContext(parseScreenplay(`${lab}\n\n${pier}`)).scenes[0];
    const movedSource = `${pier}\n\n${lab}`;
    const resolved = resolveWorldLink(sceneLink(original.ref, original.label), worldContext(parseScreenplay(movedSource)));
    expect(resolved).toEqual({ ref: original.ref, label: original.label, offset: movedSource.indexOf('INT.') });
  });

  it('rejects a reused scene number whose heading changed', () => {
    const link = sceneLink('number:12A', 'INT. LAB - DAY');
    expect(resolveWorldLink(link, worldContext(parseScreenplay('EXT. QUARRY - NIGHT #12A#\n\nStone falls.')))).toBeUndefined();
    expect(link.targetLabel).toBe('INT. LAB - DAY');
  });

  it('does not offer numbered scenes whose full heading cannot fit in a stored link label', () => {
    const heading = `INT. ${'A'.repeat(501)} - DAY`;
    const context = worldContext(parseScreenplay(`${heading} #12A#\n\nA bell rings.`));
    // A truncated label would let changes after character 500 resolve to an
    // old scene link despite the required full heading match.
    expect(context.scenes).toEqual([]);
    expect(context.ambiguousScenes).toBe(1);
  });

  it('does not silently rebind a deleted or renumbered scene by its heading', () => {
    const link = sceneLink('number:12A', 'INT. LAB - DAY');
    for (const source of ['', 'INT. LAB - DAY #99#\n\nA bell rings.', 'INT. LAB - DAY\n\nA bell rings.']) {
      expect(resolveWorldLink(link, worldContext(parseScreenplay(source)))).toBeUndefined();
    }
  });

  it('makes a formerly unique heading stale when it becomes ambiguous', () => {
    const link = sceneLink('heading:INT. LAB - DAY', 'INT. LAB - DAY');
    const context = worldContext(parseScreenplay('INT. LAB - DAY\n\nFirst visit.\n\nINT. LAB - DAY\n\nSecond visit.'));
    expect(resolveWorldLink(link, context)).toBeUndefined();
  });

  it('collects distinct character cues and locations without deriving prose or mutating the screenplay', () => {
    const screenplay = parseScreenplay('INT. LAB - DAY\n\nMIRA\nKeep the door shut.\n\nEXT. PIER - NIGHT\n\nSOL\nI heard it.\n\nINT. LAB - NIGHT\n\nMIRA\nWait here.');
    const before = structuredClone(screenplay);
    const context = worldContext(screenplay);
    expect(context.characters).toEqual([{ ref: 'MIRA', label: 'MIRA', offset: screenplay.source.indexOf('MIRA') }, { ref: 'SOL', label: 'SOL', offset: screenplay.source.indexOf('SOL') }]);
    expect(context.locations).toEqual(['LAB', 'PIER']);
    expect(screenplay).toEqual(before);
    const link = { ...sceneLink('MIRA', 'MIRA'), targetType: 'character' as const };
    expect(resolveWorldLink(link, context)).toEqual({ ref: 'MIRA', label: 'MIRA', offset: screenplay.source.indexOf('MIRA') });
    expect(resolveWorldLink({ ...link, targetLabel: 'Another name' }, context)).toBeUndefined();
    expect(resolveWorldLink({ ...link, targetRef: 'REMOVED' }, context)).toBeUndefined();
    expect(resolveWorldLink({ ...link, targetType: 'element' }, context)).toBeUndefined();
  });

  it.each(['\n', '\r\n'])('takes the first exact parsed cue offset with %j endings, including before a scene', ending => {
    const source = ['Title: MIRA', '', '!MIRA is written on a door.', '', '[[MIRA]]', '', '/*', 'MIRA', 'Not a cue.', '*/', '', '@Mira (V.O.)', 'A whispered line.', '', 'INT. LAB - DAY', '', 'MIRA (O.S.)', 'Another line.', '', 'SOL ^', 'Reply.', '', 'MIRA', 'Again.'].join(ending);
    const screenplay = parseScreenplay(source), before = structuredClone(screenplay);
    const context = worldContext(screenplay);
    expect(context.characters).toEqual([
      { ref: 'MIRA', label: 'MIRA', offset: source.indexOf('MIRA (O.S.)') },
      { ref: 'Mira', label: 'Mira', offset: source.indexOf('@Mira') },
      { ref: 'SOL', label: 'SOL', offset: source.indexOf('SOL ^') },
    ]);
    expect(resolveWorldLink({ ...sceneLink('mira', 'mira'), targetType: 'character' }, context)).toBeUndefined();
    expect(resolveWorldLink({ ...sceneLink('MIRA', 'Mira'), targetType: 'character' }, context)).toBeUndefined();
    expect(screenplay).toEqual(before);
  });

  it('updates the first character cue offset as repeated cues move or disappear', () => {
    const prefix = 'INT. LAB - DAY\n\n!MIRA waits.\n\n';
    const first = 'MIRA (V.O.)\nFirst speech.', second = 'MIRA\nSecond speech.';
    const link = { ...sceneLink('MIRA', 'MIRA'), targetType: 'character' as const };
    const original = `${prefix}${first}\n\n${second}`;
    expect(resolveWorldLink(link, worldContext(parseScreenplay(original)))?.offset).toBe(original.indexOf('MIRA (V.O.)'));
    const moved = `${prefix}!An interruption.\n\n${second}\n\n${first}`;
    expect(resolveWorldLink(link, worldContext(parseScreenplay(moved)))?.offset).toBe(moved.indexOf('MIRA\n'));
    expect(resolveWorldLink(link, worldContext(parseScreenplay(prefix)))).toBeUndefined();
    expect(link).toEqual({ ...sceneLink('MIRA', 'MIRA'), targetType: 'character' });
  });

  it('keeps scene references and labels case-sensitive', () => {
    const context = worldContext(parseScreenplay('INT. LAB - DAY #12A#\n\nA bell rings.'));
    expect(resolveWorldLink(sceneLink('number:12a', 'INT. LAB - DAY'), context)).toBeUndefined();
    expect(resolveWorldLink(sceneLink('number:12A', 'int. lab - day'), context)).toBeUndefined();
  });
});
