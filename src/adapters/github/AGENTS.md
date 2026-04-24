# AGENTS.md — `src/adapters/github/`

GitHub I/O lives here. Everything else in `src/` assumes these adapters are the only code path that touches the network.

## Purpose

Each adapter exposes a narrow async function that wraps a single GraphQL (or, in one documented case, REST) call. The orchestrator imports them through dependency injection; tests substitute fakes via the `OctokitLike` shape in `types.ts`.

## Rules

1. **GraphQL-first (SPEC §11).** New data fetches must go through `octokit.graphql`. The one permitted REST call is `fetchRenamePreviousPathByCurrentFilename` (SPEC §11.2: GraphQL's `PullRequestChangedFile` does not expose `previous_filename`). Do not add further REST calls without amending the SPEC.
2. **Return primitive records, not GraphQL nodes.** The orchestrator and engine must never see raw GraphQL shapes. Map to plain objects (`PrCoreData`, `SignalsByLogin`, `Record<string, number>`, etc.) at the adapter boundary.
3. **Lowercase logins at the boundary.** Every login returned from an adapter is `.toLowerCase()`-ed here. The engine's `normalizeLogin` is a safety net, not the primary defense.
4. **Pagination termination.** Activity/review queries paginate by `updatedAt` desc and must stop when a full page is older than the window (see `pageHasRecentPr` in `signals.ts`). Don't paginate forever.
5. **Bounded batching.** Aliased queries (commit history, deleted-user check, status OOO) batch 20 per request. If a new aliased adapter is added, keep the 20-per-query cap to stay well under GitHub's GraphQL query-complexity ceiling.
6. **Fail at the adapter, recover at the orchestrator.** Adapters throw on failure. The orchestrator wraps calls in try/catch, emits `core.warning`, and substitutes an empty fallback. Do not swallow errors inside adapters — the orchestrator needs to see them to log correctly.
7. **No `@actions/core` imports here.** Logging is the orchestrator's job. Adapters stay logger-free so they remain trivially testable with just an `OctokitLike` fake.

## Call budget (SPEC §11.8)

- Small PR: 4–5 GraphQL calls + 1 assign mutation.
- Large PR: 10–15 GraphQL calls.

When adding a new fetch, ask: does this push the small-PR path above 5 calls? If so, either make it conditional (like team expansion or Status OOO) or cache it.

## Security invariants

- **CODEOWNERS is fetched at `base.ref` via the API**, never from the working copy (SPEC §22). `actions/checkout` defaults to `refs/pull/:pr/merge` which includes the PR's changes; a malicious PR could poison routing by rewriting CODEOWNERS. The query in `codeowners.ts` aliases the three standard paths against `{base.ref}:...` expressions. Do not add a "read from disk" fallback.
- **Fork detection happens in the orchestrator**, not here, but the PR core query must always return both `baseRepository` and `headRepository` so the orchestrator can compare. Don't drop those fields.
- **Rename recovery is one-hop only** (SPEC §23). The REST call matches current → previous filename by `filename` (not array position — pagination order is not guaranteed across REST and GraphQL).

## When adding a new adapter

1. Add the function to the appropriate existing file (`signals.ts` for signal-derived data, `prCore.ts` for PR-scoped, `codeowners.ts` for CODEOWNERS). Create a new file only if the scope genuinely doesn't fit.
2. Re-export through `index.ts`.
3. Add a fake to the orchestrator test helpers and an adapter-level unit test under `test/adapters/github/`.
4. Add the adapter to `RunActionDeps.adapters` in `runAction.ts` so it's injectable.
5. Document the new call in SPEC §11 and update the call-budget estimate in SPEC §11.8.

## Known issues

_None recorded yet._
