# Local writer backup and recovery interfaces

Implemented in `backup.mjs`, `recovery.mjs`, `http.mjs` and `src/local/api.ts`.
These endpoints share the existing owner session, exact Host and same-origin
rules. Mutations require the exact Origin; PUT requires JSON. Nothing is sent
to an external service by backup or recovery.

## Portable saved-history backup

`GET /api/backup` returns JSON with `Content-Disposition: attachment;
filename="caniscreenwrite-workspace-backup.json"` and `Cache-Control: no-store`.
Use an ordinary `<a href="/api/backup" download>` (or `localApi.backupUrl`)
so the native desktop download handler receives a normal navigation. The owner
cookie authenticates it; navigation does not require an Origin header.

Envelope: `{schema: "caniscreenwrite-local-writer-backup/v1", createdAt,
project, records, sha256}`. `records` includes every immutable revision as
`{id, kind, version, sha256, data}`, including sync receipts and story development.
Record checksums use the existing canonical JSON. The manifest checksum is
SHA-256 of canonical JSON plus newline for `{schema, createdAt, project,
recordCount}`, followed by each full record envelope in exported order plus
newline. Limits: 128 MiB and 100,000 revisions. Export errors rather than truncates.

Owner/connector credentials, sessions, request replay receipts and unsaved
recovery are excluded. Backup includes authored saved content, not a scrubbed
version of that content. Hashes detect corruption; they are not a signature
proving who authored the backup.

Stopped-workspace CLI:

```sh
node local/server/cli.mjs backup --data /absolute/workspace --out /absolute/backup.json
node local/server/cli.mjs restore --data /absolute/NEW-workspace --file /absolute/backup.json
```

Backup refuses any existing output file, including symlinks. It acquires the
workspace lock; use HTTP export while the service is running. Restore requires
an explicit new destination whose parent exists, refuses existing files,
directories and symlinks, and validates schema, project, every record contract,
version sequence, identity, per-record hash, referenced revision and manifest
checksum before creating the destination. SQLite commits project and revisions
together. Configuration is published last with a fresh owner token, never
printed. Saved project identity, record IDs, versions, hashes and text are
preserved. Connectors must be configured again. A failed restore cleans up only
the new directory reserved by that invocation. No changes to CLI `serve` behavior.

## Persistent unsaved recovery

`GET /api/recovery` returns `RecoveryCopy[]`, including never-saved drafts.
`GET /api/recovery/:draftId` returns the copy or JSON `null`.
`PUT /api/recovery/:draftId` accepts and returns the exact existing model shape:

```json
{
  "schema": "caniscreenwrite-local-writer-recovery/v1",
  "draftId": "screenplay-draft:example",
  "baseVersion": null,
  "baseSha256": null,
  "data": {
    "schemaVersion": 2,
    "projectId": "local-writer:example",
    "sourceHash": null,
    "title": "Unsaved screenplay",
    "format": "FOUNTAIN",
    "body": "",
    "status": "DRAFT"
  },
  "savedAt": "2026-09-26T12:00:00.000Z"
}
```

The project must match the workspace. Non-null base version/hash must match
one retained draft revision (an older base is allowed for conflict recovery).
Timestamp must be canonical ISO UTC, at most five minutes in the future.
Recovery is bounded to 100 copies, 32 MiB total canonical JSON, 2 MiB per
request/copy, with the existing 200,000-character screenplay body bound.
Overflow returns an error without evicting copies. Older PUTs, or different
content with the same timestamp, return `409 RECOVERY_CONFLICT`; exact retries
are accepted. Server receive timestamps and stored SHA-256 protect ordering and
integrity on disk. Draft identifiers are validated and used only as SQL values,
never as filenames. Recovery lives in a mutable `recovery` table separate from
immutable `records` and `requests`, so it survives server/desktop restart and
changed ports/origins without creating a save revision.

`DELETE /api/recovery/:draftId` returns `{deleted: boolean}`. Optional
`?savedAt=<encoded timestamp>` refuses deletion if a newer copy exists.
Deletion is explicit; saves/export/restarts never automatically delete recovery.
Clients should retain browser copies until a confirmed save or explicit recovery
decision, and should avoid replacing useful unresolved copies automatically.

Exact client signatures:

```ts
localApi.recovery.list(): Promise<RecoveryCopy[]>
localApi.recovery.get(draftId: string): Promise<RecoveryCopy | null>
localApi.recovery.put(copy: RecoveryCopy): Promise<RecoveryCopy>
localApi.recovery.remove(draftId: string, savedAt?: string): Promise<{deleted: boolean}>
```

`RecoveryCopy` is imported from `src/local/model.ts`. On
`OWNER_SESSION_REQUIRED`, the client uses the guarded native
`window.webkit.messageHandlers.writerSession.postMessage({action: "restore"})`
when available, waits up to five seconds for `writer:session-restored`, and
retries the identical request once. Concurrent failures share the restoration
attempt. The native host sets the cookie; no owner tokens enter JavaScript.
Failed restoration or a rejected retry emits `local-writer:session-lost`.

## Validation

Story development also uses authenticated `GET /api/development-recovery` and
`GET/PUT/DELETE /api/development-recovery/:draftId`. Its existing
`caniscreenwrite-story-development-recovery/v1` envelope retains project/draft
identity, saved base, working data, and an uncertain pending save independently.
It requires a saved screenplay, validates pending request receipts, and uses the
same copy/count/byte limits and conditional deletion semantics. Its separate
`development_recovery` SQLite table also survives a changed origin. The native
host waits for screenplay and development recovery flushes before normal quit.

The client exposes `localApi.developmentRecovery.list/get/put/remove` with the
same call pattern as screenplay recovery. A reconnect within a running desktop
session reuses the prior service port and keeps the active page intact; only a
fresh app launch selects a new free port.

`node --test local/tests/*.test.mjs` exercises backup corruption/refusal,
development references, credential exclusion, history preservation, recovery
quotas/base/project checks, changed-origin restart, native retry behavior,
initializer locking and server shutdown/startup cleanup. All fixtures use
temporary directories; production workspaces are not test inputs.
