# Connecting QiScreenwrite to CanIScreenwrite.com

QiScreenwrite is the local creative workspace. [CanIScreenwrite.com](https://caniscreenwrite.com) is the intended optional online destination for screenplay evaluation, profiles, competition entries and related account services. Writers should be able to finish a screenplay locally before deciding whether to connect.

## Current boundary

Local writing, development, worlds, revisions and exports do not require the hosted system. The source includes optional competition and creative-service adapters, but this public repository contains no production project credentials and does not deploy the CanIScreenwrite.com backend.

The existing desktop competition adapter is designed to sign into a compatible hosted deployment, list the writer’s competitions/entries/drafts, import a draft copy, and carry an explicitly saved local revision to the online workspace. Final entry submission stays in the hosted portal. These adapter capabilities are implementation starting points; this source release does not establish that they are enabled or accepted against the live website.

Creative-service contracts also describe local-model requests and a hosted quote/job flow. Hosted token purchasing, provider configuration, server-side settlement and iPhone in-app purchasing require separate deployment and verification. A local counter must never represent a purchased balance.

## Planned writer journey

1. **Choose to connect.** The writer enables the online connection and authenticates to the selected service. Credentials remain separate from screenplay exports and backups.
2. **Choose an exact saved revision.** Show its title, revision and checksum, the destination account, and exactly which text or development fields will leave the device.
3. **Choose a service.** Request scoring, coverage or an advisory profile, or begin a competition entry. Show the applicable data policy, eligibility and any price before confirmation.
4. **Confirm transfer and any spending separately.** Upload only reviewed content. A server-owned quote and idempotent request identify a paid job; retries must not charge twice.
5. **Receive a traceable result.** Retain the report with its source revision, service/model metadata and server receipt. A result is advisory and must not silently rewrite the screenplay.
6. **Finish competition submission online.** The hosted system handles eligibility, required attestations, official submission state, judging and administration. A desktop upload alone is not an entry.

## Delivery stages

| Stage | Work | Acceptance evidence |
|---|---|---|
| Local foundation | Keep authoring, history and exports independent of online accounts | Offline authoring and recovery tests |
| Reviewed project exchange | Retain `.qiscript` snapshots and clear independent-copy semantics | Round-trip tests with text/world identity preservation |
| Hosted connection | Publish a supported API contract, configure a test environment and verify authentication/authorization | Staging tests using a writer-owned test account; denied cross-account access |
| Scoring and profiles | Review uploads, validate structured reports and bind results to saved revisions | Retry, timeout, failure and result-retrieval evidence |
| Paid hosted services | Validate server-side quotes, balances, reservations, settlement/refunds and purchase receipts | Payment-provider sandbox tests; no client-created credits |
| iPhone hosted access | Adopt the same source-review and job contracts; complete Apple distribution/purchase requirements where applicable | Physical-device and backend acceptance |

## Ownership and authority

The local creative file stays under the writer’s control. Reports, hashes, contributor worksheets and imported source receipts do not themselves establish authorship, a co-writer’s consent or rights clearance. QiMovi/FilmStack continues to manage its own production decisions. Future blockchain/NFT metadata preparation does not mint an asset, collect a royalty or transfer ownership.

## Contributor boundaries

- Keep hosted configuration optional and empty by default. Never add a service-role key, signing key, owner token or production account data to this repository.
- Treat transfer review, signing in, uploading and spending as separate actions.
- Preserve private local edits when importing remote work. Report conflicts instead of overwriting silently.
- Use staging fixtures and synthetic writing for integration tests.
- Describe a capability as available only after its frontend, backend, authentication, deployment and user journey have been verified together.

The implementation contracts in [the iPhone exchange](../iphone/CONTRACT.md) and [creative services](../shared/creative-services/CONTRACT.md) provide the starting interfaces. This roadmap states intended integration; it is not a promise that a hosted service, price or release date is already available.
