# Controlled-canary safety (2G-R9-PR2)

## Why

The 2026-08-10 controlled canary took the **historical** path because a second poller without
`PARTIAL_COMMIT_SHADOW` won the claim (dual-poller, see `docs/worker-topology.md`). PR-1 removed that
poller. PR-2 makes the failure mode **structurally impossible**: even if something equivalent recurred, a
canary job dies **before the scraper** instead of writing prices while bypassing the Q2.1-B gates.

## Invariants

- `CANARY_HISTORICAL_FALLBACK = STRUCTURALLY_IMPOSSIBLE` — a job marked `source = "CANARY_PARTIAL"` whose
  partial preconditions are not all met resolves to `CANARY_FAIL_CLOSED` and the worker throws
  `CanaryPreconditionError` **before any extraction call**. It can never reach the historical write path.
- `PATH_DECISION_IS_SINGLE_CANONICAL_EVALUATION = true` — `decideExecutionPath(...)`
  (`worker/src/execution-path.ts`) is the **only** path-selection evaluation. `processJob` consumes the
  result and never re-evaluates. There is no second independent path conditional.
- `PATH_DECISION_WITNESS = BOUND_TO_ACTUAL_EXECUTOR` — a `[PathDecision]` record is emitted for **every**
  job **before** the scraper, carrying `pid` + Railway service identity + the decision + all failed
  conjuncts. For a canary job the witness must be **durably persisted** (ExtractionLog, awaited) before the
  scraper; if that persist fails, the canary fails closed with a distinguishable reason
  (`CONTROLLED_CANARY_PATH_DECISION_PERSIST_FAILED`). Normal-job logging error semantics are unchanged.
- `EXCLUSIVITY_PROOF = SET_DIFFERENCE` — the next canary proves exclusivity via `diffJobIds(pre, post)`
  (`worker/src/job-set-diff.ts`), requiring `added == [CONTROLLED_JOB_ID] ∧ removed == []`. No clocks;
  `createdAt > anchor` is no longer the primary proof (it compared a DB clock to a container clock).
- `EMERGENCY_FENCE_ROLE = BACKSTOP` — the manual fence is no longer the primary control; the structural
  guard is.

## The three conjuncts (C1∧C2∧C3 → PARTIAL)

`C1` = `PARTIAL_COMMIT_SHADOW === "1"` · `C2` = `catalogWriteMode === "PRICE_ONLY"` ·
`C3` = `extractionMode === "TIENDANUBE_LS_VARIANTS_SKU_FIRST"`.

| isCanary | C1∧C2∧C3 | selectedPath |
|---|---|---|
| any | true | `PARTIAL` |
| false | false | `HISTORICAL` |
| true | false | `CANARY_FAIL_CLOSED` (throws before scraper) |

`failedConjuncts` reports **all** false conjuncts in deterministic order `C1,C2,C3`.

## Canary marker authority (`ExtractionJob.source = "CANARY_PARTIAL"`)

`CANARY_MARKER_AUTHORITY = INTERNAL_ONLY`. Audit of all write/validation sites:
- Public enqueue `POST /api/extractions/start` — schema whitelists only `providerId`+`startUrl`; `source`
  is **not** accepted from the client → job created with `source = null`.
- `POST /api/catalog/import` — sets `source = "IMPORT"` (hardcoded; excluded from the worker by
  `claimNextJob`).
- ops bootstrap — sets `source = "BOOTSTRAP"` (hardcoded; status COMPLETED, never runs).
- No scheduler exists; no API/UI accepts an arbitrary `source`.

Therefore `CANARY_MARKER_CAN_BE_CREATED_VIA_NORMAL_PRODUCT_FLOW = false` and
`CAN_SAFELY_USE_SOURCE_AS_CANARY_MARKER = true`. The dedup guard (`extractions/start:29`) keys on
`providerId+userId+status` — **not** `source` — so a canary marker neither evades nor triggers dedup.
Prod `source` distribution at audit: `null` (282), `BOOTSTRAP` (1), `breakglass` (2); `CANARY_PARTIAL`
absent.

## Fail-closed terminalization

`CanaryPreconditionError` is a typed error thrown before the scraper; it flows to `processJob`'s existing
**fenced** catch → `queue.markFailed` (CAS on `status='RUNNING' AND workerLockedAt=leaseVersion`). No
ad-hoc `UPDATE status='FAILED'` was added. Consequently the canary fail-closed **requires current lease
ownership** and **cannot** terminalize after lease loss (the job stays RUNNING for stale recovery). The
FAILED job is not stale-requeued (`releaseStaleJobs` only touches RUNNING).

## Out of scope
Topology (PR-1) · partial-commit / reconciliation / health-gate / preflight / restore logic ·
`DEBT_GUARD_INDIRECTION_VIA_NPM_RUN` (separate follow-up; `REMEDIATED_IN_PR2 = false`).
