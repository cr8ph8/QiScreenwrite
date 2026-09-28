import { describe, expect, it } from "vitest";
import { buildSceneSummaries, classifySceneChanges } from "./scene-navigator-model";

describe("scene navigator source summaries", () => {
  it("uses exact raw ranges for forced headings after title text, notes and boneyards with mixed endings", () => {
    const prefix = "\uFEFFTitle: Draft\r\n\r\n/*\r\nINT. COMMENT - DAY\r\n*/\r\n\r\n[[\rEXT. NOTE - NIGHT\r]]\r\r";
    const first = ".Under the lighthouse #A2#\r\n\r\nRain falls.\r\n\r\n";
    const second = "INT./EXT. BOAT - NIGHT #12A#\r\rWaves rise.\n";
    const source = prefix + first + second;
    const summaries = buildSceneSummaries(source);
    expect(summaries.map(scene => [scene.heading, scene.charOffset, scene.sourceContent])).toEqual([
      ["Under the lighthouse", prefix.length, first],
      ["INT./EXT. BOAT - NIGHT", prefix.length + first.length, second],
    ]);
    expect(source).toBe(prefix + first + second);
  });

  it("cleans forced cues and extensions and deduplicates case variants only in the display", () => {
    const source = "INT. ROOM - DAY\n\n@The Drifter (V.O.) (CONT’D)\nWait for me.\n\n@THE DRIFTER (O.S.) ^\nGo.\n\n@DRIFTER\nStay.\n\n[[Keep this note.]]\n";
    const [scene] = buildSceneSummaries(source);
    expect(scene.characters).toEqual(["The Drifter", "DRIFTER"]);
    expect(scene.wordCount).toBe(5);
    expect(scene.sourceContent).toBe(source);
  });

  it("does not invent a scene for draft text without a scene heading", () => {
    expect(buildSceneSummaries("Title: Beginning\n\nA thought before the first scene.")).toEqual([]);
  });
});

describe("scene navigator saved comparisons", () => {
  const makeScene = (action: string) => `EXT. ROAD - DAY\n\n${action}\n\n`;

  it("keeps all eight saved scenes unchanged when headings repeat", () => {
    const text = Array.from({ length: 8 }, (_, index) => makeScene(`The drifter walks ${index} steps.`)).join("");
    const baseline = buildSceneSummaries(text);
    expect(classifySceneChanges(buildSceneSummaries(text), baseline)).toEqual(Array(8).fill("unchanged"));
  });

  it("detects equal-word-count edits and edits to hidden source notes", () => {
    const original = makeScene("The drifter waits.") + makeScene("[[Remember the arrival.]]\n\nRain falls.");
    const edited = original.replace("waits", "leaves").replace("arrival", "departure");
    const baseline = buildSceneSummaries(original), current = buildSceneSummaries(edited);
    expect(current.map(scene => scene.wordCount)).toEqual(baseline.map(scene => scene.wordCount));
    expect(classifySceneChanges(current, baseline)).toEqual(["changed", "changed"]);
  });

  it("matches saved copies once before pairing edited or new duplicate headings", () => {
    const first = makeScene("The drifter waits."), second = makeScene("Rain falls."), added = makeScene("A door opens.");
    const baseline = buildSceneSummaries(first + second);
    expect(classifySceneChanges(buildSceneSummaries(added + first + second), baseline)).toEqual(["new", "unchanged", "unchanged"]);
    expect(classifySceneChanges(buildSceneSummaries(second + first.replace("waits", "leaves")), baseline)).toEqual(["unchanged", "changed"]);
    expect(classifySceneChanges(buildSceneSummaries(first + first + first), buildSceneSummaries(first + first))).toEqual(["unchanged", "unchanged", "new"]);
    expect(classifySceneChanges(buildSceneSummaries(first + second), baseline)).toEqual(["unchanged", "unchanged"]);
  });
});
