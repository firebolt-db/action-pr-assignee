# AGENTS.md — `src/engine/`

The pure decision layer. **No I/O. Ever.**

## Purpose

`buildCandidatePool` and `rankCandidates` together are the deterministic heart of the action. Given identical inputs, they must produce identical outputs on every invocation, forever.

This is the layer that lets us test the entire scoring/selection behavior without a GitHub token, a network, or a clock.

## Hard invariants

1. **No imports with I/O side effects.** No `@actions/*`, no `node:fs`, no `node:os`, no adapters, no logger, no network clients. If you need data, accept it as an input.
2. **No non-determinism.** No `Math.random`, no `Date.now()`, no `new Date()` for anything observable, no reliance on `Map` insertion order for user-visible output (sort explicitly).
3. **No mutation of inputs.** Treat `BuildCandidatePoolInput` and `RankCandidatesInput` as frozen.
4. **Every tie-break is documented.** SPEC §14 is the contract. If you add a new tiebreak rule, update the SPEC in the same PR.
5. **Hard-floor rule.** A candidate with `total ≤ 0` cannot win (SPEC §14.1). When every candidate is non-positive, throw the canonical error string — the orchestrator catches it and maps to `skipped_reason: "empty_candidate_pool"`.

## Input contract

The orchestrator builds these structures; the engine only consumes them:

- `ChangedFileOwnership[]` — already capped to the top-200 files by LOC by the orchestrator. LOC of files outside the cap is passed in as `0` so the engine's denominator stays consistent with the cap.
- `SignalSeeds` — commit / review / suggested-reviewer logins for the CODEOWNERS-fallback path only.
- `CandidatePoolFilters` — author, exclude list, unavailable list, bot regexes, OOO users, deleted users.
- `CandidateSignalStats` — per-login `commitCount`, `reviewCount`, `openAssignedPrs`, `pendingReviewRequests`, `recentAssignments`.
- `ScoreWeights` — every knob from SPEC §6.6.

Logins arrive already lowercased from adapters; `normalizeLogin` defensively re-lowercases so the engine is robust if a caller forgets.

## Output contract

`RankCandidatesResult.ranking` is the tie-broken order. **Every candidate appears in the output, including those with `total ≤ 0`.** Only the winner selection (`assignee`) applies the hard floor. The orchestrator uses this full ranking for the "try next candidate" fallback loop when an assignment mutation rejects the top choice.

`components` always contains all eight keys (including zeros). Consumers (including the JSON output) rely on this.

## When adding a new scoring component

1. Add the weight knob to `ScoreWeights` (and mirror it in `src/config/types.ts`, `src/config/parseConfig.ts`, and `action.yml`).
2. Add the component field to `CandidateScoreComponents` — every candidate gets it, even if zero.
3. Extend the signal projection and the formula table in SPEC §13.2.
4. Add a golden-table unit test in `test/engine/ranking.test.ts`.
5. Decide if it interacts with tie-breaking (SPEC §14) and update both SPEC and `rankCandidates` sort comparator if so.

## Known issues

_None recorded yet._
