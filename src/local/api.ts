// Client for the local writer service (local/server/http.mjs). Same-origin
// only: the page is served by that service, or proxied to it by Vite in dev.
import { canonicalJson, RECORD_ID, type RecoveryCopy } from "./model";
import type { Bootstrap, QiMoviInstalled, QiMoviStatus, QiMoviSummary, QiMoviWorldTransfer, QiMoviUniversePreview, QiMoviUniverseTransfer, RecordInput, WorkspaceRecord, LinkRecord } from "./types";
import type { DevelopmentRecovery } from "./development";
import type { PreservationPreview, PreservationVerification } from './preservation';
import type { LibraryCatalog, LibraryPreview, LibraryImportInput, LibraryImportResult } from './library-import';
import type { PocketPreview, PocketImportResult, PocketPreparedTrip } from './pocket-exchange';

export const SESSION_LOST_EVENT = "local-writer:session-lost";

export class LocalApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) { super(message); }
}

const MESSAGES: Record<string, string> = {
  BRAND_SOURCE_CHANGED: 'The saved draft changed. Scan and review the new revision before continuing.',
  BRAND_TRANSFER_REQUIRED: 'Transfer this saved revision through Connect → QiMovi before reading financing.',
  BRAND_TRANSFER_DIVERGED: 'The connected draft or project differs from the last transfer. Review the connection and transfer before continuing.',
  BRAND_CONTEXT_UNVERIFIED: 'The financing response could not be verified against this exact revision.',
  BRAND_SOURCE_TOO_LARGE: 'The placement scanner supports saved screenplays up to 800,000 UTF-8 bytes.',

  ANALYSIS_ENDPOINT_INVALID: 'Use Ollama on this Mac, for example http://127.0.0.1:11434. External hosts and redirects are not accepted here.',
  ANALYSIS_MODEL_UNAVAILABLE: 'Ollama did not answer. Start your local Ollama service, check its address, then refresh installed models.',
  ANALYSIS_LOCAL_MODEL_REQUIRED: 'Choose an installed local model. Remote and cloud-backed models cannot use the local route.',
  ANALYSIS_CONTEXT_TOO_SMALL: 'This model cannot fit the reviewed text and response. Choose a model with a larger context or analyze a shorter draft.',
  ANALYSIS_DRAFT_CHANGED: 'The saved screenplay changed. Review the latest text before running analysis.',
  ANALYSIS_EXCERPT_CHANGED: 'The passage no longer matches the saved screenplay. Review it again.',
  ANALYSIS_BUSY: 'Another local analysis is running. Refresh saved reports before starting another.',
  ANALYSIS_REPLAY_MISMATCH: 'This request identity belongs to different text or settings. Review the request again.',
  ANALYSIS_RECEIPT_INVALID: 'A saved analysis receipt could not be verified. Its file has been preserved.',
  POCKET_CHECKSUM_MISMATCH: 'The snapshot bytes do not match their checksum. Nothing was imported.',
  POCKET_PREVIEW_MISMATCH: 'The snapshot changed after preview. Choose and preview the file again.',
  POCKET_SIZE_INVALID: 'Choose a nonempty .qiscript snapshot no larger than 8 MiB.',
  POCKET_PAYLOAD_TOO_LARGE: 'The decoded snapshot exceeds 4 MiB. Nothing was imported.',
  POCKET_JSON_INVALID: 'Choose a valid UTF-8 JSON .qiscript snapshot.',
  POCKET_SCHEMA_INVALID: 'This file is not a supported iPhone creative snapshot.',
  SCREENPLAY_DRAFT_TITLE_INVALID: 'Desktop drafts need a nonempty, single-line title of at most 200 characters. Edit the title on the source device and export again.',
  QIMOVI_LIBRARY_STALE: 'The connected project or source changed. Load the Library and preview the original again.',
  QIMOVI_LIBRARY_PREVIEW_EXPIRED: 'This review expired or the service restarted. Preview the original again; saved imports remain in My drafts.',
  QIMOVI_LIBRARY_ALREADY_IMPORTED: 'This original already has a local working draft. Load the Library and open that draft to keep editing.',
  QIMOVI_LIBRARY_BYTES_MISMATCH: 'The original file did not match its saved checksum. Nothing was imported.',
  SOURCE_UTF8_REQUIRED: 'Use a UTF-8 Fountain, text or Final Draft file. This original could not be decoded safely.',
  SOURCE_FDX_INVALID: 'Choose a valid Final Draft script without document-type or entity declarations.',
  SOURCE_CONVERSION_INVALID: 'The conversion does not match the reviewed source format. Preview the original again.',
  SOURCE_SIZE_INVALID: 'Retained screenplay originals must be nonempty and no larger than 1 MiB.',
  SOURCE_EMPTY_DRAFT: 'The converted screenplay is empty. Review the original before creating a draft.',
  RIGHTS_SOURCE_CHANGED: 'A linked source changed. Review the latest saved revision before continuing.',
  RIGHTS_EVIDENCE_SIZE_INVALID: 'Choose a nonempty evidence file no larger than 1 MiB.',
  RIGHTS_EVIDENCE_MISSING: 'A supporting file is missing from this workspace. Attach its original bytes before saving.',
  RIGHTS_RECOVERY_NEWER: 'A newer rights recovery copy exists. Refresh and review it before replacing anything.',
  TOKEN_PREVIEW_CHANGED: 'The public metadata changed. Review the preview again before exporting.',
  TOKEN_PUBLIC_URI_INVALID: 'Use a public HTTPS or IPFS address without credentials, query strings or fragments.',
  TOKEN_PUBLIC_NAME_REQUIRED: 'Give the public metadata a name before exporting.',
  BACKUP_RECORD_CHECKSUM_MISMATCH: "A saved record no longer matches its checksum. This file did not pass verification; compare it with another saved copy.",
  BACKUP_CHECKSUM_MISMATCH: "The saved history checksum does not match. This file did not pass verification.",
  BACKUP_HISTORY_INVALID: "This file has missing or inconsistent saved revisions. It did not pass verification.",
  PRESERVATION_SOURCE_CHANGED: "Saved work changed since this inventory was reviewed. Refresh the inventory, then export again.",
  PRESERVATION_TOO_LARGE: "This package exceeds the 128 MiB preservation limit.",
  PRESERVATION_SCHEMA_INVALID: "Choose a QiCanIScreenwrite preservation package exported by this app.",
  PRESERVATION_CHECKSUM_MISMATCH: "The package checksum does not match. Keep the file and compare it with another saved copy.",
  PRESERVATION_INVENTORY_MISMATCH: "The package inventory does not match its saved records.",
  PRESERVATION_SOURCE_MISMATCH: "The package source fingerprint does not match its saved history.",
  OWNER_SESSION_REQUIRED: "Sign in to the local workspace first.",
  OWNER_TOKEN_REJECTED: "That owner token or login link was not accepted.",
  VERSION_CONFLICT: "This draft changed elsewhere since you opened it. Reload it before saving again.",
  REQUEST_ID_CONFLICT: "A different save already used this request. Reload the draft.",
  QIMOVI_NOT_CONFIGURED: "Open the film in QiMovi, then choose Find open QiMovi project.",
  QIMOVI_DISCOVERY_TIMEOUT: "Finding QiMovi took too long. Your writing service is still available. Open the project in QiMovi and try again.",
  QIMOVI_DISCOVERY_BUSY: "A previous QiMovi discovery is still closing. Try again shortly.",
  QIMOVI_UNREACHABLE: "QiMovi is not answering. Open the project in QiMovi (or run its local service) and try again.",
  QIMOVI_OWNER_TOKEN_REJECTED: "QiMovi rejected the owner token. Check the token in that project's config.json.",
  QIMOVI_VERSION_CONFLICT: "QiMovi has a newer revision of this draft. Pull it first, then push again.",
  QIMOVI_CREATIVE_PROJECT_RECORD_REQUIRES_SCREENPLAY: "That QiMovi project cannot hold a writing draft of this kind.",
  LOCAL_APP_NOT_BUILT: "Build the local app first (npm run build:local).",
  RECOVERY_CONFLICT: "A newer recovery copy exists. Reopen recovery before replacing or discarding it.",
  RECOVERY_LIMIT_REACHED: "Recovery storage is full. Save or discard an existing recovery copy before adding another.",
  RECOVERY_BASE_UNKNOWN: "This recovery copy refers to a saved revision that is not in this workspace.",
  RECOVERY_PENDING_SAVE_CONFLICT: "The recovery request differs from a save already recorded in this workspace. Keep the recovery copy and review the saved history.",
};

let nativeRestoration: Promise<boolean> | null = null;

/** The host installs an owner session in its cookie store. No owner credential
 * crosses this bridge or enters JavaScript. Concurrent requests share one try. */
function restoreNativeSession(): Promise<boolean> {
  const host = window as Window & { webkit?: { messageHandlers?: { writerSession?: { postMessage(value: { action: "restore" }): void } } } };
  const bridge = host.webkit?.messageHandlers?.writerSession;
  if (!bridge) return Promise.resolve(false);
  if (nativeRestoration) return nativeRestoration;
  const pending = new Promise<boolean>((resolve) => {
    const done = (restored: boolean) => { clearTimeout(timeout); window.removeEventListener("writer:session-restored", onRestored); resolve(restored); };
    const onRestored = () => done(true);
    const timeout = window.setTimeout(() => done(false), 5000);
    window.addEventListener("writer:session-restored", onRestored, { once: true });
    try { bridge.postMessage({ action: "restore" }); } catch { done(false); }
  });
  nativeRestoration = pending;
  void pending.finally(() => { if (nativeRestoration === pending) nativeRestoration = null; });
  return pending;
}

export async function request<T>(path: string, init: RequestInit = {}, retryNative = true): Promise<T> {
  let response: Response;
  let data: { error?: string; detail?: string } | null;
  // Discovery can encounter unavailable files. Keep connection controls bounded
  // even when the service itself stalls; this deadline does not wrap transfers.
  const isConnectionControl = /^\/api\/connectors\/qimovi(?:\/(?:installed|connect))?$/.test(path);
  const controller = isConnectionControl ? new AbortController() : null;
  const deadline = controller ? window.setTimeout(() => controller.abort(), 30_000) : null;
  try {
    response = await fetch(path, { ...init, ...(controller ? { signal: controller.signal } : {}), credentials: "same-origin", redirect: "error", headers: { Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
    data = await response.json().catch(error => { if (controller?.signal.aborted) throw error; return null; });
  } catch (error) {
    if (controller?.signal.aborted) throw new LocalApiError("The connection check timed out. Your saved writing remains on this Mac. Reopen the local writer if it is not responding, then retry.", 0, "CONNECTION_TIMEOUT");
    throw new LocalApiError("The local writer service is not answering. Reopen QiCanIScreenwrite, then retry. Your saved work stays on this Mac.", 0, "SERVICE_UNREACHABLE");
  } finally { if (deadline !== null) window.clearTimeout(deadline); }
  if (!response.ok) {
    const code = typeof data?.error === "string" ? data.error : "REQUEST_REJECTED";
    if (code === "OWNER_SESSION_REQUIRED" && !path.startsWith("/api/session") && retryNative && await restoreNativeSession()) {
      return request<T>(path, init, false);
    }
    // The service keeps one session: a newer login elsewhere, or expiry, ends this one. Let the shell relock.
    if (code === "OWNER_SESSION_REQUIRED" && !path.startsWith("/api/session")) window.dispatchEvent(new CustomEvent(SESSION_LOST_EVENT));
    throw new LocalApiError(MESSAGES[code] ?? (typeof data?.detail === "string" ? data.detail : `The local service rejected this request (${code}).`), response.status, code);
  }
  return data as T;
}

function assertRecord(value: unknown): WorkspaceRecord {
  const record = value as WorkspaceRecord;
  if (!record || typeof record !== "object" || !RECORD_ID.test(String(record.id)) || typeof record.kind !== "string" || !Number.isInteger(record.version) || !/^[a-f0-9]{64}$/.test(String(record.sha256)) || !record.data || typeof record.data !== "object") {
    throw new LocalApiError("The local service returned an invalid record.", 502, "INVALID_RECORD");
  }
  return record;
}

export const localApi = {
  pocket: {
    prepare: (draftId: string) => request<PocketPreparedTrip>('/api/pocket-exchange/prepare', { method: 'POST', body: JSON.stringify({ draftId }) }),
    linkedUrl: (exchangeId: string) => `/api/pocket-exchange/linked?exchangeId=${encodeURIComponent(exchangeId)}`,
    returnLinked: (fileText: string, contentSha256: string) => request<PocketImportResult>('/api/pocket-exchange/return', { method: 'POST', body: fileText, headers: { 'X-Pocket-Content-Sha256': contentSha256 } }),
    exportUrl: (draftId: string) => `/api/pocket-exchange/export?draftId=${encodeURIComponent(draftId)}`,
    // Keep the file text intact: parsing and re-serializing here would hide
    // duplicate JSON members before the service can reject them.
    preview: (fileText: string) => request<PocketPreview>('/api/pocket-exchange/preview', { method: 'POST', body: fileText }),
    import: (fileText: string, contentSha256: string) => request<PocketImportResult>('/api/pocket-exchange/import', { method: 'POST', body: fileText, headers: { 'X-Pocket-Content-Sha256': contentSha256 } }),
  },
  rights: {
    attachEvidence: (input: { name: string; mediaType: string; base64: string }) => request<import('./types').WorkspaceRecord<import('./rights').EvidenceData>>('/api/rights/evidence', { method: 'POST', body: JSON.stringify(input) }),
    worksheet: (ref: import('./rights').RightsRef) => request<Record<string, unknown>>('/api/rights/worksheet', { method: 'POST', body: JSON.stringify(ref) }),
    tokenPreview: (ref: import('./rights').RightsRef) => request<import('./rights').TokenPreview>('/api/rights/token-preview', { method: 'POST', body: JSON.stringify(ref) }),
    tokenExport: (recordRef: import('./rights').RightsRef, metadataSha256: string) => request<Record<string, unknown>>('/api/rights/token-export', { method: 'POST', body: JSON.stringify({ recordRef, metadataSha256 }) }),
    recovery: {
      get: () => request<import('./rights').RightsRecovery | null>('/api/rights/recovery'),
      put: (value: import('./rights').RightsRecovery) => request<import('./rights').RightsRecovery>('/api/rights/recovery', { method: 'PUT', body: JSON.stringify(value) }),
      clear: (savedAt: string) => request('/api/rights/recovery?savedAt=' + encodeURIComponent(savedAt), { method: 'DELETE' }),
    },
  },
  preservation: {
    preview: () => request<PreservationPreview>('/api/preservation'),
    export: (sourceSha256: string) => request<unknown>('/api/preservation/export', { method: 'POST', body: JSON.stringify({ sourceSha256 }) }),
    verify: (value: unknown) => request<PreservationVerification>('/api/preservation/verify', { method: 'POST', body: JSON.stringify(value) }),
  },
  /** Use this ordinary same-origin link for WebKit/native downloads. */
  backupUrl: "/api/backup",
  developmentRecovery: {
    list: () => request<DevelopmentRecovery[]>("/api/development-recovery"),
    get: (draftId: string) => request<DevelopmentRecovery | null>(`/api/development-recovery/${encodeURIComponent(draftId)}`),
    put: (copy: DevelopmentRecovery) => request<DevelopmentRecovery>(`/api/development-recovery/${encodeURIComponent(copy.draftId)}`, { method: "PUT", body: JSON.stringify(copy) }),
    remove: (draftId: string, savedAt?: string) => request<{ deleted: boolean }>(`/api/development-recovery/${encodeURIComponent(draftId)}${savedAt === undefined ? "" : `?savedAt=${encodeURIComponent(savedAt)}`}`, { method: "DELETE" }),
  },
  recovery: {
    list: () => request<RecoveryCopy[]>("/api/recovery"),
    get: (draftId: string) => request<RecoveryCopy | null>(`/api/recovery/${encodeURIComponent(draftId)}`),
    put: (copy: RecoveryCopy) => request<RecoveryCopy>(`/api/recovery/${encodeURIComponent(copy.draftId)}`, { method: "PUT", body: JSON.stringify(copy) }),
    remove: (draftId: string, savedAt?: string) => request<{ deleted: boolean }>(`/api/recovery/${encodeURIComponent(draftId)}${savedAt === undefined ? "" : `?savedAt=${encodeURIComponent(savedAt)}`}`, { method: "DELETE" }),
  },
  health: () => request<{ status: string; mode: string }>("/api/health"),
  login: (credential: { token: string } | { loginNonce: string }) => request<{ authenticated: true; method: string }>("/api/session", { method: "POST", body: JSON.stringify(credential) }),
  logout: () => request<{ authenticated: false }>("/api/session", { method: "DELETE" }),
  bootstrap: async (): Promise<Bootstrap> => {
    const value = await request<Bootstrap>("/api/bootstrap");
    value.records.forEach(assertRecord);
    return value;
  },
  history: async (id: string): Promise<WorkspaceRecord[]> => {
    if (!RECORD_ID.test(id)) throw new LocalApiError("Invalid record identity.", 400, "INVALID_RECORD_ID");
    const values = await request<unknown[]>(`/api/records/${encodeURIComponent(id)}/history`);
    const records = values.map(assertRecord);
    if (records.some((record, index) => record.id !== id || record.version !== index + 1)) throw new LocalApiError("The local history does not match this record.", 502, "INVALID_HISTORY");
    return records;
  },
  /** Save with CAS. The echoed record must match what was sent, or the save is treated as unconfirmed. */
  save: async <T>(input: RecordInput<T>): Promise<WorkspaceRecord<T>> => {
    const { id, ...body } = JSON.parse(canonicalJson(input)) as RecordInput<T>;
    const expected = canonicalJson(body.data);
    const record = assertRecord(await request(`/api/records/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) })) as WorkspaceRecord<T>;
    if (record.id !== id || record.kind !== body.kind || canonicalJson(record.data) !== expected || record.version !== (body.expectedVersion ?? 0) + 1) {
      throw new LocalApiError("The local service answered, but its saved record does not match this save. Reload before continuing.", 502, "SAVE_UNCONFIRMED");
    }
    return record;
  },
  qimovi: {
    library: {
      list: () => request<LibraryCatalog>('/api/connectors/qimovi/library'),
      preview: (recordId: string) => request<LibraryPreview>('/api/connectors/qimovi/library/preview', { method: 'POST', body: JSON.stringify({ recordId }) }),
      import: (input: LibraryImportInput) => request<LibraryImportResult>('/api/connectors/qimovi/library/import', { method: 'POST', body: JSON.stringify(input) }),
    },
    previewUniverse: (draftId: string) => request<QiMoviUniversePreview>("/api/connectors/qimovi/universe/preview", { method: "POST", body: JSON.stringify({ draftId }) }),
    pushUniverse: (draftId: string, token: string) => request<QiMoviUniverseTransfer>("/api/connectors/qimovi/universe", { method: "POST", body: JSON.stringify({ draftId, token }) }),
    installed: () => request<QiMoviInstalled>("/api/connectors/qimovi/installed"),
    configureInstalled: (projectId: string) => request<QiMoviStatus>("/api/connectors/qimovi/installed", { method: "POST", body: JSON.stringify({ projectId }) }),
    pushWorld: (draftId: string) => request<QiMoviWorldTransfer>("/api/connectors/qimovi/world", { method: "POST", body: JSON.stringify({ draftId }) }),
    status: () => request<QiMoviStatus>("/api/connectors/qimovi"),
    configure: (input: { origin: string; ownerToken: string }) => request<QiMoviStatus>("/api/connectors/qimovi/config", { method: "PUT", body: JSON.stringify(input) }),
    clear: () => request<QiMoviStatus>("/api/connectors/qimovi/config", { method: "DELETE" }),
    connect: () => request<QiMoviSummary>("/api/connectors/qimovi/connect", { method: "POST", body: "{}" }),
    push: (draftId: string) => request<{ changed: boolean; remote: { id: string; version: number; sha256: string }; link: LinkRecord }>("/api/connectors/qimovi/push", { method: "POST", body: JSON.stringify({ draftId }) }),
    pull: (remoteRecordId: string, draftId?: string) => request<{ changed: boolean; local: { id: string; version: number; sha256: string }; link: LinkRecord }>("/api/connectors/qimovi/pull", { method: "POST", body: JSON.stringify({ remoteRecordId, draftId: draftId ?? remoteRecordId }) }),
  },
};
