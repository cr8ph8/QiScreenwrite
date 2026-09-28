import { describe, expect, it } from "vitest";
import { parseScreenplay, plainText, readTitlePage } from "../spec";
import { findAll, getTitlePage, numberScenes, reorderScenes, replaceAll, setSceneSynopsis, setTitlePage, toggleDualDialogue } from "../serialize";
import { paginate, pageToText, wrap } from "../paginate";
import { fromFdx, toFdx } from "../fdx";
import { characterReport, locationReport, reportCsv, sceneReport, screenplayStats } from "../reports";
import { buildScreenplayDocx } from "../docx";
import { buildScreenplayPdf } from "../pdf";

const SCRIPT = `Title: The Projector
Credit: Written by
Author: A. Writer
Draft date: 2026-09-16
Contact: writer@example.com

FADE IN:

INT. PROJECTION BOOTH - NIGHT #1#

= The reel is already turning.

The projector hums. MARA (40s, tired) threads a reel.

MARA
(to herself)
Nobody's watching.

JONAS (O.S.)
I am.

MARA
Then sit down.

JONAS ^
I'd rather stand.

> INTERMISSION <

# Act Two

.FLASHBACK - THE LOBBY

!INT. is not a heading here.

~Sing me the reel

[[Check the lobby continuity.]]

/* cut material
MARA
Never mind.
*/

CUT TO:

EXT. STREET - DAY

Rain. **Hard** rain. _Cold_.

===

INT. STREET CAR - CONTINUOUS

MARA
Still here.
`;

describe("spec parser", () => {
  it("reads the title page and every element type with exact offsets", () => {
    const sp = parseScreenplay(SCRIPT);
    expect(readTitlePage(SCRIPT).entries.map((e) => e.key)).toEqual(["Title", "Credit", "Author", "Draft date", "Contact"]);
    expect(sp.blocks.map((b) => b.type)).toEqual([
      "title_page", "transition", "scene_heading", "synopsis", "action", "character", "parenthetical", "dialogue", "character", "dialogue", "character", "dialogue", "character", "dialogue",
      "centered", "section", "scene_heading", "action", "lyrics", "note", "boneyard", "transition", "scene_heading", "action", "page_break", "scene_heading", "character", "dialogue",
    ]);
    for (const block of sp.blocks) expect(SCRIPT.slice(block.start, block.end)).toBe(block.text);
    const heading = sp.blocks[2];
    expect(heading.plain).toBe("INT. PROJECTION BOOTH - NIGHT"); expect(heading.sceneNumber).toBe("1"); expect(heading.sceneIndex).toBe(1);
    expect(sp.blocks[8].character).toEqual({ name: "JONAS", extension: "O.S.", dual: false });
    expect(sp.blocks[12].character?.dual).toBe(true);
    expect(sp.blocks[14].plain).toBe("INTERMISSION");
    expect(sp.blocks[16].plain).toBe("FLASHBACK - THE LOBBY");
    expect(sp.blocks[17].plain).toBe("INT. is not a heading here.");
    expect(sp.blocks[23].plain).toBe("Rain. Hard rain. Cold.");
    expect(sp.scenes.map((s) => [s.index, s.location, s.time, s.characters])).toEqual([[1, "PROJECTION BOOTH", "NIGHT", ["MARA", "JONAS"]], [2, "FLASHBACK - THE LOBBY", "", []], [3, "STREET", "DAY", []], [4, "STREET CAR", "CONTINUOUS", ["MARA"]]]);
    expect(sp.scenes[0].synopsis).toBe("The reel is already turning.");
    expect(plainText("a \\*literal\\* *star*")).toBe("a *literal* star");
  });

  it("does not mistake an all-caps action line for a cue without dialogue", () => {
    const sp = parseScreenplay("INT. ROOM - DAY\n\nSILENCE.\n\nMARA\nHello.\n");
    expect(sp.blocks.map((b) => b.type)).toEqual(["scene_heading", "action", "character", "dialogue"]);
  });
});

describe("serialize", () => {
  it("reorders whole scenes and keeps the preamble", () => {
    const moved = reorderScenes(SCRIPT, 3, 0);
    const scenes = parseScreenplay(moved).scenes.map((s) => s.heading);
    expect(scenes).toEqual(["INT. STREET CAR - CONTINUOUS", "INT. PROJECTION BOOTH - NIGHT", "FLASHBACK - THE LOBBY", "EXT. STREET - DAY"]);
    expect(moved.startsWith("Title: The Projector")).toBe(true);
    expect(moved).toContain("FADE IN:\n\nINT. STREET CAR");
  });
  it("numbers and un-numbers scenes without touching other lines", () => {
    const numbered = numberScenes(SCRIPT, true);
    expect(numbered).toContain("INT. PROJECTION BOOTH - NIGHT #1#");
    expect(numbered).toContain(".FLASHBACK - THE LOBBY #2#");
    expect(numbered).toContain("EXT. STREET - DAY #3#");
    expect(numberScenes(numbered, false)).not.toMatch(/#\d+#/);
    expect(numberScenes(numberScenes(SCRIPT, false), true)).toContain("EXT. STREET - DAY #3#");
  });
  it("toggles dual dialogue on the owning cue", () => {
    const offset = SCRIPT.indexOf("Then sit down.");
    const toggled = toggleDualDialogue(SCRIPT, offset)!;
    expect(toggled).toContain("MARA ^\nThen sit down.");
    expect(toggleDualDialogue(toggled, toggled.indexOf("Then sit down."))).toBe(SCRIPT);
    expect(toggleDualDialogue(SCRIPT, SCRIPT.indexOf("The projector hums"))).toBeNull();
  });
  it("sets, replaces and removes a scene synopsis", () => {
    const withSynopsis = setSceneSynopsis(SCRIPT, 2, "Rain arrives.");
    expect(withSynopsis).toContain("EXT. STREET - DAY\n= Rain arrives.\n");
    expect(setSceneSynopsis(withSynopsis, 2, "Rain leaves.")).toContain("= Rain leaves.");
    expect(setSceneSynopsis(SCRIPT, 0, "")).toBe(SCRIPT.replace("= The reel is already turning.\n", ""));
  });
  it("rewrites the title page", () => {
    const entries = getTitlePage(SCRIPT);
    expect(entries.find((e) => e.key === "Author")?.value).toBe("A. Writer");
    const next = setTitlePage(SCRIPT, [{ key: "Title", value: "New Title" }, { key: "Author", value: "" }, { key: "Notes", value: "line one\nline two" }]);
    expect(next.startsWith("Title: New Title\nNotes: line one\n    line two\n\nFADE IN:")).toBe(true);
    expect(readTitlePage(next).entries).toEqual([{ key: "Title", value: "New Title" }, { key: "Notes", value: "line one\nline two" }]);
    expect(setTitlePage(SCRIPT, []).startsWith("FADE IN:")).toBe(true);
  });
  it("finds and replaces", () => {
    expect(findAll("Mara and MARA", "mara")).toHaveLength(2);
    expect(findAll("Mara and MARA", "mara", { matchCase: true })).toHaveLength(0);
    expect(findAll("Maradona Mara", "Mara", { wholeWord: true })).toHaveLength(1);
    expect(replaceAll("Mara and MARA", "mara", "Jo")).toEqual({ text: "Jo and Jo", count: 2 });
  });
});

describe("pagination", () => {
  it("wraps at element widths and lays out standard indents", () => {
    expect(wrap("a ".repeat(40).trim(), 10)).toEqual(["a a a a a", "a a a a a", "a a a a a", "a a a a a", "a a a a a", "a a a a a", "a a a a a", "a a a a a"]);
    expect(wrap("supercalifragilistic", 8)).toEqual(["supercal", "ifragili", "stic"]);
    const pages = paginate(parseScreenplay("INT. ROOM - DAY\n\nMARA\n(soft)\nHello there, world.\n\nCUT TO:\n"));
    expect(pages).toHaveLength(1);
    const kinds = pages[0].lines.map((l) => [l.type, l.col]);
    expect(kinds).toEqual([["scene_heading", 0], ["blank", 0], ["character", 22], ["parenthetical", 16], ["dialogue", 10], ["blank", 0], ["transition", 0]]);
    expect(pageToText(pages[0])).toContain("                      MARA");
    expect(pageToText(pages[0]).split("\n").at(-1)).toMatch(/^\s+CUT TO:$/);
  });
  it("splits long dialogue with (MORE) and (CONT'D), and adds CONT'D for interrupted speeches", () => {
    const speech = Array.from({ length: 30 }, (_, i) => `Line number ${i + 1} of a very long speech that keeps going.`).join(" ");
    const pages = paginate(parseScreenplay(`INT. ROOM - DAY\n\n${"Action.\n\n".repeat(20)}MARA\n${speech}\n\nJonas nods.\n\nMARA\nStill me.\n`));
    expect(pages.length).toBe(2);
    expect(pages[0].lines.at(-1)?.type).toBe("more");
    expect(pages[0].lines.at(-1)?.text).toBe("(MORE)");
    expect(pages[1].lines[0].text).toBe("MARA (CONT'D)");
    const cues = pages.flatMap((p) => p.lines.filter((l) => l.type === "character").map((l) => l.text));
    expect(cues.at(-1)).toBe("MARA (CONT'D)");
    expect(paginate(parseScreenplay("MARA\nHi.\n\nJonas nods.\n\nMARA\nStill me.\n"), { autoContd: false }).flatMap((p) => p.lines.filter((l) => l.type === "character").map((l) => l.text))).toEqual(["MARA", "MARA"]);
  });
  it("never leaves a scene heading at the bottom of a page and honours page breaks", () => {
    const filler = "Action line.\n\n".repeat(26);
    const pages = paginate(parseScreenplay(`INT. A - DAY\n\n${filler}INT. B - DAY\n\nMore action here.\n\n===\n\nINT. C - DAY\n\nAfter the break.\n`));
    const lastOfFirst = pages[0].lines.filter((l) => l.type !== "blank").at(-1);
    expect(lastOfFirst?.type).not.toBe("scene_heading");
    expect(pages.some((p) => p.lines[0]?.text === "INT. C - DAY")).toBe(true);
  });
  it("renders dual dialogue side by side and scene numbers in the margin", () => {
    const pages = paginate(parseScreenplay("INT. ROOM - DAY #7A#\n\nMARA\nLeft side talking.\n\nJONAS ^\nRight side talking.\n"), { sceneNumbers: true });
    const dual = pages[0].lines.filter((l) => l.dual);
    expect(dual[0].text).toBe("MARA"); expect(dual[0].dual?.text).toBe("JONAS");
    expect(dual[1].text).toBe("Left side talking."); expect(dual[1].dual?.text).toBe("Right side talking.");
    expect(pages[0].lines[0].sceneNumber).toBe("7A");
    expect(pageToText(pages[0]).split("\n")[0]).toMatch(/^7A\s+INT\. ROOM - DAY\s+7A$/);
    expect(paginate(parseScreenplay("INT. ROOM - DAY\n\nEXT. YARD - DAY\n"), { sceneNumbers: true }).flatMap((p) => p.lines.filter((l) => l.type === "scene_heading").map((l) => l.sceneNumber))).toEqual(["1", "2"]);
  });
});

describe("Final Draft interchange", () => {
  it("round-trips a script through FDX", () => {
    const xml = toFdx(SCRIPT);
    expect(xml).toContain('<Paragraph Type="Scene Heading" Number="1"><Text>INT. PROJECTION BOOTH - NIGHT</Text></Paragraph>');
    expect(xml).toContain("<DualDialogue>");
    expect(xml).toContain('<Text Style="Bold">Hard</Text>');
    expect(xml).toContain('<Paragraph Type="Action" Alignment="Center"><Text>INTERMISSION</Text></Paragraph>');
    expect(xml).toContain("<TitlePage>");
    const back = fromFdx(xml);
    const sp = parseScreenplay(back);
    expect(sp.title.find((e) => e.key === "Title")?.value).toBe("The Projector");
    expect(sp.scenes.map((s) => s.heading)).toEqual(["INT. PROJECTION BOOTH - NIGHT", "FLASHBACK - THE LOBBY", "EXT. STREET - DAY", "INT. STREET CAR - CONTINUOUS"]);
    expect(sp.scenes[0].sceneNumber).toBe("1");
    expect(sp.blocks.filter((b) => b.type === "character").map((b) => [b.character!.name, b.character!.dual])).toEqual([["MARA", false], ["JONAS", false], ["MARA", false], ["JONAS", true], ["MARA", false]]);
    expect(back).toContain("**Hard**");
    expect(back).toContain("> INTERMISSION <");
    expect(back).toContain("[[Check the lobby continuity.]]");
    expect(back).toContain("# Act Two");
    expect(back).toContain("===");
    expect(sp.blocks.map((b) => b.type)).toContain("lyrics");
  });
  it("rejects non-FDX input", () => {
    expect(() => fromFdx("<html></html>")).toThrow(/Final Draft/);
  });
});

describe("reports and exports", () => {
  it("reports characters, scenes and locations", () => {
    const sp = parseScreenplay(SCRIPT);
    const pages = paginate(sp);
    const characters = characterReport(sp);
    expect(characters.map((c) => [c.name, c.speeches, c.scenes])).toEqual([["MARA", 3, [1, 4]], ["JONAS", 2, [1]]]);
    expect(characters[0].words).toBeGreaterThan(3);
    const scenes = sceneReport(sp, pages);
    expect(scenes.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(scenes[0].page).toBe(1); expect(scenes[0].eighths).toBeGreaterThanOrEqual(1);
    expect(locationReport(sp).map((row) => row.location)).toEqual(["FLASHBACK - THE LOBBY", "PROJECTION BOOTH", "STREET", "STREET CAR"]);
    expect(locationReport(sp)[1].intExt).toEqual(["INT"]);
    const stats = screenplayStats(sp, pages);
    expect(stats.pages).toBe(pages.length); expect(stats.characters).toBe(2); expect(stats.dialogueShare).toBeGreaterThan(0);
    expect(reportCsv([{ a: "x,y", b: [1, 2] }])).toBe('a,b\n"x,y",1; 2');
  });
  it("builds DOCX and PDF documents", async () => {
    const blob = await buildScreenplayDocx(SCRIPT, { sceneNumbers: true });
    expect(blob.size).toBeGreaterThan(1000);
    const pdf = buildScreenplayPdf(SCRIPT, { sceneNumbers: true, revisedBlocks: new Set([4]), revisionLabel: "Blue revision" });
    expect(pdf.getNumberOfPages()).toBeGreaterThanOrEqual(2);
  });
});
