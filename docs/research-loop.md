# Research lab: install and use

Research lab runs a bounded, offline search over fixed title, text and tag weights on authored synthetic screenplay evidence. It makes no LLM or provider calls. Its accepted configuration is stored separately; the editor, creative analysis and live search do not consume it. It does not modify screenplay content or grant production or financing approval.

The `feat/hampton-research-loop` branch is stacked on [QiScreenwrite PR #3](https://github.com/cr8ph8/QiScreenwrite/pull/3), `codex/preserve-known-token-counts`, rather than `main`. That dependency and the paired [QiMovi PR #5](https://github.com/cr8ph8/QiMovi/pull/5) remain draft and unmerged. Each app runs its own local research lab; no bridge connection is needed.

## Try a fresh local workspace

Use Node.js **24.18.0** and npm. This version also matches the Node license included for native packaging. The commands below install the locked dependencies and create an isolated temporary checkout and workspace. Run them in one terminal; keep or export any work you want to retain before removing the temporary directory.

```sh
QIS_RESEARCH_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/qiscreenwrite-research.XXXXXX")"
git clone --branch feat/hampton-research-loop --single-branch \
  https://github.com/cr8ph8/QiScreenwrite.git "$QIS_RESEARCH_ROOT/source"
cd "$QIS_RESEARCH_ROOT/source"
npm ci
npm run build

QIS_RESEARCH_WORKSPACE="$QIS_RESEARCH_ROOT/workspace"
node local/server/cli.mjs init \
  --data "$QIS_RESEARCH_WORKSPACE" --title "Research lab demo"
node local/server/cli.mjs serve \
  --data "$QIS_RESEARCH_WORKSPACE" --dist dist-local --port 4318 --open
```

The service opens a short-lived local login link for <http://127.0.0.1:4318/>. If the browser does not open, use the printed login link locally while it is valid. No model, account or API key is required. Setup downloads dependencies; the experiment itself runs offline. See [Using QiScreenwrite](USAGE.md) for the existing writing workflow.

## Run an experiment

1. Open **Research lab** beside **Costs** in the authenticated app.
2. Choose the maximum candidate trials, whole-job allowance and evaluation timeout, then select **Start bounded run**.
3. Inspect the development and confirmation scores, resource observations and accepted settings version. A qualifying run appears under **Proposals awaiting owner review**.
4. Review the configuration change and evidence. Select **Approve research settings** to apply the exact proposal, or **Decline proposal** to reject it. The review and its outcome are recorded in the audit.
5. Use **Cancel run** to stop active work, or **Export research audit** to retain the complete receipts.

Closing the panel leaves the run active. Stopping the local service cancels active research before its storage closes. Restarting does not resume unfinished work automatically. A lost response can be retried with **Retry same request**, which retains the original request ID.

The policy permits at most **24 candidate trials**, **300 seconds for the whole job**, and **10 seconds per evaluation**. Baseline and confirmation evaluations share the whole-job allowance. The current target has eight candidate configurations, so it can finish before the requested ceiling. Evaluation is finite parameter search, not an autonomous code-writing agent.

## What admission means

- Only a **COMMIT** from an explicit owner approval changes accepted research settings. **DAMP**, **ESCALATE** and **REJECT** preserve them. A qualifying evaluation records **ESCALATE** while it awaits review.
- The parent evaluator scores returned source IDs against its labels. Candidate-supplied scores or assertions are not admission evidence.
- One finalist is selected using development results before confirmation is evaluated. The two splits use different relevant documents, but public labels are reused between runs. A fixture improvement does not establish generalization to unseen screenplays.
- Source hashes bind each run to the workspace and saved record versions. Final source validation and accepted-state admission run under synchronous SQLite locks; edits during the experiment cause escalation instead of stale acceptance.
- The parent enforces deadlines and terminates real worker threads. Workers run fixed repository code and receive numeric configuration; this is not a sandbox for arbitrary generated code.
- Missing or failed required checks cannot authorize acceptance. Dataset, evaluator and policy hashes bind the recorded experiment contract. Local hash chains detect inconsistencies but have no external anchor.

Existing journals from the first packaged pilot keep their accepted settings and audit history. On first open, the new lab records its review policy. Use the new build for subsequent research in that workspace.

## Costs and backups

Provider input/output tokens and provider charge are known zero because this target makes no provider calls. That does not make computation free: whole-job elapsed time and returned serialized bytes are recorded; worker CPU is recorded when available and otherwise remains unknown. Electricity, hardware cost and unobserved resource use remain unmeasured.

Research receipts live in the separate `research-loop.sqlite` journal. The resource journal records the evaluation start, consumption and outcome separately from HTTP request duration. The owner review is a separate event in the research audit. Approval requires the completed evaluation receipt. Decision-inclusive elapsed time excludes the last telemetry write itself; a missing final receipt is marked OUTCOME_UNCERTAIN while known consumption remains available. A missing completion is uncertain, not zero usage. Export the research audit and resource journal separately from creative backups; the research result bytes are not a measurement of total disk consumption.

## Stage a macOS development candidate

On macOS 14 or later with Xcode command-line tools and Node **24.18.0**, run from the checkout above:

```sh
npm run desktop:build
```

This existing build command stages a new `QiCanIScreenwrite-*.app` in a fresh temporary directory; it prints the location and records it in `build-desktop/latest.json`. It does not replace an installed app or launch it. The native display name remains QiCanIScreenwrite. The candidate uses ad-hoc signing and is not a notarized distribution release. A successful web build does not establish native launch or installation on your Mac. See [Desktop guide](../local/DESKTOP-GUIDE.md).
