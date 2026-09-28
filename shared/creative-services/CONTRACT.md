# Creative services v1

Desktop and iPhone offer three advisory services: `coverage`, `screenplay_profile`, `character_profile`. Reuse CanIScreenwrite's nine-category 120-point grading rubric and Character Diamond vocabulary. Advisory results are separate from official competition submission/judging and never change screenplay, world canon, rights or competition records automatically.

Local route: user-selected already-installed Ollama model, explicit preview/confirmation, zero platform credits charged; user supplies hardware. Never silently fall back to cloud, download a model, or switch providers. iPhone may explicitly connect to the user's Ollama on a private LAN; it is not on-device inference. No network on app launch or opening local drafts. Always show destination/model and scope before text leaves the app.

Hosted route: signed-in CanIScreenwrite account, server-owned enabled catalog, reviewed expiring quote, explicit spend confirmation, authoritative existing token wallet, idempotent reservation/job/settlement. Defaults disabled until deployment + provider/prices configured. No fake local balance, client-supplied prices, or checkout-return crediting. Service credits are distinct from LLM input/output tokens and NFT/blockchain assets.

Shared request `AnalysisInput` exact fields:
- `schemaVersion:1`
- `kind`: coverage | screenplay_profile | character_profile
- `source`: exact `{draftId:string <=120, title:string <=200, bodySha256:lowercase 64hex, excerpt:string 1...12000 UTF16 units, scope:"full"|"excerpt"}`
- `characterName`: string <=160; required nonblank only for character_profile (blank for others).

The excerpt is explicit user-reviewed text. Full screenplay may exceed the analysis limit; client offers an explicitly labelled opening excerpt, never silently calls an excerpt whole-script scoring. On local desktop, verify draft current body hash and excerpt belongs to saved body before execution. On phone, freeze request snapshot and hash before confirmation. Hosted results bind request hash but source body hash is a client declaration. Do not log source text or credentials.

Model output exact `{summary:string <=4000, strengths:[string <=1000] <=8, concerns:[string <=1000] <=8, nextSteps:[string <=1000] <=8, sections:[{heading:string <=120, body:string <=4000, evidence:string <=1000}] <=12, scores:[{key:string, score:number, evidence:string <=1000}]}`. Coverage scores are the exact nine keys concept:15, story:20, characters:20, dialogue:10, theme:10, market:15, cinematic:10, climax:10, technicalities:10. Each score is finite 0...max; profile scores must be []. Coverage total is recomputed by the app (max120), never trusted from a model. All output is advisory. Plain text rendering only. No generated code/tool calls are executed. Malformed/oversized/truncated results fail visibly; never fabricate a successful result.

`AnalysisReport` fields: `{schemaVersion:1,id:UUID,createdAt:ISO8601,input:AnalysisInput,provider:"ollama"|"hosted",model:string,platformCredits:number,output:AnalysisOutput,usage:{inputTokens:number|null,outputTokens:number|null}}`. Reports retained separately from authored drafts and exportable as JSON. Hashes/inference are not proof of authorship. File exchange v1 remains unchanged.

Implementation ownership: main owns shared JS contract, desktop local server and desktop UI/parent integration. Hosted helper owns new Supabase migration/function plus tests/docs only. iPhone helper owns new Core CreativeAnalysis.swift and native CreativeServicesView.swift/client/store, minimal native navigation/Info.plist changes only. No existing models/transport schema changes. Defaults preserve all existing offline authoring and saved documents.

Hosted API planned at `/functions/v1/creative-services`: POST JSON with `action` catalog|quote|submit|job. catalog may be unauthenticated but no private wallet info; others Bearer auth. quote `{action:"quote",input}` -> `{id,kind,model,credits,expiresAt,input}`. submit `{action:"submit",quoteId}` -> job. job `{action:"job",jobId}` -> job. Job `{id,status:"running"|"completed"|"refunded"|"uncertain",credits,report:AnalysisReport|null,error:string|null}`. Catalog `{enabled:boolean,services:[{kind,model,credits,enabled}],balance:number|null}`. The server must perform its own validation; any changes to this API must be reflected here before client implementations diverge. Purchases use existing verified server checkout on desktop; iPhone purchase UI stays unavailable until StoreKit products and server verification are configured, not a web checkout link.

Recovery addition: authenticated `{action:"jobs"}` returns `{jobs:Job[]}` for the newest 30 owned hosted jobs. Recovery never dispatches another model request. Catalog also requires sign-in. Quotes expire after ten minutes; submit immediately debits the authoritative wallet and creates a durable single-dispatch job in the same transaction. Network/worker ambiguity stays `uncertain` until operator reconciliation. Known invalid output is refunded once. The gateway remains disabled until deployment and ledger verification.

Every nonempty evidence string must occur exactly in the reviewed excerpt. The local daemon and model content remain untrusted; output has no ability to alter authored records or perform tools. Reports do not establish truth, authorship or competition results.

Local report files are separate from SQLite workspace backups and iPhone `.qiscript` snapshots. Both clients disclose this and export the full portable report JSON. Pocket exchange format remains unchanged; report import and backup bundling are not implemented.
