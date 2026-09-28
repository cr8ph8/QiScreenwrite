# Native creative services

Entry point: open a draft → Share and research → Creative services. All three services are advisory: coverage, screenplay profile, and fictional character profile. Authoring, the pocket exchange schema, development/world data and saved revisions are unchanged. Reports never apply suggestions to writing.

## Local Ollama

1. Run an already-installed model in Ollama on your own trusted machine. Configure that machine's listener/firewall yourself. The app never installs models, changes Ollama settings or falls back to a hosted provider.
2. Enter an explicit endpoint such as `http://192.168.1.20:11434`, tap **Refresh installed models**, and choose a model. Only canonical literal private IPv4 addresses (10/8, 172.16/12, 192.168/16) and loopback (127/8, ::1) are accepted. Hostnames, public addresses, IPv4 shorthand/octal, credentials, paths, queries and fragments are rejected. On a physical iPhone, 127.0.0.1 is the phone, not the user's Mac; use the Mac's LAN address. Inference is on that machine, not embedded in the phone.
3. Choose full screenplay or explicitly choose opening excerpt, then **Review exact request**. The frozen review shows the entire exact passage, service, character, scope, model, destination and full-source SHA-256. The full-source hash uses the existing `PocketPackage.sha256` helper. The source cap is 12,000 UTF-16 code units; UI copy calls these characters. Full input exceeding the cap fails. Explicit excerpt construction preserves complete characters and exact source bytes, including CRLF/combining marks. Excerpt scores are clearly labelled as passage-only.
4. Only **Send this text to local Ollama · 0 credits** sends writing. `/api/show` is first probed without writing. Cloud names and remote metadata are rejected; models listed by `/api/tags` need more than 1 MiB of local weights and a 64-hex digest. Supported local weight formats are GGUF and safetensors.

The request uses `/api/chat`, `stream:false`, `think:false`, a structured output schema, and `num_predict:4096`. Context budget is `ceil((UTF8(JSON(messages)).count + 4096) / 1024) * 1024`. It must fit the model's verified `model_info[general.architecture + ".context_length"]` and the 65,536 ceiling. Missing/insufficient capacity fails before source transmission; the app never shrinks the context or silently truncates input/output. Exact response model identity, assistant role, `done:true` and `done_reason:"stop"` are required. Images/tool calls, invalid scores, incomplete JSON, oversized output and unsupported evidence fail visibly. Each evidence field must be an exact byte substring of the reviewed passage or empty.

Local reports have exactly zero platform credits. Hardware, LAN security and Ollama are supplied by the user. HTTP is unencrypted on the selected LAN; HTTPS uses normal system trust with no certificate bypass. `NSAllowsLocalNetworking` and a local-network usage description are the only Info.plist networking additions. Real device network permission, firewall/TLS setup and locked-device behavior still need device acceptance.

## Optional hosted service: default not configured

No public deployment, provider credentials, enabled prices, wallet balance or StoreKit product configuration is invented or embedded. Purchases are always unavailable in this native implementation. There is no external checkout link, client-side purchase crediting or assumed receipt verification. Enabling hosted analysis does **not** enable purchases.

An operator may supply these exact properties in the app Info.plist, or in a separately bundled `CreativeServicesConfig.plist` resource. Info properties override resource properties. `CreativeServicesConfig.example.plist` is an inert example and is not added to the build by the project generator.

| Property | Value |
|---|---|
| `QICreativeHostedEnabled` | Boolean `true` only after operator deployment verification; absent/false disables the route |
| `QICreativeSupabaseURL` | Public operator Supabase HTTPS origin, e.g. `https://operator-project.supabase.co`; no path, credentials, query, fragment or custom port |
| `QICreativePublishableKey` | Operator's modern `sb_publishable_…` public key; no secret/service-role key or legacy JWT |

There is no raw-key field in the app UI. The client derives `/auth/v1/token?grant_type=password` and `/functions/v1/creative-services` from the same configured origin. Email/password sign-in uses Supabase REST. Passwords are cleared from the form when sign-in starts; access tokens/session details are held in memory only, never logged, saved in defaults or exported. Refresh tokens are discarded. Leaving the services screen or signing out clears the active session; expiry requires explicit sign-in again. This is local session removal, not a request to revoke all server sessions.

All networking requires an explicit button: sign-in, refresh catalog/wallet, request quote, confirm spend, refresh/recover a job, or refresh recent account jobs. There is no network on launch, opening a draft, opening this screen, changing a model, or opening a saved report.

Hosted flow:

1. Sign in; explicitly refresh the server-owned enabled catalog and wallet. Unknown balance stays unknown. Catalog values are last-observed server values, not a spending guarantee.
2. Review the frozen source/model/destination. **Send this text & request quote · no spend** discloses the source to the hosted service but does not authorize spending.
3. Review returned quote ID, exact model, credits and expiry. Quotes must preserve every input value. Sorted-key canonical JSON comparison tolerates PostgreSQL jsonb key reordering and detects exact text changes.
4. **Confirm spend** first saves a protected pending record, then submits only the quote ID. Expired quotes cannot be newly submitted. Recovery can replay an already-confirmed pending quote ID even after its expiry; server idempotency must return its original reservation/job rather than create a new charge.
5. Check the job manually. Reports must bind to the confirmed input/model/credits. A completed report is saved before the pending record is cleared. Running/uncertain status or an ambiguous response retains the pending record and blocks further spending. A timeout, app cancellation or HTTP error is never interpreted as a refund. A damaged pending record also blocks new spending until operator reconciliation.
6. **Recover recent account jobs** calls `{action:"jobs"}` and expects `{jobs:Job[]}` with at most 30 owner-scoped jobs. This can recover completed reports after reinstall or loss of local history. Running/uncertain jobs remain explicitly unresolved; no quote or spend is inferred from a recent-job listing.

The server must deploy the shared contract, validate auth/ownership/source and prices, bind quote IDs idempotently, implement wallet reservation/settlement/refund reconciliation, enforce expiry, reject cross-owner access, and return exactly the documented catalog/quote/job/report shapes. The current native code assumes the operator fulfills these requirements; it is not evidence of a live paid deployment. Verify StoreKit products and server transaction/receipt replay handling in a separate implementation before adding purchases.

## Transport and persistence

`CreativeHTTP` creates a new ephemeral session for each explicit request, with no cache, cookie store, stored credentials, proxy override inheritance, redirect following or retry loop. It requires an identical response URL, HTTP 2xx and `application/json`. Request bodies are capped at 256 KiB. Responses are bounded while streaming: 1 MiB generally, 512 KiB for model lists, 64 KiB for sign-in. Metadata/auth/status deadlines are 25 seconds; generation/submission deadlines are 180 seconds. HTTP error bodies and model/source text are never logged. Cancellation stops the phone's wait, not a remote job.

Files live separately in Application Support / `QiCanIScreenwrite-CreativeServices`. One checksum envelope per report (`UUID.qicreative`, max 2 MiB), plus `pending-hosted.json` while a paid submission is unresolved. The directory/files use iOS complete file protection and atomic writes. Existing conflicting/damaged reports are left untouched. A failed save leaves the received report in memory for immediate JSON export and explicit save retry. These reports are not part of `.qiscript` exchange. OS backup policies remain the device's responsibility.

Report JSON export contains exactly the shared `AnalysisReport` fields. Destination is retained only in the private file envelope/UI. Input/output tokens remain null when unknown; service credits are distinct. Coverage is the nine-category 120-point rubric, recomputed by the app. Character Diamond uses North Star, Counter-Star, Flaw / Mask, Non-Negotiable, with epistemic/normative/affective/relational notes and explicit unknowns. Generated text is rendered with `Text(verbatim:)`; no model markdown, URLs, tools or code execute.

## Verification

Run `swift test --package-path iphone/Core` for synthetic contract checks and build the iPhone project for app integration. Physical-device network permission, availability of models and hosted deployment acceptance are separate checks. Use test writing and a staging service for those checks.

API references: [Ollama model list](https://docs.ollama.com/api/tags), [Ollama API source/schema](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml), [Supabase Auth REST](https://supabase.github.io/auth/), [Apple local networking ATS](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking). Shared local authority: `shared/creative-services/CONTRACT.md` and `contract.mjs`.
