/** A reading aid, not a source converter. Callers keep the original text, type
 * and ranges. Text-derived specializations are explicitly marked inferred. */
export type PageElementKind = 'scene_heading' | 'action' | 'character' | 'dialogue' | 'parenthetical' | 'transition' | 'intercut' | 'subheader' | 'shot' | 'lyrics' | 'general' | 'empty';
export interface PageElementReading {
    kind: PageElementKind;
    label: string;
    description: string;
    characterName?: string;
    extensions?: string[];
    sceneNumber?: string;
    inferred?: boolean;
}
export interface CharacterCueReading {
    characterName: string;
    extensions: string[];
}
export declare function readSceneHeading(text: string): {
    heading: string;
    sceneNumber?: string;
    forced: boolean;
} | null;
/** These forms are intentionally bounded. An unmarked arbitrary place name
 * cannot reliably be distinguished from a character without author review. */
export declare function readDirectionKind(text: string): 'transition' | 'intercut' | 'subheader' | 'shot' | null;
export declare function readCharacterCue(text: string, options?: {
    forced?: boolean;
}): CharacterCueReading | null;
export declare function readPageElement(text: string, declaredType?: string): PageElementReading;
