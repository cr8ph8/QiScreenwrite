import { describe, expect, it } from 'vitest';
import {
  cycleWritingElement, enterWritingElement, setWritingElement, writingLineAt,
  writingLines, writingSuggestions, writingVisibleText, type WritingElement,
} from './screenplayWritingModel';

describe('screenplay source reading', () => {
  it('retains every author byte and exact offsets, including blank and final lines', () => {
    const value = '  INT. SHOP - DAY  \n\nShe waits.  \n';
    const lines = writingLines(value);
    expect(lines.map(line => line.text).join('\n')).toBe(value);
    for (const line of lines) expect(value.slice(line.start, line.end)).toBe(line.text);
    expect(lines.map(line => line.kind)).toEqual(['scene_heading', 'empty', 'action', 'empty']);
    expect(writingLineAt(value, lines[0].end)).toEqual(lines[0]);
    expect(writingLineAt(value, lines[1].start)).toEqual(lines[1]);
    expect(writingLineAt(value, value.length + 100)).toEqual(lines[3]);
    expect(writingLineAt(value, -2)).toEqual(lines[0]);
    expect(writingLines('')).toEqual([{ start: 0, end: 0, text: '', kind: 'empty' }]);
  });

  it('uses shared dialogue context for all-caps spoken lines', () => {
    const value = '@JANE\nKITCHEN\nTHE END\nIN SLOW MOTION\n(quietly)\nHELLO THERE\n\nKITCHEN';
    expect(writingLines(value).map(line => line.kind)).toEqual([
      'character', 'dialogue', 'dialogue', 'dialogue', 'parenthetical', 'dialogue', 'empty', 'action',
    ]);
  });

  it('recognizes explicit unfinished cues and a final parenthetical while writing', () => {
    expect(writingLines('@').map(line => line.kind)).toEqual(['character']);
    expect(writingLines('@JANE\n(quietly)').map(line => line.kind)).toEqual(['character', 'parenthetical']);
    expect(writingLines('.\n\n>\n\n!').map(line => line.kind)).toEqual(['scene_heading', 'empty', 'transition', 'empty', 'action']);
  });

  it('protects title metadata, sections, multiline notes, and boneyard comments', () => {
    const value = 'Title: Test\n    @fictional title\nAuthor: A Writer\n\nINT. SHOP - DAY\n\n[[Note\n@JANE\n]]\n\n/* hidden\n@JOE\n*/\n\n# Sequence\n= Synopsis';
    const lines = writingLines(value);
    for (const index of [0, 1, 2, 6, 7, 8, 10, 11, 12, 14, 15]) expect(lines[index].kind).toBe('other');
    expect(lines[4].kind).toBe('scene_heading');
    expect(writingVisibleText(lines[7])).toBe('@JANE');
    expect(writingLines('Action. /* omitted\n@HIDDEN\n*/')[1].kind).toBe('other');
  });

  it('hides recognized force markers without altering visible text or parentheses', () => {
    const lines = writingLines('  .DREAM  \n\n@JANE\n(softly)\n!She waits.\n> dissolve');
    expect(lines.map(writingVisibleText)).toEqual(['  DREAM  ', '', 'JANE', '(softly)', 'She waits.', ' dissolve']);
  });
});

describe('explicit element commands', () => {
  it.each([
    ['character', '@JANE DOE'], ['action', '!jane doe'],
    ['scene_heading', '.jane doe'], ['transition', '>jane doe'],
  ] as const)('serializes %s as Fountain while leaving surrounding bytes untouched', (kind, expected) => {
    const before = 'Title: Preserve this\n\nINT. ROOM - DAY\n\n';
    const after = '\n\n<DRIFTER> waits.  \n';
    const value = `${before}  jane doe  ${after}`;
    const edit = setWritingElement(value, before.length + 2, before.length + 6, kind)!;
    expect(edit.value).toBe(`${before}  ${expected}  ${after}`);
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe(kind === 'character' ? 'JANE' : 'jane');
    expect(edit.nextKind).toBe(kind);
  });

  it('preserves sentence case for action and scene-heading commands', () => {
    expect(setWritingElement('She waits for him.', 18, 18, 'action')?.value).toBe('!She waits for him.');
    expect(setWritingElement('int. Kitchen - day', 0, 0, 'scene_heading')?.value).toBe('int. Kitchen - day');
    expect(setWritingElement('> dream sequence', 0, 0, 'scene_heading')?.value).toBe(' .dream sequence');
  });

  it('maps character selections through Unicode uppercase expansion', () => {
    const edit = setWritingElement('straße', 0, 6, 'character')!;
    expect(edit.value).toBe('@STRASSE');
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe('STRASSE');
  });

  it('replaces existing force markers without accumulating them', () => {
    const character = setWritingElement('!Jane', 5, 5, 'character')!;
    expect(character.value).toBe('@JANE');
    expect(setWritingElement(character.value, character.selectionStart, character.selectionEnd, 'action')?.value).toBe('!JANE');
    expect(setWritingElement('.Dream', 6, 6, 'transition')?.value).toBe('>Dream');
  });

  it('refuses a selection spanning physical lines', () => {
    expect(setWritingElement('One.\nTwo.', 0, 9, 'character')).toBeNull();
    expect(cycleWritingElement('One.\nTwo.', 0, 9, 1)).toBeNull();
  });

  it('requires an adjacent cue block for dialogue and parentheticals', () => {
    for (const kind of ['dialogue', 'parenthetical'] as const) {
      expect(setWritingElement('She waits.', 0, 0, kind)).toBeNull();
      expect(setWritingElement('@JANE\n\nhello', 8, 8, kind)).toBeNull();
      expect(setWritingElement('@\nhello', 2, 2, kind)).toBeNull();
    }
    expect(setWritingElement('@JANE\n!Hello there.', 6, 6, 'dialogue')?.value).toBe('@JANE\nHello there.');
    expect(setWritingElement('@JANE\nHello\nquietly', 12, 12, 'parenthetical')?.value).toBe('@JANE\nHello\n(quietly)');
    expect(setWritingElement('JANE\nquietly', 5, 5, 'parenthetical')?.value).toBe('JANE\n(quietly)');
    expect(setWritingElement('JANE\n(quietly)', 5, 5, 'parenthetical')?.value).toBe('JANE\n(quietly)');
    expect(setWritingElement('JANE\n(quietly)', 5, 5, 'dialogue')?.value).toBe('JANE\nquietly');
  });

  it('unwraps a parenthetical only by an explicit element command', () => {
    const value = '@JANE\n(Keep This Case)\nHello';
    expect(setWritingElement(value, 7, 21, 'dialogue')?.value).toBe('@JANE\nKeep This Case\nHello');
    expect(setWritingElement('(She waits.)', 0, 0, 'action')?.value).toBe('!(She waits.)');
    expect(setWritingElement('@JANE\n!(She waits.)', 6, 6, 'action')?.value).toBe('@JANE\n!(She waits.)');
  });

  it('places the caret inside a new empty parenthetical and after other markers', () => {
    const value = '@JANE\n';
    expect(setWritingElement(value, value.length, value.length, 'parenthetical')).toEqual({
      value: '@JANE\n()', selectionStart: 7, selectionEnd: 7, nextKind: 'parenthetical',
    });
    for (const [kind, marker] of [['character', '@'], ['scene_heading', '.'], ['action', '!'], ['transition', '>']] as const) {
      expect(setWritingElement('', 0, 0, kind)).toEqual({ value: marker, selectionStart: 1, selectionEnd: 1, nextKind: kind });
    }
    expect(setWritingElement('   ', 1, 1, 'character')?.value).toBe('   @');
  });

  it('rejects dialogue content the Fountain parser would read as another type', () => {
    const value = '@JANE\n!INT. ROOM - DAY';
    expect(setWritingElement(value, 6, 6, 'dialogue')).toBeNull();
  });

  it('cycles types without lowercasing spoken words', () => {
    const value = '@JANE\nKEEP THIS CASE';
    const edit = cycleWritingElement(value, 10, 10, 1)!;
    expect(edit.value).toBe('@JANE\n(KEEP THIS CASE)');
    expect(cycleWritingElement(edit.value, edit.selectionStart, edit.selectionEnd, -1)?.value).toBe(value);
    expect(cycleWritingElement('Jane', 4, 4, 1)?.value).toBe('@JANE');
    expect(cycleWritingElement('@JANE', 5, 5, -1)?.value).toBe('!JANE');
    expect(cycleWritingElement('', 0, 0, 1, 'scene_heading')?.nextKind).toBe('action');
  });
});

describe('Enter commands', () => {
  it.each([
    ['scene_heading', 'INT. ROOM - DAY', '\n\n', 'action'],
    ['character', '@JANE', '\n', 'dialogue'],
    ['parenthetical', '@JANE\n(softly)', '\n', 'dialogue'],
    ['dialogue', '@JANE\nHello.', '\n\n', 'action'],
    ['action', 'She waits.', '\n\n', 'action'],
    ['transition', '>DISSOLVE TO:', '\n\n', 'scene_heading'],
  ] as const)('%s starts %s with correct Fountain spacing', (kind, value, spacing, nextKind) => {
    expect(enterWritingElement(value, value.length, value.length, kind)).toEqual({
      value: value + spacing, selectionStart: value.length + spacing.length,
      selectionEnd: value.length + spacing.length, nextKind,
    });
  });

  it('finishes an auto-closed parenthetical without leaving its wrapper on the dialogue line', () => {
    const value = '@JANE\n(softly)';
    expect(enterWritingElement(value, value.length - 1, value.length - 1, 'parenthetical')).toEqual({
      value: value + '\n', selectionStart: value.length + 1, selectionEnd: value.length + 1, nextKind: 'dialogue',
    });
  });

  it('inserts a single literal newline midline and for a selected range', () => {
    expect(enterWritingElement('She waits.  \n\nOther.', 4, 4, 'action').value).toBe('She \nwaits.  \n\nOther.');
    expect(enterWritingElement('She waits.  \n\nOther.', 4, 9, 'action')).toEqual({
      value: 'She \n.  \n\nOther.', selectionStart: 5, selectionEnd: 5, nextKind: 'action',
    });
    expect(enterWritingElement('One.\nTwo.\nThree.', 3, 7, 'action').value).toBe('One\no.\nThree.');
  });

  it('Shift Enter always inserts a single newline and preserves kind', () => {
    for (const kind of ['action', 'dialogue', 'character', 'parenthetical', 'scene_heading', 'transition'] as WritingElement[]) {
      expect(enterWritingElement('text', 4, 4, kind, true)).toEqual({ value: 'text\n', selectionStart: 5, selectionEnd: 5, nextKind: kind });
    }
    expect(enterWritingElement('(softly)', 7, 7, 'parenthetical', true).value).toBe('(softly\n)');
  });

  it('handles an empty draft and bounds reversed/out-of-range selections', () => {
    expect(enterWritingElement('', 0, 0, 'action').value).toBe('\n\n');
    expect(enterWritingElement('abc', 50, -4, 'action')).toEqual({ value: '\n', selectionStart: 1, selectionEnd: 1, nextKind: 'action' });
  });
});

describe('draft-only completion', () => {
  it('suggests existing names without force markers, extensions, or all-caps spoken text', () => {
    const value = '@JANE (V.O.)\nJERUSALEM\n\n@JOHN\nHello\n\n@jane\nHello\n\n@j';
    expect(writingSuggestions(value, value.length, 'character')).toEqual(['JANE', 'JOHN']);
    expect(writingSuggestions(value, value.length, 'action')).toEqual([]);
    expect(writingSuggestions('@NOBODY', 7, 'character')).toEqual([]);
  });

  it('suggests existing scene headings case-insensitively without printed scene numbers', () => {
    const value = '.Dream garden #12A#\n\nINT. ROOM - DAY\n\n.DR';
    expect(writingSuggestions(value, value.length, 'scene_heading')).toEqual(['Dream garden']);
  });

  it('limits suggestions to eight unique names and excludes notes', () => {
    const cues = Array.from({ length: 12 }, (_, index) => `@NAME ${index}\nHello`).join('\n\n');
    const value = `[[\n@NAME HIDDEN\n]]\n\n${cues}\n\n@na`;
    expect(writingSuggestions(value, value.length, 'character')).toEqual(Array.from({ length: 8 }, (_, index) => `NAME ${index}`));
  });
});
