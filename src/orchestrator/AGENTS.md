# AGENTS.md — `src/orchestrator/`

The middle layer. Wires adapters, cache, and logger into the pure engine.

## Purpose

`runAction` is the top-to-bottom orchestration function. It:

1. Parses inputs via `src/config/parseConfig.ts`.
2. Builds an Octokit-like client from the effective token.
3. Reads the event payload for PR number + repo.
4. Runs early-exit checks (draft / already-assigned / opted-out / fork).
5. Fetches PR core data, CODEOWNERS, team membership, familiarity signals, activity signals (with cache).
6. Builds the candidate pool, applies filters, calls `rankCandidates`.
7. Emits outputs, writes the job summary, issues the assignment mutation with retry/fallback.
8. Saves the activity cache after a successful run (and in dry-run).

`src/orchestrator/codeowners.ts` is a small helper that materializes CODEOWNERS content into a tmp dir so the upstream `codeowners` npm package can be used unchanged.

## Rules

1. **Wiring only — no scoring logic.** Any numeric comparison, tier decision, or tie-break belongs in `src/engine/`. If you're tempted to compute a score here, stop.
2. **Every dep is injectable.** The `RunActionDeps` shape is the test seam. When you add a new adapter or a new helper with side effects, add it to `RunActionDeps` and let `defaultDeps` provide the real implementation.
3. **Fail open.** Every adapter call is wrapped in try/catch; on failure, `core.warning` + empty fallback. The action continues with degraded scoring and still tries to assign. Only `core.setFailed` (via `main()` in `src/index.ts`) for invalid configuration or a broken environment.
4. **Early-exit ordering (SPEC §10).** The check order is `draft → already_assigned → opted_out → fork_pr → empty_candidate_pool`. Changing the order changes observable outputs for consumers that inspect `skipped_reason`.
5. **Assignment-retry semantics (SPEC §15.1).**
   - 5xx / transient errors → retry once after 2 s, same candidate.
   - "Not assignable" errors → advance to next candidate in the ranked list.
   - Other fatal errors → abort the fallback, set `assignment_performed: false`, exit 0.
   - Cap total candidate attempts at `min(3, pool_size)`.
6. **Cache save discipline (SPEC §16).** Only save the activity cache after a successful pipeline (assignment succeeded or dry-run completed). Never save when the mutation failed outright — a pre-assignment failure must not poison subsequent restores.
7. **LOC cap is applied here, not in the engine.** Files outside the top-200 by LOC are passed to the engine with `loc: 0`. The engine's ownership denominator is consequently the sum over the kept files (SPEC §11.2, §13.1).

## Early-exit checks: subtle ordering

`already_assigned` runs before `opted_out` because a human who hand-assigned a reviewer on a draft that was later opted-out should still be reported as `already_assigned` (GitHub ordering of `pull_request` event types is not guaranteed, and this is the state that matters).

Fork detection compares both `owner/repo` pairs — forks in the same org are still forks.

## When adding a new early-exit reason

1. Extend the `SkippedReason` type in `src/types.ts`.
2. Insert the check at the right place in `runAction` (order matters for determinism).
3. Add a row to SPEC §10's table.
4. Add a scenario to `test/fixtures/integration/scenarios.json` and the outer integration test in `runAction.integration.test.ts`.
5. Update the `skipped_reason` enum documentation in `action.yml` and the outputs table in `README.md`.

## Known issues

_None recorded yet._
