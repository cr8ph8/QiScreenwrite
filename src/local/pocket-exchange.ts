import type { DevelopmentBeat, DevelopmentCharacter, DevelopmentResearchNote, DevelopmentRecord } from './development';
import type { AuthoringFormat, DraftRecord } from './types';
import type { WorldData } from './world';

export const MAX_POCKET_BYTES = 8 * 1024 * 1024;
export interface PocketSnapshot {
  id: string;
  title: string;
  body: string;
  genre: string;
  logline: string;
  projectFormat: AuthoringFormat | '';
  targetPages?: number;
  development: {
    concept: string; logline: string; synopsis: string; outline: string;
    beats: DevelopmentBeat[]; characters: DevelopmentCharacter[];
    worldNotes: string; researchNotes: DevelopmentResearchNote[]; world: WorldData;
  };
}
export interface PocketContinuation {
  exchangeId: string; projectId: string;
  draft: { id: string; version: number; sha256: string };
  development: { id: string; version: number; sha256: string };
}
export interface PocketPreparedTrip { exchangeId: string; contentSha256: string }
export interface PocketPreview {
  snapshot: PocketSnapshot; contentSha256: string; continuation?: PocketContinuation;
  returnReview?: { status: 'ready' | 'returned' | 'conflict'; message: string; code?: string;
    baseSnapshot?: PocketSnapshot; changedDraftFields?: string[]; changedDevelopmentFields?: string[] };
}
export interface PocketImportResult {
  mode?: 'continuation'; contentSha256: string; replayed: boolean; draft: DraftRecord; development: DevelopmentRecord;
}
