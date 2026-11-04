# Local brand planning across QiMovi and QiScreenwrite

## One financial ledger, two local creative workspaces

QiMovi owns the production financing ledger. QiScreenwrite owns its screenplay
and local creative placement reviews. Neither app silently rewrites, transfers,
approves, signs, or pays for anything in the other app.

### QiMovi desktop/browser

The **Brand placements** companion is available in the production workspace
(writing, preparation, cameras, editorial and delivery/documents) and every
creative-project phase. Expand it to read saved placement context, or select
**Open brand financing** to open the existing Budget panel directly. The editor
stays mounted. Navigation does not scan or write. Context can be refreshed;
confirmed financing commands invalidate the companion snapshot.

Production scene context contains only reviews of that attached production
source and scene. A reviewed working draft is not automatically a production
approval. Project totals are explicitly not attributed to one scene/draft.
There is no automatic shot insertion, footage verification, or release approval.

### QiScreenwrite desktop/browser

Save a draft, open **Brands & financing**, and select **Scan saved screenplay**.
The bounded English keyword scanner is entirely local. It reports exact quotes,
UTF-16 offsets, scene headings and the saved source revision. Enter a creative
reason before approving or rejecting a suggestion. Reviews use a separate
versioned `brand-review` record; they never alter screenplay text. A changed
revision invalidates current review applicability but preserves its history.
Unconfirmed writes retain the exact retry request. Exported JSON contains
private screenplay excerpts: share it deliberately, not through public GitHub.

The scanner and screenplay index/elements are identical vendored source modules
in both MIT repositories, not remotely executed code or a new network dependency.
The paired integration test asserts byte identity. The category vocabulary is a
heuristic, not exhaustive analysis, brand valuation, or evidence of sponsorship.

### Read connected financing

Run both updated local apps. In QiScreenwrite use **Connect → QiMovi** and the
existing explicitly reviewed transfer to send the saved draft. Then select
**Read linked financing** in **Brands & financing**. The transfer receipt must
match the current local draft and the remote record version/hash exactly.
Changed or unrelated records require a new reviewed transfer. An offline writer
still scans/reviews/exports normally without QiMovi running.

QiMovi advertises `brand-context/v1` in its existing scoped bridge handshake.
`POST /api/caniscreenwrite/brand-context` accepts only projectId, sourceId and
sourceHash, with a 4 KiB request limit. It returns the matching source,
review/deal summaries and explicitly project-wide totals. Contract evidence,
receipt identifiers and event history are not exported. The bridge remains
unable to read the full financing endpoint or perform any financial command.
No general owner session or additional financial write permission is granted.

QiScreenwrite adds owner-authenticated POST `/api/brands/scan` and
`/api/brands/qimovi-context`. Context is a read-only snapshot, never a second
financial ledger. Local creative review does not import into QiMovi approvals.
Manage deals, milestones, payments and refunds in QiMovi → Budget.

## Installation and limits

Repository updates do not change an already-installed app. Rebuild each local
app with its documented packaging command, or use the matching development
macOS arm64 artifact from a verified workflow. The apps retain existing bundle
identities and store workspaces outside the application. Back up both workspaces
and quit both apps before replacing application bundles. Do not replace or
commit private workspace folders. Development packages are ad-hoc signed, not
notarized releases; do not disable macOS security protections to open an
untrusted download. iPhone apps and hosted CanIScreenwrite are not changed.

Automated checks cover local contracts, UI behavior, source/CAS/replay guards,
bridge authorization and an actual pair of loopback HTTP services with synthetic
workspaces. Native packaging/signature checks are distinct from a manual GUI
or physical-device acceptance test.
