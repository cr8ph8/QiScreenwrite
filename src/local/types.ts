// Shapes shared by the local writer client. They mirror local/server/contracts.mjs.

export type AuthoringFormat = "vertical" | "micro" | "short" | "pilot_30" | "pilot_60" | "feature";

export interface LocalProject {
  id: string;
  title: string;
  profile: "caniscreenwrite-local-writer/v1";
  sourceHash: null;
  sourceStatus: "NO_SOURCE";
}

/** Same shape as a QiMovi creative screenplay draft (schemaVersion 2) plus an optional local logline. */
export interface ScreenplayDraftData {
  schemaVersion: 2;
  projectId: string;
  sourceHash: null;
  title: string;
  format: "FOUNTAIN";
  body: string;
  status: "DRAFT";
  genre?: string;
  projectFormat?: AuthoringFormat;
  targetPages?: number;
  logline?: string;
}

export interface QiMoviLinkRemote {
  origin: string; projectId: string; projectTitle: string; projectProfile: string; recordId: string; version: number; sha256: string;
}
export interface CompetitionLinkRemote { hostedOrigin: string; draftId: string; userId: string; entryId?: string }

export interface SyncLinkData {
  schemaVersion: 1;
  projectId: string;
  draftId: string;
  draftVersion: number;
  draftSha256: string;
  target: "qimovi" | "competition";
  remote: QiMoviLinkRemote | CompetitionLinkRemote;
  linkedAt: string;
}

export interface WorkspaceRecord<T = unknown> {
  id: string;
  kind: string;
  version: number;
  sha256: string;
  data: T;
  replayed?: boolean;
}
export type DraftRecord = WorkspaceRecord<ScreenplayDraftData>;
export type LinkRecord = WorkspaceRecord<SyncLinkData>;

export interface RecordInput<T> { id: string; kind: string; expectedVersion: number | null; requestId: string; data: T }

export interface QiMoviStatus {
  configured: boolean;
  origin: string | null;
  connected: boolean;
  project: { id: string; title: string; profile: string; sourceHash: string | null; sourceStatus: string } | null;
}
export interface QiMoviSummary extends QiMoviStatus {
  canonical: unknown;
  drafts: { id: string; version: number; sha256: string; title: string; bodyLength: number }[];
}
export interface QiMoviInstalled {
  available: boolean;
  origin?: string;
  project?: { id: string; title: string };
  directory?: string;
  reason?: string;
}
export interface QiMoviWorldTransfer {
  developmentVersion: number;
  files: { filename: string; sha256: string; recordId: string; verified: boolean }[];
}

export interface QiMoviUniverseCounts { create: number; update: number; unchanged: number; conflicts: number }
export interface QiMoviUniversePreview {
  token: string;
  project: { id: string; title: string };
  developmentVersion: number;
  counts: QiMoviUniverseCounts;
  items: { id: string; kind: string; label: string; action: 'create' | 'update' | 'unchanged' | 'conflict'; reason?: string }[];
  notes: string[];
}
export interface QiMoviUniverseTransfer {
  changed: boolean;
  project: { id: string; title: string };
  developmentVersion: number;
  records: { id: string; kind: string; version: number; sha256: string }[];
  counts: QiMoviUniverseCounts;
}

export interface Bootstrap {
  project: LocalProject;
  records: WorkspaceRecord[];
  connectors: { qimovi: QiMoviStatus };
}
