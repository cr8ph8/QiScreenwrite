import { readCharacterCue, readDirectionKind, readPageElement, readSceneHeading, type PageElementKind } from './screenplay-elements';

export type FountainElementType =
  | "scene_heading"
  | "character"
  | "parenthetical"
  | "dialogue"
  | "action"
  | "transition"
  | "page_break"
  | "title_page"
  | "empty";

export interface FountainElement {
  type: FountainElementType;
  text: string;
  /** Legacy sequential scene order; never the screenplay's printed number. */
  sceneNumber?: number;
  sourceSceneNumber?: string;
  semanticKind?: PageElementKind;
  characterName?: string;
  extensions?: string[];
}

export interface FountainStats {
  pageCount: number;
  sceneCount: number;
  wordCount: number;
  uniqueCharacters: string[];
  dialogueBlockCount: number;
  actionLineCount: number;
  characterDialogueCounts: Record<string, number>;
}

export interface FountainParseResult {
  elements: FountainElement[];
  stats: FountainStats;
  scenes: { heading: string; index: number; elementIndex: number }[];
}

const PARENTHETICAL_RE = /^\(.*\)$/;
const PAGE_BREAK_RE = /^={3,}$/;

// Strip markdown metadata blocks that AI extractors sometimes inject
const METADATA_BLOCK_RE = /^\*{0,2}(LOGLINE|CHARACTERS|GENRE|FORMAT|TITLE|AUTHOR|DRAFT|SYNOPSIS|SETTING)\s*[:*]/i;
const BULLET_CHAR_RE = /^\*\s+\*\*[A-Z]/;

function stripMetadataBlocks(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (METADATA_BLOCK_RE.test(trimmed) || BULLET_CHAR_RE.test(trimmed)) {
      skipping = true;
      continue;
    }

    // End skip block on empty line
    if (skipping && trimmed === "") {
      skipping = false;
      cleaned.push(line);
      continue;
    }

    if (skipping) continue;

    cleaned.push(line);
  }

  return cleaned.join("\n");
}

/** Strip markdown bold/italic, HTML tags, and blockquote markers injected by AI extractors */
function cleanMarkdownArtifacts(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")          // **bold** → bold
    .replace(/__(.*?)__/g, "$1")               // __underline__ → underline
    .replace(/\*(.*?)\*/g, "$1")               // *italic* → italic
    .replace(/<center>(.*?)<\/center>/gi, "$1") // <center>X</center> → X
    .replace(/<\/?[a-z][a-z0-9]*[^>]*>/gi, "") // strip remaining HTML tags
    .replace(/^> ?/gm, "")                     // > blockquote → plain
    .replace(/^#{1,6}\s+/gm, "");              // # heading markers
}

export function parseFountain(rawText: string, options: { inputMode?: 'fountain' | 'extracted' } = {}): FountainParseResult {
  if (!rawText || rawText.trim().length === 0) {
    return {
      elements: [],
      stats: { pageCount: 0, sceneCount: 0, wordCount: 0, uniqueCharacters: [], dialogueBlockCount: 0, actionLineCount: 0, characterDialogueCounts: {} },
      scenes: [],
    };
  }

  // Authored Fountain is rendered as React text by the local writer. Its
  // fictional <CHARACTER> markers must not be treated as extractor HTML.
  // Existing hosted/extracted callers retain their original cleanup behavior.
  const literalFountain = options.inputMode === 'fountain';
  const lines = (literalFountain ? rawText.replace(/\r\n?/g, '\n') : cleanMarkdownArtifacts(stripMetadataBlocks(rawText))).split("\n");
  const elements: FountainElement[] = [];
  const scenes: FountainParseResult["scenes"] = [];
  const characterDialogueCounts: Record<string, number> = {};
  let sceneCount = 0;
  let dialogueBlockCount = 0;
  let actionLineCount = 0;
  let wordCount = 0;
  let lastCharacter = "";
  let inDialogue = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      inDialogue = false;
      lastCharacter = "";
      elements.push({ type: "empty", text: "" });
      continue;
    }

    wordCount += trimmed.split(/\s+/).filter(Boolean).length;

    // Page break
    if (PAGE_BREAK_RE.test(trimmed)) {
      elements.push({ type: "page_break", text: trimmed });
      inDialogue = false;
      continue;
    }

    // The shared reader keeps printed scene numbers distinct from order.
    const heading = readSceneHeading(trimmed);
    if (heading && (!heading.forced || literalFountain)) {
      sceneCount++;
      scenes.push({ heading: trimmed, index: sceneCount, elementIndex: elements.length });
      elements.push({ type: "scene_heading", text: trimmed, sceneNumber: sceneCount, ...(heading.sceneNumber ? { sourceSceneNumber: heading.sceneNumber } : {}) });
      inDialogue = false;
      lastCharacter = "";
      continue;
    }

    // Explicit Fountain actions and lyrics cannot become character cues.
    if (literalFountain && /^[!~]/.test(trimmed)) {
      actionLineCount++;
      elements.push({ type: 'action', text: trimmed, semanticKind: trimmed.startsWith('~') ? 'lyrics' : 'action' });
      inDialogue = false; lastCharacter = '';
      continue;
    }

    const forcedCue = literalFountain && trimmed.startsWith('@');
    const forcedTransition = literalFountain && /^>(?!.*<\s*$)\s*\S/.test(trimmed);
    // Once a cue establishes a block, even words such as KITCHEN, THE END or
    // IN SLOW MOTION are spoken text. Only explicit force markers override it.
    if (inDialogue && lastCharacter && !forcedCue && !forcedTransition) {
      elements.push({ type: PARENTHETICAL_RE.test(trimmed) ? 'parenthetical' : 'dialogue', text: trimmed });
      continue;
    }

    // Directions stay display-compatible actions while exposing their meaning.
    const direction = readDirectionKind(trimmed);
    if (direction) {
      if (direction !== 'transition') actionLineCount++;
      elements.push({ type: direction === 'transition' ? 'transition' : 'action', text: trimmed, semanticKind: direction });
      inDialogue = false;
      lastCharacter = '';
      continue;
    }

    // An unforced cue needs a preceding break and immediate dialogue. Never
    // search across blank lines and accidentally enlist an action heading.
    const cue = (!trimmed.startsWith('@') || forcedCue) && (forcedCue || i === 0 || !lines[i - 1].trim()) ? readCharacterCue(trimmed, { forced: forcedCue }) : null;
    let following = i + 1;
    while (following < lines.length && PARENTHETICAL_RE.test(lines[following].trim())) following++;
    const nextText = lines[following]?.trim();
    if (cue && nextText && !readSceneHeading(nextText) && !/^[!>@#=~[*/]/.test(nextText)) {
      lastCharacter = cue.characterName;
      inDialogue = true;
      dialogueBlockCount++;
      characterDialogueCounts[lastCharacter] = (characterDialogueCounts[lastCharacter] || 0) + 1;
      elements.push({ type: 'character', text: trimmed, characterName: cue.characterName, extensions: cue.extensions });
      continue;
    }

    // Action (default)
    actionLineCount++;
    const reading = readPageElement(trimmed, 'Action');
    elements.push({ type: "action", text: trimmed, ...(reading.kind !== 'action' ? { semanticKind: reading.kind } : {}) });
    inDialogue = false;
  }

  // Guarantee at least 1 scene when there is content
  if (sceneCount === 0 && elements.some((e) => e.type !== "empty")) {
    sceneCount = 1;
    scenes.push({ heading: "SCENE 1", index: 1, elementIndex: 0 });
  }

  const uniqueCharacters = Object.keys(characterDialogueCounts).sort(
    (a, b) => characterDialogueCounts[b] - characterDialogueCounts[a]
  );

  // Rough page count (~56 lines per page in screenplay format)
  const pageCount = Math.max(1, Math.ceil(lines.length / 56));

  return {
    elements,
    stats: {
      pageCount,
      sceneCount,
      wordCount,
      uniqueCharacters,
      dialogueBlockCount,
      actionLineCount,
      characterDialogueCounts,
    },
    scenes,
  };
}
