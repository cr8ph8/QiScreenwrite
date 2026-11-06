# Research loop operating contract

This is the human-readable operating contract for the Research lab. The enforced
policy lives in `engine.mjs`; editing this Markdown does not grant authority.

## Objective and scope

Search the finite numeric retrieval configurations in `target.mjs`. Evaluate
source retrieval on that application's **public, synthetic fixture**. Only the
lab's accepted research configuration may change. Screenplays, production
records, financing, media, source files, model weights, and approval policy are
outside this run's write authority.

The current proposer is deterministic enumeration. It does not call an LLM,
execute generated code, or perform live Internet research. A worker thread
enforces execution limits for trusted fixed code; it is not an arbitrary-code
security sandbox.

## Repeat within the authorized budget

1. The authenticated owner starts a run with a maximum trial count, whole-job
   wall-time allowance, and per-evaluation timeout. Never resume automatically
   after a process restart.
2. Freeze the dataset, evaluator, policy, accepted configuration and saved
   workspace version. Persist the run and its resource-accounting start before
   dispatching work.
3. Evaluate the incumbent on development queries. Enumerate only allowlisted
   numeric configurations. Return source IDs; the service calculates correctness
   against labels kept outside the worker inputs.
4. Record every trial, including failures. A development result cannot commit.
   A repeated `(content_hash, pre_state_hash)` pair escalates. Continue with the
   remaining candidates while the budget remains.
5. Freeze one finalist. Evaluate that finalist and the incumbent on the
   confirmation split once. No further proposal in this run may use that result.
6. Require all admission checks to return PASS. ERROR and SKIPPED cannot stand
   in for evidence. Recheck the source version under the workspace database lock
   and append the decision atomically with the accepted-state transition.
7. Only COMMIT changes accepted research settings. DAMP, ESCALATE and REJECT
   leave them unchanged. Omega has no authority to admit a proposal.
8. Stop at cancellation, deadline, exhaustion, or a storage/accounting fault.
   Report what happened and what remains unknown.

## Acceptance and measurement

Prefer more correct top-ranked sources. With equal correctness, accept only a
configuration with fewer active weights. Require the same improvement rule on
confirmation. This is a small deterministic fixture criterion, not statistical
proof of generalization. Repeated runs reuse public labels; a real evaluation
requires new, separately maintained data and a stronger task-specific contract.

Record job wall time, worker CPU time when supported, serialized result bytes,
and all candidate outcomes. Provider calls and provider token counts are zero
because this implementation makes none. Provider charges are USD 0. Electricity,
hardware ownership costs, and human review time remain unmeasured. Serialized
result size is not disk usage or storage billing. A lost completion record stays
uncertain; it does not become zero.

The research journal is separate from the creative workspace and ordinary
creative backups. Export it through Research lab. Its local hash chain detects
partial corruption; it has no external anchor against a complete rewrite by a
privileged local actor.

## Expanding the experiment

Review a new adapter and versioned contract before granting additional scope.
A local-model proposer would need existing provider authorization and measured
token accounting. Generated-code experiments additionally need process/container
isolation, a restricted filesystem, fixed external tests and a reviewable patch
promotion path. Creative suggestions need author review and their existing
revision checks. None of those permissions follows from this fixture run.
