import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseScreenplay, plainText } from "../spec";
import { getTitlePage, numberScenes, reorderScenes, setSceneSynopsis, setTitlePage, toggleDualDialogue } from "../serialize";
import { fromFdx, toFdx } from "../fdx";
import { paginate, wrap } from "../paginate";
import { buildScreenplayDocx } from "../docx";
import { buildScreenplayPdf } from "../pdf";

describe("source preservation", () => {
  it.each(["\n", "\r\n", "\r"])("keeps original coordinates and edits only targeted text with %j endings", (eol) => {
    const source = '\uFEFFTitle: Exact\nCustom: Preserve me\n\nINT. ROOM - DAY\n\n@MARA\nWait.\n\nEXT. ROAD - NIGHT\n\nRain.  '.replace(/\n/g, eol);
    const parsed = parseScreenplay(source);
    expect(parsed.source).toBe(source);
    for (const block of parsed.blocks) expect(source.slice(block.start, block.end)).toBe(block.text);
    const synopsis = setSceneSynopsis(source, 0, "A new beat.");
    expect(synopsis).toBe(source.replace('INT. ROOM - DAY', `INT. ROOM - DAY${eol}= A new beat.`));
    expect(parseScreenplay(synopsis).scenes).toHaveLength(2);
    expect(parseScreenplay(synopsis).scenes[0].synopsis).toBe("A new beat.");
    expect(numberScenes(source, true)).toBe(source.replace('INT. ROOM - DAY', 'INT. ROOM - DAY #1#').replace('EXT. ROAD - NIGHT', 'EXT. ROAD - NIGHT #2#'));
    expect(toggleDualDialogue(source, source.indexOf('Wait.'))).toBe(source.replace('@MARA', '@MARA ^'));
    expect(setTitlePage(source, getTitlePage(source))).toBe(source);
    expect(reorderScenes(source, -1, 0)).toBe(source);
    const moved = reorderScenes(source, 1, 0);
    expect(parseScreenplay(moved).scenes.map((scene) => scene.heading)).toEqual(['EXT. ROAD - NIGHT', 'INT. ROOM - DAY']);
    expect(moved).toContain('Rain.  ');
  });
  it("does not number headings inside dialogue, notes, title metadata or boneyards", () => {
    const source = 'Title: Exact\nNotes:\n    INT. TITLE - DAY\n\n[[\nINT. NOTE - DAY\n]]\n\n/*\nEXT. CUT - DAY\n*/\n\nMARA\nINT. SPOKEN - DAY\n\nINT. ROOM - DAY\n';
    expect(numberScenes(source, true)).toBe(source.replace('INT. ROOM - DAY', 'INT. ROOM - DAY #1#'));
  });
  it("retains unknown and duplicate title fields and mixed body endings", () => {
    const source = 'Title: Test\r\nAuthor: A\r\nAuthor: B\r\nCustom: Keep\r\n\r\nINT. ROOM - DAY\n\nAction.\r\n';
    const entries = getTitlePage(source);
    entries[0].value = 'New title';
    expect(setTitlePage(source, entries)).toBe(source.replace('Title: Test', 'Title: New title'));
  });
});

describe("inline and Final Draft text", () => {
  it.each([
    ['a \\*literal\\* *star*', 'a *literal* star'],
    ['\\_literal\\_ _underlined_', '_literal_ underlined'],
    ['\uE000 \\*x\\* **bold**', '\uE000 *x* bold'],
    ['***_all three_***', 'all three'],
    ['\\\\*italic*', '\\italic'],
  ])("prints %j without consuming literal markers", (source, printed) => expect(plainText(source)).toBe(printed));
  it("round-trips literal markers, combined styles, title keys and forced action", () => {
    const source = 'Title: Mixed Case\nAuthors: A\n    B\nCustom: Keeps value\n\n!# This is action\n\n!Literal \\*stars\\*, ***_all three_*** and < & >.\n\n~First lyric\n~Second lyric\n';
    const xml = toFdx(source);
    expect(xml).toContain('Style="Bold+Italic+Underline"');
    expect(xml).toContain('&lt; &amp; &gt;');
    const before = parseScreenplay(source), after = parseScreenplay(fromFdx(xml));
    expect(after.title).toEqual(before.title);
    expect(after.blocks.map((block) => [block.type, block.plain])).toEqual(before.blocks.map((block) => [block.type, block.plain]));
  });
  it("imports ordinary FDX styles, literal punctuation and notes without breaking dialogue", () => {
    const xml = '<FinalDraft><Content><Paragraph Type="Character"><Text>Mara</Text></Paragraph><Paragraph Type="Dialogue"><Text>*literal* </Text><Text Style="Bold+Underline">word</Text><ScriptNote><Text>Direction</Text></ScriptNote></Paragraph></Content></FinalDraft>';
    const source = fromFdx(xml), parsed = parseScreenplay(source);
    expect(parsed.blocks.map((block) => block.type)).toEqual(['character', 'dialogue']);
    expect(parsed.blocks[1].plain).toBe('*literal* word');
    expect(toFdx(source)).toContain('Style="Bold+Underline"');
    expect(toFdx(source)).toContain('<ScriptNote><Text>Direction</Text></ScriptNote>');
  });
  it.each(['<html><FinalDraft><Content/></FinalDraft></html>', '<FinalDraft><Content>', '<FinalDraft/>'])("rejects malformed or foreign input", (source) => expect(() => fromFdx(source)).toThrow(/Final Draft/));
});

describe("long exports", () => {
  const action = Array.from({ length: 220 }, (_, index) => `Unique-action-${index}.`).join('\n');
  const speech = Array.from({ length: 220 }, (_, index) => `Unique-speech-${index}.`).join('\n');
  const source = `INT. ROOM - DAY\n\n!${action}\n\nMARA\n${speech}\n`;
  it("keeps all long action and dialogue on bounded pages", () => {
    const pages = paginate(parseScreenplay(source));
    expect(pages.length).toBeGreaterThan(7);
    expect(pages.every((page) => page.lines.length <= 55)).toBe(true);
    expect(pages.flatMap((page) => page.lines).filter((line) => line.type === 'action').map((line) => line.text).join('\n')).toBe(action);
    expect(pages.flatMap((page) => page.lines).filter((line) => line.type === 'dialogue').map((line) => line.text).join('\n')).toBe(speech);
    expect(pages.flatMap((page) => page.lines).filter((line) => line.type === 'more').length).toBeGreaterThan(2);
    expect(buildScreenplayPdf(source).getNumberOfPages()).toBe(pages.length);
    const pdf = buildScreenplayPdf(source).output();
    expect(pdf).toContain('Unique-action-219.');
    expect(pdf).toContain('Unique-speech-219.');
  });
  it("rejects invalid pagination parameters instead of looping", () => {
    expect(() => wrap('anything', 0)).toThrow(RangeError);
    expect(() => paginate(parseScreenplay('Action.'), { linesPerPage: 0 })).toThrow(RangeError);
  });
  it("writes DOCX content, explicit page boundaries and full-width dual dialogue", async () => {
    const script = 'Title: Test\nAuthors: A and B\nDate: Today\nRevision: Blue\n\nMARA\nLeft.\n\nJONAS ^\nRight.\n\n===\n\nLast page.';
    const blob = await buildScreenplayDocx(script);
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob); });
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('A and B'); expect(xml).toContain('Today'); expect(xml).toContain('Blue');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.getElementsByTagName('w:pageBreakBefore')).toHaveLength(2);
    const dual = Array.from(doc.getElementsByTagName('w:p')).find((p) => p.textContent?.includes('Left.'))!;
    expect(dual.textContent).toContain('Right.');
    expect(dual.getElementsByTagName('w:ind')[0].getAttribute('w:right')).toBe('0');
    expect(dual.getElementsByTagName('w:spacing')[0].getAttribute('w:lineRule')).toBe('exact');
  });
});
