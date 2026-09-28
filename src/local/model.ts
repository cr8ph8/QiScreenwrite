// Pure helpers for the local writer: identities, canonical hashing, draft
// shaping, templates and the unsaved-work recovery format. No I/O.
import type { AuthoringFormat, DraftRecord, LinkRecord, ScreenplayDraftData, WorkspaceRecord } from "./types";

export const DRAFT_KIND = "screenplay-draft";
export const LINK_KIND = "sync-link";
export const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export const MAX_BODY_LENGTH = 200000;

export const FORMAT_LABELS: Record<AuthoringFormat, string> = {
  vertical: "Vertical / social",
  micro: "Micro short",
  short: "Short film",
  pilot_30: "30-minute pilot",
  pilot_60: "60-minute pilot",
  feature: "Feature",
};

export const newDraftId = () => `${DRAFT_KIND}:${crypto.randomUUID()}`;
export const draftSuffix = (draftId: string) => draftId.slice(DRAFT_KIND.length + 1);
export const linkId = (target: "qimovi" | "competition", draftId: string) => `${LINK_KIND}:${target}:${draftSuffix(draftId)}`;

/** Browser counterpart of local/server/storage.mjs canonicalJson. Same bytes, same hashes. */
export function canonicalJson(value: unknown): string {
  // Match server budgets for exact worlds, development v2 and recognized
  // envelopes. This cheap shape check grants size, never contract authority.
  const shape = (item: unknown, keys: string[]): item is Record<string, unknown> => item !== null && typeof item === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(item))
    && Reflect.ownKeys(item).length === keys.length && keys.every(key => {
      const property = Object.getOwnPropertyDescriptor(item, key);
      return property?.enumerable && Object.prototype.hasOwnProperty.call(property, 'value');
    });
  const developmentKeys = ['schemaVersion', 'projectId', 'draftId', 'concept', 'logline', 'synopsis', 'outline', 'beats', 'characters', 'worldNotes', 'researchNotes', 'world'];
  const worldV1 = (item: unknown) => shape(item, ['schemaVersion', 'elements', 'links']) && item.schemaVersion === 1
    && Array.isArray(item.elements) && Array.isArray(item.links);
  const worldV2 = (item: unknown) => (shape(item, developmentKeys) && item.schemaVersion === 2
    || shape(item, [...developmentKeys, 'worldSources']) && item.schemaVersion === 3 && Array.isArray(item.worldSources))
    && worldV1(item.world)
    && ['beats', 'characters', 'researchNotes'].every(key => Array.isArray(item[key]));
  const sharedWorld = (item: unknown) => shape(item, ['schemaVersion', 'projectId', 'name', 'description', 'world']) && item.schemaVersion === 1 && worldV1(item.world);
  const requestKeys = ['id', 'kind', 'expectedVersion', 'requestId', 'data'];
  const request = (item: unknown): item is Record<string, unknown> => shape(item, requestKeys) && ['story-development', 'shared-world'].includes(String(item.kind));
  const record = (item: unknown) => (
    request(item)
    || shape(item, ['kind', 'expectedVersion', 'requestId', 'data'])
    || shape(item, ['id', 'kind', 'version', 'sha256', 'data'])
    || shape(item, ['id', 'kind', 'version', 'sha256', 'data', 'replayed'])
  ) && (item.kind === 'story-development' && worldV2(item.data) || item.kind === 'shared-world' && sharedWorld(item.data));
  const recovery = (item: unknown) => shape(item, ['schema', 'projectId', 'draftId', 'baseVersion', 'baseSha256', 'data', 'pendingSave', 'savedAt'])
    && item.schema === 'caniscreenwrite-story-development-recovery/v1'
    && (worldV2(item.data) || (request(item.pendingSave) && item.pendingSave.kind === 'story-development' && worldV2(item.pendingSave.data)));
  const largeWorld = worldV1(value) || worldV2(value) || sharedWorld(value) || record(value) || recovery(value);
  const maxNodes = largeWorld ? 40000 : 10000;
  const maxBytes = (largeWorld ? 4 : 2) * 1024 * 1024;
  let nodes = 0;
  const normalize = (item: unknown, depth: number): unknown => {
    if (depth > 32 || ++nodes > maxNodes) throw new Error("The record exceeds canonical JSON limits.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw new Error("The record contains a non-canonical number.");
      return item;
    }
    if (Array.isArray(item)) return item.map((child) => normalize(child, depth + 1));
    if (!item || typeof item !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("The record contains a non-JSON value.");
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("The record contains a forbidden JSON key.");
      const child = (item as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = normalize(child, depth + 1);
    }
    return output;
  };
  const serialized = JSON.stringify(normalize(value, 0));
  // At most three UTF-8 bytes per serialized UTF-16 code unit. Avoid an extra
  // allocation on ordinary per-keystroke fingerprints that safely fit.
  if (serialized.length > maxBytes || (serialized.length * 3 > maxBytes && new TextEncoder().encode(serialized).length > maxBytes)) throw new Error("The record exceeds canonical JSON limits.");
  return serialized;
}

export async function hashCanonical(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface DraftFields {
  title: string;
  body: string;
  genre?: string;
  projectFormat?: AuthoringFormat | "";
  targetPages?: number | "" | null;
  logline?: string;
}

/** Build the exact record body. Empty optional fields are omitted, not sent as empty strings. */
export function buildDraftData(projectId: string, fields: DraftFields): ScreenplayDraftData {
  const data: ScreenplayDraftData = {
    schemaVersion: 2, projectId, sourceHash: null,
    title: fields.title.trim() || "Untitled screenplay",
    format: "FOUNTAIN", body: fields.body, status: "DRAFT",
  };
  if (fields.genre?.trim()) data.genre = fields.genre.trim().slice(0, 120);
  if (fields.projectFormat) data.projectFormat = fields.projectFormat;
  if (typeof fields.targetPages === "number" && Number.isInteger(fields.targetPages) && fields.targetPages >= 1 && fields.targetPages <= 1000) data.targetPages = fields.targetPages;
  if (fields.logline?.trim()) data.logline = fields.logline.trim().slice(0, 1000);
  return data;
}

export function fieldsFromData(data: ScreenplayDraftData): Required<DraftFields> {
  return { title: data.title, body: data.body, genre: data.genre ?? "", projectFormat: data.projectFormat ?? "", targetPages: data.targetPages ?? "", logline: data.logline ?? "" };
}

export const isDraft = (record: WorkspaceRecord): record is DraftRecord => record.kind === DRAFT_KIND;
export const isLink = (record: WorkspaceRecord): record is LinkRecord => record.kind === LINK_KIND;

export function linksFor(records: WorkspaceRecord[], draftId: string): LinkRecord[] {
  return records.filter(isLink).filter((link) => link.data.draftId === draftId);
}

/** Sort drafts by most recent activity: highest version first, then title. Versions are the only local clock. */
export function sortDrafts(drafts: DraftRecord[]): DraftRecord[] {
  return [...drafts].sort((a, b) => b.version - a.version || a.data.title.localeCompare(b.data.title));
}

export interface RecoveryCopy {
  schema: "caniscreenwrite-local-writer-recovery/v1";
  draftId: string;
  baseVersion: number | null;
  baseSha256: string | null;
  data: ScreenplayDraftData;
  savedAt: string;
}
export const recoveryKey = (draftId: string) => `caniscreenwrite-local-writer:recovery:${draftId}`;

export function readRecovery(storage: Pick<Storage, "getItem">, draftId: string): RecoveryCopy | null {
  try {
    const raw = storage.getItem(recoveryKey(draftId));
    if (!raw) return null;
    const copy = JSON.parse(raw) as RecoveryCopy;
    return copy && copy.schema === "caniscreenwrite-local-writer-recovery/v1" && copy.draftId === draftId && copy.data?.format === "FOUNTAIN" ? copy : null;
  } catch { return null; }
}

/** A recovery copy matters only if it differs from the saved revision it was based on. */
export function recoveryIsUseful(copy: RecoveryCopy | null, saved: DraftRecord | null): boolean {
  if (!copy) return false;
  if (!saved) return copy.data.body.trim().length > 0;
  return canonicalJson(copy.data) !== canonicalJson(saved.data);
}

export const TEMPLATES: { id: string; label: string; projectFormat: AuthoringFormat; body: string }[] = [
  { id: "blank", label: "Blank page", projectFormat: "short", body: "" },
  { id: "short", label: "Short film", projectFormat: "short", body: `Title: Untitled Short\nCredit: Written by\nAuthor: \n\nFADE IN:\n\nINT. LOCATION - DAY\n\nA character enters. Something is already wrong.\n\nCHARACTER\nOne line that tells us who they are.\n\nEXT. SOMEWHERE ELSE - NIGHT\n\nThe choice that costs them.\n\nFADE OUT.\n` },
  { id: "pilot_30", label: "30-minute pilot", projectFormat: "pilot_30", body: `Title: Untitled Pilot\nCredit: Written by\nAuthor: \n\n# COLD OPEN\n\nINT. LOCATION - DAY\n\nHook the audience before the titles.\n\n# ACT ONE\n\nINT. LOCATION - LATER\n\nThe world, the want, the complication.\n\n# ACT TWO\n\nINT. LOCATION - NIGHT\n\nEverything gets harder.\n\n# TAG\n\nINT. LOCATION - CONTINUOUS\n\nOne last turn.\n` },
  { id: "feature", label: "Feature", projectFormat: "feature", body: `Title: Untitled Feature\nCredit: Written by\nAuthor: \n\n# ACT ONE\n\nFADE IN:\n\nEXT. OPENING IMAGE - DAY\n\nThe world before the story.\n\n# ACT TWO\n\nINT. THE MIDPOINT - NIGHT\n\nThe false victory or false defeat.\n\n# ACT THREE\n\nEXT. FINAL IMAGE - DAWN\n\nThe world after.\n\nFADE OUT.\n` },
];

export function downloadText(filename: string, text: string, mime = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.rel = "noopener";
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFilename = (title: string) => (title.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "screenplay").slice(0, 80);
