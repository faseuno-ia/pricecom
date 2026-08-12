# Worker topology — deterministic single consumer (2G-R9-PR1)

## Root cause (proven)

`DUAL_POLLER_ROOT_CAUSE = INCOMPLETE_MIGRATION_2026_05_24`

| commit | date | change |
|---|---|---|
| `f722a7d` | 2026-05-14 | root `Dockerfile` created; CMD ran **web + worker sidecar** (`npx tsx worker/src/index.ts & npm start`) — pricecom was the single service running both |
| `1c34ed9` / `a3d006d` | 2026-05-24 | worker split into its own Railway service (`pricecom-worker`, `worker/Dockerfile` + `worker/railway.toml`) |
| — | — | **defect:** the root Dockerfile CMD was never changed to drop the sidecar, so **both** `pricecom` and `pricecom-worker` polled `ExtractionJob PENDING` |

Because `PARTIAL_COMMIT_SHADOW=1` was set only on `pricecom-worker`, path selection (partial vs historical) became **non-deterministic**: whichever poller won the claim decided. `FOR UPDATE SKIP LOCKED` prevents two pollers claiming the *same row*, not the competition itself. The 2026-08-10 controlled canary was claimed by `pricecom` (no flag) → historical path; the emergency fence prevented any write.

## Fix

- **Fix A** — root `Dockerfile` CMD → `["sh", "-c", "npm start"]` (web only). Minimal diff: only `npx tsx <worker-entrypoint> & ` was removed from the previous CMD; the `sh -c` form and process model (PID1=sh) are preserved so signal semantics are unchanged. `npm start` = `prisma migrate deploy && next start`, so migrate-deploy still runs on web boot.
- **Fix B** — `worker/src/index.ts` no longer calls `pollLoop()` unconditionally. It calls `bootWorker(...)` (`worker/src/worker-boot.ts`), which starts the poll loop **only if `WORKER_ENABLED === "true"`** (fail-closed: absent/`"false"`/`"0"`/`"1"`/`"yes"`/anything-else → no poller).
- Disabled mode: emits `[WorkerBoot] {…, workerEnabled:false, pollerStarted:false}` once, then `[WorkerDisabledHeartbeat]` every 60 s, **without reading the queue or writing the DB**.
- `[WorkerBoot]` (identity event, emitted once in both modes) and `[WorkerDisabledHeartbeat]` (state event, repeats) are **distinct event names** — `[WorkerBoot]` count is the executor witness (`WORKER_BOOT_COUNT_ACROSS_ALL_SERVICES`).

### Consequences
```
FIX_A_REMOVES_ACCIDENTAL_REDUNDANCY = true
PRE_FIX_JOB_CONSUMERS  = pricecom + pricecom-worker
POST_FIX_JOB_CONSUMERS = pricecom-worker only
POST_FIX_SINGLE_POINT_OF_FAILURE = pricecom-worker
TRADE_ACCEPTED = DETERMINISTIC_TOPOLOGY_OVER_ACCIDENTAL_REDUNDANCY
```

## CI guards (tracked, run in CI)
- **Guard 1** (`tests/unit/worker-topology-guards.test.ts`) — **entrypoint-based + dynamically discovered**. Startup surfaces are discovered via `git ls-files` (any tracked `Dockerfile*`, `Procfile*`, `railway.{json,toml}`, `nixpacks.toml` — so a *new* surface added tomorrow is auto-inspected without editing the test). No **web** surface (root-level) may reference **any** `worker/src/` entrypoint — this covers `index.ts`, `dev.ts`, and any future wrapper, not just a filename. Worker-service surfaces (`worker/`) must use the prod-faithful `worker/src/index.ts` and **never** `worker/src/dev.ts` (dev force-enables `WORKER_ENABLED` and would neutralize the fail-closed). The `package.json` deploy scripts (`start`, `build`) must not reference `worker/src/`.
- **Guard 2** (same file) — `worker/src/index.ts` boots via `bootWorker` (WORKER_ENABLED guard), never an unconditional top-level `pollLoop();`; and `worker/src/dev.ts` only *defaults* `WORKER_ENABLED` (respecting an explicit value) and delegates to `index.ts`'s guard — it has no `pollLoop` of its own.

## Local development
`npm run dev` → `npm run worker` → `tsx watch worker/src/dev.ts`, which sets `WORKER_ENABLED="true"` by default (respecting an explicit value). `npm run worker:start` runs the prod-faithful entrypoint `worker/src/index.ts` directly and therefore requires `WORKER_ENABLED=true` in the environment to poll.

## Deploy precondition (human, before merge)
The new code is fail-closed. Deploying without the variable leaves the legitimate worker idle and the queue unconsumed. Required order:
1. PR-1 CI green.
2. Human: `pricecom-worker → WORKER_ENABLED=true`; `pricecom → WORKER_ENABLED` absent.
3. Capture the variable witness + the redeploy Railway triggers.
4. Only then merge, then deploy.

`WORKER_ENABLED` is inert under the current deployed code (`116b8f1`), so setting it early is safe.

## Debts (open, non-blocking)
- `DEBT_NO_WORKER_LIVENESS_ALERTING = OPEN_NONBLOCKING` — the disabled-mode heartbeat diagnoses a **misconfiguration**; it does **not** alert that a legitimate worker died (a dead process emits nothing; detecting an absence needs an external observer — queue growth, an expected heartbeat that stops arriving, Railway health). Must gate unattended recurring automation. Real redundancy, when needed, is **homogeneous replicas of the same worker service** with lease + monitoring — not two distinct services racing by accident.
- `Q1_ROOT_CAUSE_COMPLETENESS = REQUIRES_REVIEW`; `Q1_STALE_RECLAIM_CAUSE_REFUTED = false` — the second poller is an additional possible contributor to the Q1 double-execution and was not accounted for in Q1's single-worker analysis.

## Out of scope (PR-2)
source-field canary gate · structural no-historical-fallback guard · `[PathDecision]` witness · set-difference exclusivity proof · any change to partial-commit logic.
