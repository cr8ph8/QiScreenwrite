import { sceneReport } from "@/lib/fountain/reports";
import { parseScreenplay, type Screenplay } from "@/lib/fountain/spec";

export interface SceneSummary {
  index: number;
  heading: string;
  charOffset: number;
  characters: string[];
  wordCount: number;
  sourceContent: string;
}

export type SceneChangeKind = "new" | "changed" | "unchanged";

/** Display readings and source coordinates come from the same lossless parser. */
export function buildSceneSummaries(text: string, screenplay?: Screenplay): SceneSummary[] {
  const document = screenplay?.source === text ? screenplay : parseScreenplay(text);
  return sceneReport(document, []).map((row, position) => {
    const scene = document.scenes[position];
    const names = new Map<string, string>();
    // Case variants are one display cue. Distinct names and story aliases stay separate.
    for (const name of row.characters) {
      const key = name.toLowerCase();
      if (!names.has(key)) names.set(key, name);
    }
    return {
      index: row.index,
      heading: row.heading,
      charOffset: scene.start,
      characters: [...names.values()],
      wordCount: row.words,
      sourceContent: text.slice(scene.start, scene.end),
    };
  });
}

/** Consume exact matches first so inserting a repeated heading does not mark
 * the saved copies edited. Remaining copies are paired by heading, once each. */
export function classifySceneChanges(current: SceneSummary[], baseline: SceneSummary[]): SceneChangeKind[] {
  const exactMatches = new Map<string, number[]>();
  baseline.forEach((scene, index) => {
    const copies = exactMatches.get(scene.sourceContent) ?? [];
    copies.push(index);
    exactMatches.set(scene.sourceContent, copies);
  });
  const unmatched = new Set(baseline.map((_, index) => index));
  const exact = current.map((scene) => {
    const match = exactMatches.get(scene.sourceContent)?.pop();
    if (match === undefined) return false;
    unmatched.delete(match);
    return true;
  });
  const remainingHeadings = new Map<string, number>();
  for (const index of unmatched) {
    const heading = baseline[index].heading;
    remainingHeadings.set(heading, (remainingHeadings.get(heading) ?? 0) + 1);
  }
  return current.map((scene, index) => {
    if (exact[index]) return "unchanged";
    const copies = remainingHeadings.get(scene.heading) ?? 0;
    if (!copies) return "new";
    remainingHeadings.set(scene.heading, copies - 1);
    return "changed";
  });
}
