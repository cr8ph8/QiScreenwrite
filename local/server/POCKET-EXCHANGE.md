# Explicit iPhone snapshot exchange

Contract: `iphone/CONTRACT.md`. This is a local file transfer available from the
global Connections view. No hosted API, automatic sync, account, publication,
rights admission, or production transition is involved.

## Local API

All routes use the existing owner session and exact Host/Origin checks.
POST additionally requires exact Origin and `Content-Type: application/json`.

| Request | Input | Response |
| --- | --- | --- |
| `GET /api/pocket-exchange/export?draftId=<record id>` | Selected saved draft ID | `.qiscript` envelope as JSON with attachment filename `screenplay-snapshot.qiscript` |
| `POST /api/pocket-exchange/preview` | Raw selected `.qiscript` file bytes, at most 8 MiB | `{snapshot, contentSha256}`; no writes |
| `POST /api/pocket-exchange/import` | The same raw file; `X-Pocket-Content-Sha256` equals its reviewed payload hash | `{contentSha256, replayed, draft, development}`; current records |

The header binds the explicit UI action to the reviewed payload. It is not an
authorization token or proof of authorship. Owner authentication supplies access
control. Import also performs every decode/validation check again. Preview has no
server-side session state or writes. File text stays intact between browser
selection, preview, and import, including duplicate members that must be rejected.

Export reads the latest saved screenplay and development together synchronously.
An ordinary same-origin download link supports the existing WKDownload handler.
Save unsaved edits before export. Downloading does not establish delivery to a
second device. Exports can be opened with the native Files flow; import creates an
independent local working copy.

## Portable boundary

Exact envelope fields are schema, contentEncoding, contentSha256, payloadBase64.
Canonical base64 decodes to at most 4 MiB of UTF-8 JSON. SHA-256 is calculated on
those exact decoded bytes **before parsing**; JSON key order is not a cross-device
canonicalization requirement. Invalid UTF-8, NUL, lone surrogates, duplicate JSON
members/identities, unknown fields/enums, invalid links, and all contract overlimits
are rejected. Nothing is truncated or Unicode-normalized. Target pages are optional:
absent means unknown; null is rejected.

Snapshot fields include the selected screenplay and every development creative
field, plus the complete world, stable element/link IDs, and opaque scene references.
Desktop development validators run with locally mapped project/draft IDs and schema
2. Existing schema 1 exports use an empty structured world and keep their world notes.
Schema 3 exports deliberately omit worldSources and shared-world publication lineage.
All history, rights, production/competition state, credentials, and retained originals
remain on the original device. World status labels remain creative author labels.

Portable title decoding accepts the contract's text limit, including blank/multiline
titles. Existing desktop draft storage requires a nonempty single-line title;
preview/import therefore reject these unrepresentable titles with a visible message,
asking for a source-device title edit and re-export. They do not silently rename them.

## Atomicity and retries

The destination project ID plus exact payload-byte SHA-256 derives a namespaced
local draft UUID and two save-request IDs. Source snapshot IDs never select an
existing destination draft. Standard `WorkspaceStore.atomic` saves the screenplay,
schema-2 development, and their existing request receipts in one transaction. No
new record kind is introduced. Both initial writes use expectedVersion null.

Repeating the same payload in the same workspace replays those save requests,
including after restart and later edits. The response returns current records;
neither record is overwritten with the imported version. Envelope whitespace/key
ordering does not create another copy. Changed payload bytes create a separate
working copy. An ID/request collision fails closed through existing CAS and request
hash checks. Ordinary backup restoration does not restore request receipts; this
case can report a conflict, but cannot overwrite restored edits.

Focused validation: `node --test local/tests/pocket-exchange.test.mjs` and
`npx vitest run src/local/components/PocketExchangePanel.test.tsx`. HTTP tests use
disposable localhost workspaces. World-return route hooks are independently owned;
this suite checks hook dispatch/access/shape only, not their integration semantics.
