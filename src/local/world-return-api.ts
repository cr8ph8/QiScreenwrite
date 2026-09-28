import { request } from './api';
import type { DevelopmentRecord } from './development';

export type WorldReturnDecision = 'keep-local' | 'use-qimovi';
export type WorldReturnField = 'name' | 'description' | 'storyFunction' | 'sensoryDetails' | 'continuity';
export interface WorldReturnItem {
  id: string; elementId: string; elementName: string; field: WorldReturnField;
  base: string | null; local: string; remote: string | null;
  state: 'unchanged' | 'local-only' | 'remote-only' | 'both-changed' | 'converged' | 'unsupported';
  selectable: boolean; reason?: string;
  remoteRecords: Array<{ id: string; version: number; sha256: string }>;
}
export interface WorldReturnPreview {
  schemaVersion: 'caniscreenwrite-world-return-preview/v1'; token: string;
  project: { id: string; title: string };
  draft: { id: string; version: number; sha256: string };
  development: { id: string; version: number; sha256: string };
  counts: { unchanged: number; localOnly: number; remoteOnly: number; bothChanged: number; converged: number; unsupported: number };
  items: WorldReturnItem[]; notes: string[];
}
export interface WorldReturnResult { changed: boolean; development: DevelopmentRecord; applied: number; kept: number; replayed: boolean }
export const worldReturnApi = {
  preview: (draftId: string) => request<WorldReturnPreview>('/api/connectors/qimovi/world-return/preview', { method: 'POST', body: JSON.stringify({ draftId }) }),
  apply: (draftId: string, token: string, choices: Array<{ id: string; decision: WorldReturnDecision }>) => request<WorldReturnResult>('/api/connectors/qimovi/world-return', { method: 'POST', body: JSON.stringify({ draftId, token, choices }) }),
};
