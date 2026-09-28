import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as donor from '@/lib/diff';
import { compareRevisionScenes, compareRevisionText, compareSavedRevisions, diffDisplayRows, MAX_COMPARISON_BODY, MAX_DIFF_CELLS, revisionMetadata } from './revision-compare';
import type { DraftRecord } from './types';

const record = (version: number, body: string): DraftRecord => ({ id: 'screenplay-draft:compare', kind: 'screenplay-draft', version, sha256: String(version).repeat(64), data: { schemaVersion: 2, projectId: 'project:compare', sourceHash: null, title: 'Draft', format: 'FOUNTAIN', body, status: 'DRAFT' } });
const scene = (heading: string, body = 'Action.', number = '') => `${heading}${number ? ` #${number}#` : ''}\n\n${body}`;
const script = (...scenes: string[]) => scenes.join('\n\n');
afterEach(() => vi.restoreAllMocks());

describe('bounded exact text comparison', () => {
  it('finds actual edits and unchanged context with source line numbers', () => {
    const result = compareRevisionText('First\nOld\nLast', 'First\nNew\nLast');
    expect(result).toMatchObject({ identical: false, coarse: false, added: 1, removed: 1, unchanged: 2 });
    expect(result.lines).toEqual([
      { type: 'equal', text: 'First\n', beforeLine: 1, afterLine: 1 },
      { type: 'remove', text: 'Old\n', beforeLine: 2 },
      { type: 'add', text: 'New\n', afterLine: 2 },
      { type: 'equal', text: 'Last', beforeLine: 3, afterLine: 3 },
    ]);
  });

  it.each(['', '\n', '\uFEFFINT. ROOM - DAY\r\n\r\nAction.\r', 'same\n'.repeat(20)])('recognizes identical bodies without LCS: %j', body => {
    const compute = vi.spyOn(donor, 'computeDiff');
    const diff = compareRevisionText(body, body);
    expect(diff).toMatchObject({ identical: true, coarse: false, added: 0, removed: 0, preciseCells: 0 });
    expect(diff.lines.map(line => line.text).join('')).toBe(body);
    expect(compute).not.toHaveBeenCalled();
  });

  it.each([['', '\n'], ['x\n', 'x'], ['x\r\n', 'x\n'], ['x\r', 'x\n'], ['\uFEFFx', 'x'], ['x ', 'x']])('keeps whitespace/endings significant: %j to %j', (before, after) => {
    const diff = compareRevisionText(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.added + diff.removed).toBeGreaterThan(0);
    expect(diff.lines.filter(line => line.type !== 'add').map(line => line.text).join('')).toBe(before);
    expect(diff.lines.filter(line => line.type !== 'remove').map(line => line.text).join('')).toBe(after);
  });

  it('reconstructs both sides for arbitrary repeated lines, escapes and mixed endings', () => {
    const source = fc.array(fc.constantFrom('same\n', 'x\r\n', '\r', '\n', '\uFEFF', '"\\*literal*"', '  ', 'end', '🎬'), { maxLength: 35 }).map(lines => lines.join(''));
    fc.assert(fc.property(source, source, (before, after) => {
      const diff = compareRevisionText(before, after);
      expect(diff.lines.filter(line => line.type !== 'add').map(line => line.text).join('')).toBe(before);
      expect(diff.lines.filter(line => line.type !== 'remove').map(line => line.text).join('')).toBe(after);
      expect(diff.preciseCells).toBeLessThanOrEqual(MAX_DIFF_CELLS);
    }), { numRuns: 120, seed: 9272026 });
  });

  it('collapses only unchanged runs without concealing later edits', () => {
    const diff = compareRevisionText('same\n'.repeat(200) + 'old', 'same\n'.repeat(200) + 'new');
    expect(diffDisplayRows(diff, false)).toHaveLength(3);
    expect(diffDisplayRows(diff, false)[0]).toEqual({ kind: 'unchanged', count: 200 });
    expect(diffDisplayRows(diff, true)).toHaveLength(202);
  });

  it('guards maximum-size line-heavy, single-line and insertion comparisons before LCS', () => {
    const compute = vi.spyOn(donor, 'computeDiff');
    const cases = [
      ['a\n'.repeat(100_000), 'b\n'.repeat(100_000)],
      ['a'.repeat(200_000), 'b'.repeat(200_000)],
      ['', '\n'.repeat(200_000)],
      ['\n'.repeat(200_000), '\n'.repeat(200_000)],
    ];
    for (const [before, after] of cases) {
      const result = compareRevisionText(before, after);
      expect(result.preciseCells).toBe(0);
      expect(result.lines.filter(line => line.type !== 'add').map(line => line.text).join('')).toBe(before);
      expect(result.lines.filter(line => line.type !== 'remove').map(line => line.text).join('')).toBe(after);
    }
    expect(compute).not.toHaveBeenCalled();
  }, 10_000);

  it('still resolves one precise edit in a 200,000-character body', () => {
    const before = 'x\n'.repeat(100_000), after = before.slice(0, 100_000) + 'y' + before.slice(100_001);
    expect(compareRevisionText(before, after)).toMatchObject({ coarse: false, preciseCells: 4, added: 1, removed: 1, unchanged: 99_999 });
  });

  it('rejects oversized source without comparing a silently truncated draft', () => {
    expect(() => compareRevisionText('x'.repeat(MAX_COMPARISON_BODY + 1), '')).toThrow('200,000');
    expect(() => compareRevisionScenes('', 'x'.repeat(MAX_COMPARISON_BODY + 1))).toThrow('200,000');
  });
});

describe('conservative scene summaries', () => {
  it('identifies added, removed and changed scenes by unique exact headings', () => {
    const result = compareRevisionScenes(script(scene('INT. ROOM - DAY', 'Old.'), scene('EXT. ROAD - DAY')), script(scene('INT. ROOM - DAY', 'New.'), scene('EXT. SEA - DAY')));
    expect(result.differences.map(item => item.type)).toEqual(['changed', 'removed', 'added']);
    expect(result).toMatchObject({ ambiguousBefore: 0, ambiguousAfter: 0, orderChanged: false });
  });

  it('separates reordering from content edits, including last-scene separators', () => {
    const a = scene('INT. ROOM - DAY'), b = scene('EXT. ROAD - DAY');
    expect(compareRevisionScenes(script(a, b), script(b, a))).toMatchObject({ differences: [], unchanged: 2, orderChanged: true });
    expect(compareRevisionScenes(script(a, b), script(scene('EXT. SEA - DAY'), a, b))).toMatchObject({ unchanged: 2, orderChanged: false });
  });

  it('never pairs repeated unnumbered headings by position, including identical source', () => {
    const before = script(scene('INT. ROOM - DAY', 'One.'), scene('INT. ROOM - DAY', 'Two.'));
    for (const after of [before, script(scene('INT. ROOM - DAY', 'Two.'), scene('INT. ROOM - DAY', 'One.')), scene('INT. ROOM - DAY')]) {
      const result = compareRevisionScenes(before, after);
      expect(result.differences).toEqual([]);
      expect(result.unchanged).toBe(0);
      expect(result.ambiguousBefore).toBe(2);
      expect(result.ambiguousAfter).toBe(after === scene('INT. ROOM - DAY') ? 1 : 2);
    }
  });

  it('can distinguish repeated headings when each exact heading/number is unique', () => {
    const a = scene('INT. ROOM - DAY', 'One.', '1'), b = scene('INT. ROOM - DAY', 'Two.', '2');
    const result = compareRevisionScenes(script(a, b), script(scene('INT. ROOM - DAY', 'Edited.', '2'), a));
    expect(result).toMatchObject({ unchanged: 1, orderChanged: true, ambiguousBefore: 0, ambiguousAfter: 0 });
    expect(result.differences).toEqual([expect.objectContaining({ type: 'changed', basis: 'number and heading', before: { index: 2, heading: 'INT. ROOM - DAY', number: '2' }, after: { index: 1, heading: 'INT. ROOM - DAY', number: '2' } })]);
  });

  it('rejects duplicated numbers on either side even with different headings', () => {
    const a = scene('INT. ROOM - DAY', 'One.', '1'), b = scene('EXT. ROAD - DAY', 'Two.', '1');
    for (const [before, after] of [[script(a, b), a], [a, script(a, b)], [script(a, b), script(b, a)]]) {
      const result = compareRevisionScenes(before, after);
      expect(result.differences).toEqual([]);
      expect(result.ambiguousBefore + result.ambiguousAfter).toBeGreaterThanOrEqual(3);
    }
  });

  it.each([
    [scene('INT. ROOM - DAY', 'Old.', '1'), scene('EXT. SEA - DAY', 'New.', '1')],
    [scene('INT. ROOM - DAY', 'Old.', '1'), scene('INT. ROOM - DAY', 'New.', '2')],
    [scene('INT. ROOM - DAY', 'Old.', '1'), scene('INT. ROOM - DAY', 'New.')],
  ])('leaves reused numbers, renumbering and removed numbers unresolved', (before, after) => {
    expect(compareRevisionScenes(before, after)).toMatchObject({ differences: [], ambiguousBefore: 1, ambiguousAfter: 1 });
  });

  it('uses Fountain semantics for forced headings and ignores headings inside notes/title/boneyard', () => {
    const before = 'Title: Script\n    INT. TITLE - DAY\n\n/*\nINT. HIDDEN - DAY\n*/\n\n[[\nEXT. NOTE - NIGHT\n]]\n\n.A forced place #A1#\n\nAction.';
    const result = compareRevisionScenes(before, before.replace('Action.', 'Changed.'));
    expect(result).toMatchObject({ beforeCount: 1, afterCount: 1 });
    expect(result.differences[0]).toMatchObject({ type: 'changed', before: { heading: 'A forced place', number: 'A1' } });
  });

  it('limits pathological parser work without inventing empty-scene counts', () => {
    for (const source of ['x'.repeat(200_000), '\n'.repeat(200_000), 'INT. ROOM - DAY\n'.repeat(201)]) {
      expect(compareRevisionScenes(source, '')).toMatchObject({ status: 'limited', beforeCount: null, afterCount: null, differences: [] });
    }
  });
});

describe('saved record boundaries', () => {
  it('compares exact metadata independently from identical bodies without mutating records', () => {
    const before = record(1, 'Same body'), after = record(2, 'Same body');
    after.data = { ...after.data, title: 'New title', genre: 'Drama', logline: '', projectFormat: 'short', targetPages: 12 };
    const snapshot = JSON.stringify([before, after]);
    const result = compareSavedRevisions(before, after);
    expect(result.text.identical).toBe(true);
    expect(result.metadata.filter(row => row.changed).map(row => row.field)).toEqual(['title', 'genre', 'logline', 'projectFormat', 'targetPages']);
    expect(result.metadata.find(row => row.field === 'logline')).toMatchObject({ before: undefined, after: '', changed: true });
    expect(JSON.stringify([before, after])).toBe(snapshot);
    expect(revisionMetadata(before.data, before.data).every(row => !row.changed)).toBe(true);
  });

  it('rejects cross-draft and cross-project comparisons', () => {
    const before = record(1, 'A'), after = record(2, 'B');
    expect(() => compareSavedRevisions(before, { ...after, id: 'screenplay-draft:other' })).toThrow('same draft');
    expect(() => compareSavedRevisions(before, { ...after, data: { ...after.data, projectId: 'other' } })).toThrow('same draft');
  });
});
