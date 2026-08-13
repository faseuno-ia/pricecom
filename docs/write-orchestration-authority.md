# Per-provider write-orchestration authority (2G-R10-PR19)

Replaces the global env flag `PARTIAL_COMMIT_SHADOW` (Option A) with **explicit per-provider authority**
(Option C). Not Option B (implicit coupling by config shape).

## The field

`ProviderScraperConfig.writeOrchestrationMode` — nullable `String` (same storage + fail-loud resolver
pattern as `catalogWriteMode`/`extractionMode`).

| value | meaning |
|---|---|
| `null` / `""` / `"LEGACY"` | **LEGACY** — historical orchestrator (default; safe) |
| `"GUARDED_PRICE_ONLY"` | reconciliation + health gate + price preflight + lifecycle shadow + fenced PRICE_ONLY commit |
| any other non-empty string | resolver throws `WriteOrchestrationModeError` (fail-loud, never silent) |

Three orthogonal dimensions: `catalogWriteMode` (WHAT may be written) · `extractionMode` (HOW data is
fetched) · `writeOrchestrationMode` (WHICH orchestrator is authorized to run).

## Default = no behavior change

`FIELD_DEFAULT = LEGACY`. A deploy of PR-19 changes **no** provider's behavior: every existing config has
`writeOrchestrationMode = null → LEGACY → HISTORICAL`, exactly as before. `GUARDED_PRICE_ONLY` is an
explicit per-provider opt-in (a separate DB write, gated on its own authorization). This is deliberately
**not** fail-closed-to-guarded: guarded-by-default would be Option B by the back door (any future
PRICE_ONLY∧SKU-first provider would inherit the DT-calibrated orchestrator).

## Path decision (single canonical evaluation)

`decideExecutionPath` (`worker/src/execution-path.ts`) — C1 is now `C1' = writeOrchestrationMode ===
"GUARDED_PRICE_ONLY"` (resolved from the provider, no env). PARTIAL iff `C1' ∧ C2(PRICE_ONLY) ∧
C3(SKU-first)`; otherwise HISTORICAL (normal jobs) or **CANARY_FAIL_CLOSED** (canary jobs). The
load-bearing invariant is preserved: a `CANARY_PARTIAL` job can never silently fall to HISTORICAL. The
`[PathDecision]` witness (now `schemaVersion: 2`) carries `writeOrchestrationMode` in place of the removed
`partialFlagEnabled`.

## The dead flag

`PARTIAL_COMMIT_SHADOW` has no runtime consumers after PR-19 (removed from `index.ts`). A CI guard
(`tests/unit/no-partial-commit-shadow-runtime.test.ts`) enforces **zero** references in executable code
(`worker/src`, `lib`, `app`), while **docs keep it** as incident evidence (`docs/worker-topology.md`,
this record). Guard scope excludes docs and test files.

## Deploy sequence

PR-19 needs **no** pre-provisioning (default LEGACY → no behavior change):
1. PR-19 CI green → 2. merge + exact-main CI → 3. deploy (`prisma migrate deploy` applies the additive
`ADD COLUMN`) → 4. verify `[WorkerBoot]` new SHA, `TOTAL_ACTIVE_JOB_POLLERS = 1` → 5. read DT config in
prod → resolves to `LEGACY` (nobody changed behavior).

**Separate gate (a prod write, human-authorized):** enable DT via
`UPDATE ProviderScraperConfig SET writeOrchestrationMode = 'GUARDED_PRICE_ONLY' WHERE providerId = <DT>`
(snapshot first, guarded statement, expected affectedRows = 1). This is **not** part of "deploy PR-19".

## Verification run (a real production write)

Enabling DT authority is validated by a **normal-shape** job (source unset/null — the shape of
`app/api/extractions/start/route.ts`, not a `CANARY_PARTIAL` marker), created directly (bypassing only the
`isActive` enqueue gate), which — with `writeOrchestrationMode = GUARDED_PRICE_ONLY ∧ PRICE_ONLY ∧
SKU-first` — selects PARTIAL and, if it completes, **writes prices**. Same JIT / fresh RUN_PRE /
set-difference / single-job / POST-invariants discipline as the second canary. Planned, not part of this PR.

## Out of scope (future)
Lifecycle enforcement · per-SKU persistence of reconciliation partitions · worker-liveness alerting ·
renaming the internal `selectedPath = "PARTIAL"`.
