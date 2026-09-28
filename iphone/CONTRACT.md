# iPhone v0.1 implementation contract

Native SwiftUI iOS 17+ app. Local Application Support storage, no server/account/network requirement. Native Files import/export. A portable creative snapshot (`.qiscript`, JSON) exchanges a selected screenplay + development/world with desktop. Imports create independent working copies, never overwrite an existing draft or admit production/rights state. Historical revisions, shared-world publication lineage, rights records, retained original documents, credentials and competition state stay on their original device; UI must clearly disclose snapshot scope.

Envelope exact keys: `schema: "qicaniscreenwrite-pocket/v1"`, `contentEncoding: "base64-json-utf8"`, `contentSha256: <lowercase SHA256 of decoded payload bytes>`, `payloadBase64: <canonical base64 UTF-8 JSON>`.
Maximum envelope bytes 8 MiB, decoded payload bytes 4 MiB. Verify byte hash before interpreting. No checksum/authorship conflation.

Payload `PocketSnapshot`: exact keys `id` UUID string, `title` <=200, `body` <=200000, `genre` <=120, `logline` <=1000, `projectFormat` one of empty/vertical/micro/short/pilot_30/pilot_60/feature, OPTIONAL `targetPages` integer 1...1000 (absent means unknown, never null), `development`.
`PocketDevelopment`: exact keys concept, logline, synopsis, outline, beats, characters, worldNotes, researchNotes, world. Same limits/row fields as desktop `src/local/development.ts`, but omit projectId/draftId/schemaVersion/worldSources. World retains desktop v1 shape exactly (`src/local/world.ts`), including stable element/link IDs and opaque scene references. Maximum aggregate development 400000 UTF16 units, world aggregate 200000. Reject unknown fields/invalid enums/duplicates/foreign element links/NUL/lone surrogates/overlimits; never truncate. Preserve authored Unicode and line endings exactly.

Swift public Core API (`import ScreenwriteCore`, defaults in initializers):
- PocketSnapshot: Codable, Equatable, Identifiable, Sendable. Properties as above; `init(id: String = UUID().uuidString.lowercased(), title: String = "Untitled", body: String = "", genre: String = "", logline: String = "", projectFormat: String = "", targetPages: Int? = nil, development: PocketDevelopment = .init())`; `func validate() throws`.
- PocketDevelopment: Codable, Equatable, Sendable; string properties default empty; arrays `[PocketBeat]`, `[PocketCharacter]`, `[PocketResearchNote]`, world `PocketWorld` defaults empty. Public all-default init.
- PocketBeat {id UUID default, title, description}; PocketCharacter {id UUID default,name,role,description,arc}; PocketResearchNote {id UUID default,title,notes,source}; all Codable Equatable Identifiable Sendable, public all-default init.
- PocketWorld {schemaVersion:Int=1,elements:[PocketWorldElement]=[],links:[PocketWorldLink]=[]}.
- PocketWorldElement {id UUID default,type:String="location",name,description,storyFunction,sensoryDetails,continuity,status:String="idea",order:Int=0}; public default initializer, Codable Equatable Identifiable Sendable.
- PocketWorldLink {id UUID default,elementId:String,targetType:String,targetRef:String,targetLabel:String,notes:String=""}; public initializer, Codable Equatable Identifiable Sendable.
- `PocketPackage.encode(_ snapshot: PocketSnapshot) throws -> Data`; `PocketPackage.decode(_ data: Data) throws -> PocketSnapshot`; `PocketPackage.contentHash(_ data: Data) throws -> String` returns validated envelope hash; `PocketPackage.sha256(_ data: Data) -> String`.
- `FountainOutline.scenes(in: String) -> [FountainScene]` read-only bounded parser in main code (not Core helper). FountainScene has id:String (ephemeral), heading:String, text:String, line:Int, number:String? and conservative optional `worldReference:String?`; no positional IDs for durable links.

Main owns project scaffolding/build/store/editor/file flows and outline. Helper Core owns Core Models.swift/PocketPackage.swift/validation/tests. Helper desktop owns new transport module/tests/native UI panel + parent integration, no other desktop refactors. Helper world/reference owns native WorldBuilderView.swift/FilmLanguageView.swift/resources only.


## Reviewed continuation v2 (working source update, September 27, 2026)

The existing v1 format and independent-copy semantics remain. A v2 envelope uses schema `qicaniscreenwrite-pocket/v2` with the same encoding, hash and byte limits. Its decoded payload has exactly `snapshot` (the existing v1 creative snapshot) and `continuation`. The latter has exactly `exchangeId` (UUID), `projectId` (origin writer ID), `draft` and `development`; both references have exactly `id`, `version` (1...2147483646) and lowercase `sha256`. Their record IDs share the snapshot's UUID. A checksum is still not authorship or authorization.

A POST in the originating desktop writer issues a trip, retains the exact base references in its local `pocket_trips` table, and offers a same-origin download reconstructed from immutable history. Each trip accepts one distinct return. After acceptance, identical returned bytes replay without additional versions and preserve subsequent Mac edits. Another changed return under that trip is refused. A new cycle starts with an explicit new Mac trip and a separate phone copy; previous phone histories remain.

On phone import the document gets its own local UUID, initial saved revision, imported hash and optional `PocketContinuation`. Working edits and revisions keep that local identity. **Export project copy** still emits v1 without a link. **Export return to linked Mac** emits v2, restoring the originating UUID in the transport snapshot and retaining the exact continuation reference.

The Mac return must be explicitly reviewed and bound to the payload hash. The issuing receipt and both current saved record versions/hashes must match inside one transaction, with no pending screenplay/development recovery edits. Changed records append under the original IDs; history remains immutable. The Mac retains its existing v3 `worldSources` and verifies its source references. Those publication links are neither trusted from a phone file nor published by this operation. Concurrent changes, foreign receipts or altered manifests refuse replacement. Independent-copy import remains available.

The existing QiMovi bridge is unchanged, including its sceneMap guard. This feature is manual file exchange, not live sync, shared history export, publication or production admission. Linked-trip receipts currently live only in the issuing workspace database; existing workspace backup exports do not include this new table. After restoring such a backup, old linked returns fail closed and remain available as independent copies. Source checks do not establish installed-phone or installed-Mac availability.
