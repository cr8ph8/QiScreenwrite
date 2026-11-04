# Costs, tokens and resource exchanges

Status: local desktop/browser accounting layer, not a bank, billing authority or whole-machine energy meter.

## Where it is wired

The **Costs · money, tokens & resources** control belongs to the authenticated application shell, not an individual tab. It remains available across the local workspace. Opening it is read-only and does not send a screenplay to a model. It refreshes every ten seconds only while open and visible; closing it leaves the editor mounted.

Both local HTTP services register a resource observer after authentication, origin checks and, in QiMovi, bridge authorization. It observes mutations and explicit export/download requests without storing bodies, query parameters, filenames, credentials or screenplay text. Routine polling and accounting's own reads are excluded. Request elapsed time is NOT render duration, CPU time or human work.

The existing local Ollama dispatch paths now write a durable attempt start before calling the model and capture reported input/output/cache counts and durations immediately when the response arrives, before semantic validation. A rejected result can still consume resources. Transport failures, interruptions and responses without counters remain unknown, not free. The meter itself never retries a provider call. Existing application replay receipts remain authoritative.

The model response remains provider-reported evidence; these counters are not independently measured hardware usage or an invoice. Counts from a malformed/unusable response may be retained as an observation while the native result stays failed.

## Three separate views

1. **Production budget:** QiMovi's existing saved budget remains authoritative for planned, committed, known incurred, complete incurred and forecast amounts. Missing priced lines stay unknown. Do not add the same underlying usage receipts to it again.
2. **Financing:** signed sponsor commitments and cash received remain in the existing Brand Integration & Financing ledger. Funding is not a negative production expense. Cash received is not the same as contracted support.
3. **Resource observations:** provider token counts, frozen rate-based estimates, quoted generation credits, request activity and supplemental owner-recorded entries. Supplemental entries do not silently alter the production budget. Their evidence is owner-recorded, not bank-verified.

Manual entries distinguish estimate, incurred, paid, received, refund and allocation. Positive refunds remain a separate view, not an automatic negative expense. Values are grouped by unit, provider and account. Currency codes, provider credits, input/output tokens, kWh, human hours, compute seconds and storage GB-months are never added together.

A prepaid credit purchase may be recorded as cash paid; subsequent credit consumption uses credits. Do not treat both as an additional cash expense. Subscription allocation likewise remains separate from a bill. There is no automatic balance, exchange rate, tax treatment, invoice reconciliation, expiry rule or refund linkage in this version.

## Before and after work

Use **Set rates and estimate work** to save an immutable rate version, with provider/model, currency, source or assumption, and expiration. Then supply quantities to **Estimate without executing**. It neither starts work nor reserves budget. No vendor prices or electricity tariffs are silently downloaded or invented.

At local inference dispatch, the active owner-supplied rate is frozen with the attempt. Later rate changes do not reprice historical work. Costs computed from that rate are estimates, even when the token count is provider-reported. Missing or expired rates remain unknown. A different cached-input rate requires a known cached count; reasoning tokens, when available, are a subset of output rather than another charge.

A hypothetical local energy allocation uses:

```
energy_kWh = assumed_average_watts * elapsed_milliseconds / 3,600,000,000
electricity_cost = energy_kWh * owner_supplied_currency_per_kWh
```

This is NOT measured electricity. It excludes meter evidence, allocation of concurrent workloads, idle-machine baseline, embodied hardware cost and cooling unless the supplied assumptions intentionally include them. Per-run allocations must not be summed across overlapping work. Cloud-provider energy remains unobserved. Measured meter readings can be entered manually with their evidence reference.

Decimal values use bounded BigInt arithmetic at one-billionth precision; ratios round to the nearest nano-unit. This is not tax/accounting precision policy or a provider billing calculator. Runtime counters retain null for missing quantities. Display row limits never limit native budget projections or usage aggregation.

## Local QiScreenwrite–QiMovi connection

QiScreenwrite owns its local analysis observations and creative reviews. QiMovi owns the film's production budget, sponsor contracts and payments. The two journals are not merged.

After an explicit saved screenplay transfer, **Read linked QiMovi costs** requests the exact-source-bound brand-context route. Its optional `qi-resource-context/v1` extension contains project-wide budget, financing and grouped usage summaries, not per-draft cash. Private contract evidence, receipt detail, raw journals and rate assumptions are excluded. The writer bridge cannot access resource journals or financial write routes. A changed saved revision invalidates the link; no automatic push or cross-app financial authority is introduced.

## Coverage, honestly

| Resource / workflow | Current evidence |
|---|---|
| Local authoring, imports, transfers, scanning, reviews and other authenticated mutations | Request count, route family, elapsed request time and outcome; not an invented money price |
| Local Ollama inference in either local service | Durable attempts and provider-reported counts, including rejected output; frozen owner-rate estimates |
| QiMovi imported Token Steward reports | Existing provider observations with known/estimated/unknown distinction |
| QiMovi Studio generation | Existing retained quotes/attempts; a quote is not a settled credit charge |
| QiMovi scene/shot/department resources | Existing production-budget targets and observed costs; missing values remain gaps |
| DCC/rendering/background work | Existing receipts plus request activity; request latency is not whole-job CPU or GPU consumption |
| Cash, credits, labor, external invoices, measured energy, storage | Explicit supplemental owner entry; separate from native totals to avoid double counting |
| Hosted scoring, purchases in other applications, payment processors | Not automatically captured; requires receipts/import or manual observation |
| Physical CPU/GPU power and whole-machine electricity | Unmetered; optional owner-wattage estimate is labeled |
| Discovery/Release Desk standalone prototype | Not integrated into these production runtimes |
| iPhone and hosted applications | Unchanged by this desktop/local-browser implementation |
| Global hard spending caps, reservations, provider cancellation/refund enforcement | Not implemented; do not infer a spending guarantee from the dashboard |

There is no promise to price or measure every exchange. The coverage panel is part of the product: an uncovered resource remains visibly unmeasured. Imported observations are not automatically matched to unrelated direct attempts; source groups are separate, not blindly summed across applications or providers.

## Storage, safety and preservation

`resource-accounting.sqlite` is a private, separate database in the existing workspace directory. It does not write authored records or grant production approval. SQL update/delete triggers and a hash chain detect ordinary alteration. A malicious administrator who can rewrite the whole database is outside that integrity guarantee; there is no external signed anchor.

Rates and supplemental entries require unique IDs. Identical retries are idempotent; changed payloads under the same ID conflict. New IDs are new observations. There is no in-place edit/delete or automated correction matching. Review the original entry before recording a refund or correction separately.

The journal is bounded to 20,000 events. Full capacity or persistence errors are not billing zeros. Authored saves remain usable if diagnostic writes fail; accounting is marked degraded. A broken journal blocks newly metered inference rather than silently calling the provider without a durable start. Failure to persist completion never changes a completed provider action into a suggested retry. Incomplete attempts after restart stay uncertain.

**Standard creative backups currently do not include this separate database.** Use **Export private resource journal** in addition to normal project backups. It is a private audit JSON; no automated JSON restoration is provided. For a byte-for-byte restorable database backup, close the app/service cleanly and preserve `resource-accounting.sqlite` with its workspace identity. Never copy credentials into a public repository. This version does not rotate or delete old events automatically.

Neither CI nor a repository merge installs an application onto a user's Mac. Both native packagers explicitly include `local/accounting`, and package checks verify the journal module and import the bundled HTTP service. Native ad-hoc builds are not notarized releases.

## Tests

The shared Node tests cover decimal arithmetic, unknown costs, expired rates, cache subset handling, assumptions, per-unit totals, exact replay, frozen rates, interrupted attempts, rejected-output consumption, immutable event history, corrupt storage and privacy-minimized request logging. HTTP tests exercise real owner sessions, origin/bridge restrictions and failed model-output metering. UI tests cover lazy reads, retaining editor text, uncertain-write retry and explicit linked context. The paired service test checks identical shared modules and source-bound read-only cost context using synthetic workspaces.

All test rates, sponsors, tokens and monetary amounts are synthetic. Test success is not evidence of an actual customer invoice, hardware-energy measurement, native GUI interaction or installed-app update.
