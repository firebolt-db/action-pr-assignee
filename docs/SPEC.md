# `firebolt-db/action-pr-assignee` — Specification

**Status:** Final.
**Scope:** Complete behavioral specification. Describes what the action does, how it decides, how users interact with it, and the generic structure requirements for the implementation. Implementation details (directory layout, choice of bundler, choice of test framework, linter rules) are left to the implementer.

---

## Table of contents

1. [Overview](#1-overview)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Design principles](#3-design-principles)
4. [Architecture](#4-architecture)
5. [Action metadata (`action.yml`)](#5-action-metadata-actionyml)
6. [Inputs](#6-inputs)
7. [Outputs](#7-outputs)
8. [Permissions and tokens](#8-permissions-and-tokens)
9. [Trigger and event handling](#9-trigger-and-event-handling)
10. [Early-exit conditions](#10-early-exit-conditions)
11. [Data collection](#11-data-collection)
12. [Candidate pool construction](#12-candidate-pool-construction)
13. [Scoring algorithm](#13-scoring-algorithm)
14. [Selection and tie-breaking](#14-selection-and-tie-breaking)
15. [Assignment and side-effects](#15-assignment-and-side-effects)
16. [Caching strategy](#16-caching-strategy)
17. [Error handling and exit codes](#17-error-handling-and-exit-codes)
18. [Logging and explanations](#18-logging-and-explanations)
19. [Testing requirements](#19-testing-requirements)
20. [Release and versioning](#20-release-and-versioning)
21. [Marketplace publishing](#21-marketplace-publishing)
22. [Security considerations](#22-security-considerations)
23. [Known limitations](#23-known-limitations)
24. [Glossary](#24-glossary)

---

## 1. Overview

`firebolt-db/action-pr-assignee` is a GitHub Action that picks **exactly one** best reviewer / assignee for each pull request and assigns them automatically. The choice is **deterministic** (no LLM, no random sampling, no external AI service) and is driven by three signal families:

1. **Ownership** — CODEOWNERS rules resolved against the PR's changed files, weighted by LOC. Optional — the action works without a CODEOWNERS file.
2. **Familiarity** — recent commit authorship and prior review activity on the same files.
3. **Workload** — current assignments, pending review requests, and recent assignment history (negative signals, used to spread load).

The action is a JavaScript GitHub Action (Node 20+) distributed from a public repository and listed on the GitHub Marketplace.

All configuration is passed through **action inputs** — there is no repo-level config file, no sidecar YAML, no hidden state. If you can read the workflow `with:` block you understand exactly how the action is configured.

**Single-assignee policy.** The action assigns one person. GitHub PRs can technically have many assignees; naming one clear owner produces faster merges and less diffusion of responsibility.

**GraphQL-first.** The action uses GitHub's GraphQL API as its primary transport. This keeps call volume well under rate-limit ceilings on busy repos and lets us fetch related data (files + reviews + assignment events) in a single round-trip per PR.

---

## 2. Goals and non-goals

### 2.1 Goals

- Pick a high-quality single assignee within seconds of the PR being opened or marked ready for review.
- Be **deterministic**: given the same repo state, the same PR produces the same assignee on every run.
- Be **explainable**: emit a structured breakdown of why the chosen user won.
- Work on any public or private repo — with or without CODEOWNERS.
- Support GitHub Enterprise Server (no hardcoded `api.github.com`).
- Degrade gracefully when optional permissions or signals are missing.
- Be side-effect-safe: never overwrite an existing assignee, never reassign, never touch draft PRs.
- Be fast and cheap: small PRs cost 4–5 GraphQL calls; large PRs stay under 15.

### 2.2 Non-goals

- **Multi-reviewer selection.** Single assignee only.
- **Review request management.** The action sets `assignees`, not `requested_reviewers`.
- **LLM-based routing.** All logic is rule-based.
- **Historical analytics or dashboarding.** The action emits structured outputs; consumers can pipe them into their own telemetry.
- **Cross-repo load balancing.** Workload signals are scoped to the repo the PR lives in.
- **Fork PR assignment.** `pull_request` events from forks run with a read-only token and are skipped.

---

## 3. Design principles

1. **Determinism over cleverness.** Every tie-break is a documented rule. No randomness.
2. **Defaults are safe.** Out-of-the-box behavior is sensible for a mid-size engineering org; every tuning knob is optional.
3. **Fail open, never loud.** If a signal is unavailable, emit a warning and continue. The action should almost never fail the CI job.
4. **Explanations are first-class.** Outputs make the choice auditable and challengeable.
5. **Side-effects are opt-in and reversible.** Never remove assignees. Running twice is a no-op the second time.
6. **No hidden state.** The only persistent state is the activity cache in `@actions/cache`; it is fully derivable from the repo.
7. **Pure decision engine.** Scoring and selection are a pure function of inputs; I/O is confined to adapters.

---

## 4. Architecture

The action is structured as three strict layers. The layering ensures the decision logic is trivially testable and auditable.

```
 ┌─────────────────────────────────────────────────────────────────┐
 │  Layer 1 — Entry                                                │
 │  Wires @actions/core + @actions/github into the orchestrator.   │
 │  No business logic.                                             │
 └────────────────────────────┬────────────────────────────────────┘
                              │
 ┌────────────────────────────▼────────────────────────────────────┐
 │  Layer 2 — Orchestration                                        │
 │  Accepts injected dependencies (logger, GitHub client, fs,      │
 │  cache, clock). Parses inputs, gathers signals via adapters,    │
 │  calls the engine, writes outputs, issues the assign mutation.  │
 └────────────────────────────┬────────────────────────────────────┘
                              │
 ┌────────────────────────────▼────────────────────────────────────┐
 │  Layer 3 — Pure decision engine                                 │
 │  selectAssignee({pr, files, codeowners, signals, config})       │
 │     → { assignee, ranking, reason }                             │
 │  No I/O, no clock, no network. Deterministic given inputs.      │
 └─────────────────────────────────────────────────────────────────┘
```

**Layering rules:**

- The engine depends only on its own inputs and shared utility code; it must not import the GitHub client, filesystem, cache, or `@actions/*`.
- Adapters encapsulate I/O (GitHub API, disk, cache). Each adapter exposes a narrow async surface that can be replaced by a fake in tests.
- The orchestrator depends on both, but contains only wiring — no scoring logic.

The action runs in a single process, top-to-bottom. There is no daemon and no background worker.

---

## 5. Action metadata (`action.yml`)

The file lives at the repo root (Marketplace requirement). Summary of the metadata fields:

- `name: 'PR Assignee'`, unique across the Marketplace.
- `author: 'Firebolt'`.
- `description:` one-line summary.
- `runs.using: 'node20'`, `runs.main: 'dist/index.js'` (the committed bundle).
- `branding.icon: 'users'`, `branding.color: 'blue'`.
- Every `input` has a `description`.
- Every `output` has a `description`.

The full input and output set is documented in §6 and §7.

---

## 6. Inputs

All tuning knobs are action inputs. The list is long by design — explicit beats clever.

### 6.1 Tokens

| Input            | Type    | Default | Description |
|------------------|---------|---------|-------------|
| `github_token`   | string  | —       | **Required.** Token with `contents:read` and `pull-requests:write` (or `issues:write`). Usually `${{ secrets.GITHUB_TOKEN }}`. |
| `token_override` | string  | `""`    | Optional token with `members:read` (team expansion) and/or `read:user` (Status OOO). Falls back to `github_token` when empty. |

### 6.2 Execution mode

| Input           | Type   | Default            | Description |
|-----------------|--------|--------------------|-------------|
| `dry_run`       | bool   | `false`            | Compute and emit the chosen assignee but do not perform the assignment. |
| `opt_out_label` | string | `no-auto-assign`   | PR label that disables auto-assignment. Empty string disables the feature. |

### 6.3 Signal windows (days; `0` disables the signal)

| Input                            | Default | Description |
|----------------------------------|---------|-------------|
| `familiarity_window_days`        | `30`    | Commit-authorship lookback for code familiarity. |
| `review_window_days`             | `30`    | Lookback for review familiarity. |
| `recent_assignment_window_days`  | `10`    | Window in which prior assignments penalise a candidate. |
| `activity_window_days`           | `30`    | Upper bound on the open-PR scan used for workload signals. |

### 6.4 Feature flags

| Input                   | Default | Description |
|-------------------------|---------|-------------|
| `check_github_status`   | `true`  | Treat users with `indicatesLimitedAvailability=true` as OOO. Silently disabled when `read:user` is unavailable. |

### 6.5 Filter lists (newline-separated; `#` lines are comments)

| Input                   | Default                                      | Description |
|-------------------------|----------------------------------------------|-------------|
| `exclude_users`         | empty                                        | GitHub logins to always exclude. |
| `bot_login_patterns`    | `\[bot\]$` / `^dependabot$` / `^renovate$`   | Regex patterns (case-insensitive). Any candidate login matching any pattern is excluded. |
| `fallback_patterns`     | `^\*$` / `^/$`                               | CODEOWNERS patterns treated as "catch-all." Candidates matching only through a fallback pattern receive `fallback_only_penalty`. |
| `unavailable_reviewers` | empty                                        | GitHub logins currently OOO. Authoritative source for unavailability. |

### 6.6 Score weights

Each score component is its own input. Supply only the knobs you need to change — every input has a sane default. Negative numbers are allowed.

| Input                                   | Default | Kind     | Applies to |
|-----------------------------------------|---------|----------|------------|
| `weight_direct_gte50`                   | `50`    | positive | Candidate owns ≥ 50% of changed LOC via direct CODEOWNERS match. |
| `weight_direct_gte20`                   | `35`    | positive | ≥ 20% and < 50%. |
| `weight_direct_floor`                   | `20`    | positive | > 0% and < 20%. |
| `weight_team_any`                       | `20`    | positive | Matched only via team membership. |
| `weight_fallback_any`                   | `5`     | positive | Matched only via a fallback pattern. |
| `weight_code_familiarity_per_commit`    | `5`     | positive | Per commit on changed files in window. |
| `weight_code_familiarity_max`           | `25`    | cap      | Clamp for `code_familiarity`. |
| `weight_review_familiarity_per_review`  | `4`     | positive | Per prior review on an overlapping PR. |
| `weight_review_familiarity_max`         | `20`    | cap      | Clamp for `review_familiarity`. |
| `weight_active_load_per_pr`             | `8`     | penalty  | Per open PR currently assigned to the candidate. |
| `weight_active_load_max`                | `24`    | cap      | Clamp for `active_load`. |
| `weight_pending_review_per_request`     | `5`     | penalty  | Per open PR with a pending review request directed at the candidate. |
| `weight_pending_review_max`             | `20`    | cap      | Clamp for `pending_review`. |
| `weight_recent_assignment_per_pr`       | `6`     | penalty  | Per PR the candidate was assigned within the recent-assignment window. |
| `weight_recent_assignment_max`          | `18`    | cap      | Clamp for `recent_assignment`. |
| `weight_team_fallback_penalty`          | `10`    | penalty  | Applied when a candidate's ownership tier is `team_any`. |
| `weight_fallback_only_penalty`          | `20`    | penalty  | Applied when a candidate's ownership tier is `fallback_any`. |

### 6.7 Input validation

- Types are strict. A malformed integer aborts with `core.setFailed`.
- Window inputs must be integers ≥ 0.
- Weight inputs must be integers (positive or negative).
- Unknown inputs are ignored by the runner.
- The resolved configuration is logged at `core.debug`.

---

## 7. Outputs

All outputs are always set (possibly to empty string or `"false"`) so downstream steps can reference them unconditionally.

| Output                   | Type                     | Example | Description |
|--------------------------|--------------------------|---------|-------------|
| `proposed_assignee`      | login string             | `alice` | Chosen login, empty when skipped. |
| `assignment_performed`   | `"true"` / `"false"`     | `true`  | Did the assignment mutation succeed? `"false"` in dry-run, when skipped, or on failure. |
| `ranked_candidates_json` | JSON array               | see below | Ordered ranking with per-component breakdown. |
| `explanation`            | plaintext (≤ 1024 chars) | see §18 | Human-readable summary. |
| `skipped_reason`         | enum                     | `draft` | One of `""`, `draft`, `already_assigned`, `opted_out`, `fork_pr`, `empty_candidate_pool`. |

### 7.1 `ranked_candidates_json`

A single array ordered by the tie-broken ranking, containing both the ordering and the per-component breakdown:

```json
[
  {
    "login": "alice",
    "total": 55,
    "tier": "direct_gte50",
    "components": {
      "direct_ownership": 50,
      "code_familiarity": 20,
      "review_familiarity": 12,
      "active_load": -16,
      "pending_review": -5,
      "recent_assignment": -6,
      "team_fallback": 0,
      "fallback_only": 0
    }
  },
  {
    "login": "bob",
    "total": 15,
    "tier": "team_any",
    "components": { "...": "..." }
  }
]
```

`components` always includes every component (including zeros) so consumers never have to handle missing keys.

---

## 8. Permissions and tokens

### 8.1 Minimum permissions

```yaml
permissions:
  contents: read           # read CODEOWNERS from the working copy
  pull-requests: write     # assignment mutation
```

`issues: write` is an accepted alternative to `pull-requests: write`.

### 8.2 Optional extended scopes

Without these, the action degrades gracefully.

| Feature                      | Scope (via `token_override`) | Failure mode when missing |
|------------------------------|------------------------------|----------------------------|
| Team expansion               | `members:read` on org        | The team rule contributes zero candidates (see §11.6, §12.2). |
| GitHub Status-based OOO      | `read:user`                  | Status check is skipped; `unavailable_reviewers` remains the authoritative OOO source. |

**Important:** the default `${{ secrets.GITHUB_TOKEN }}` is strictly repository-scoped and **cannot** be granted org-level permissions like `members:read`, even if listed under `permissions:` in the workflow YAML. Team expansion strictly requires a Personal Access Token or a GitHub App installation token supplied via `token_override`. Attempting to expand teams with the default token will produce 403 errors, which the action catches and surfaces as warnings — but the underlying fix is always "supply `token_override`." The README calls this out in the setup instructions to save users from debugging 403s.

### 8.3 Forks

Workflows triggered by `pull_request` from forks receive a read-only `GITHUB_TOKEN`. The assignment mutation rejects writes in that case. The action detects a fork when the PR's head repository differs from the base repository and exits with `skipped_reason: "fork_pr"`.

---

## 9. Trigger and event handling

### 9.1 Supported events

```yaml
on:
  pull_request:
    types: [opened, reopened, ready_for_review]
```

Other types (e.g. `synchronize`) are typically no-ops: the action early-exits with `already_assigned`.

### 9.2 Concurrency guard (required)

```yaml
concurrency:
  group: pr-assignee-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

Without this, rapid `opened` → `ready_for_review` bursts can race and double-assign. The README documents this as a hard requirement; the action does not enforce it at runtime because GitHub Actions does not expose a mechanism for it.

A side effect of `cancel-in-progress` is that a run cancelled before completion never writes to the activity cache (§16). Back-to-back bursts therefore bypass the cache and fetch live data. This is safe and intentional.

### 9.3 Event payload

The event is parsed once. Required fields: `pull_request.number`, `repository.owner.login`, `repository.name`. A malformed payload fails with `core.setFailed`.

---

## 10. Early-exit conditions

The action exits **success (code 0)** in any of the cases below, setting `skipped_reason` accordingly.

| `skipped_reason`        | Condition                                                 | `assignment_performed` |
|-------------------------|-----------------------------------------------------------|------------------------|
| `draft`                 | `pull_request.isDraft === true`                           | `false` |
| `already_assigned`      | `pull_request.assignees.length > 0`                       | `false` |
| `opted_out`             | PR labels include `opt_out_label`                         | `false` |
| `fork_pr`               | Head repo differs from base repo                          | `false` |
| `empty_candidate_pool`  | After filters, no candidate remains (warning emitted)     | `false` |

None of these is an error; each is accompanied by a `core.info` line stating which branch was taken.

---

## 11. Data collection

### 11.1 CODEOWNERS

CODEOWNERS is fetched via the GitHub API at the PR's **base** ref, not read from the working copy. This is a security requirement: `actions/checkout` defaults to checking out the `refs/pull/:pr/merge` ref, which *includes* the PR's changes — if the PR modifies CODEOWNERS, the local working copy is poisoned. Fetching at `base.ref` via the API guarantees we see the authoritative file as it exists on the base branch, regardless of what the PR has done.

The action tries the standard resolution order — `CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS` — via a single GraphQL query that requests all three blob objects with aliases:

```graphql
query Codeowners($owner: String!, $repo: String!, $root: String!, $github: String!, $docs: String!) {
  repository(owner: $owner, name: $repo) {
    root:   object(expression: $root)   { ... on Blob { text } }
    github: object(expression: $github) { ... on Blob { text } }
    docs:   object(expression: $docs)   { ... on Blob { text } }
  }
}
```

where expressions are `{base.ref}:CODEOWNERS`, `{base.ref}:.github/CODEOWNERS`, `{base.ref}:docs/CODEOWNERS`. First non-null blob wins.

**Parsing.** The action uses the [`codeowners`](https://www.npmjs.com/package/codeowners) npm package. We do not reimplement the parser. The fetched content is materialised to a temporary directory so the library's `new Codeowners(dir).getOwner(path)` API can be used unchanged. The library handles comment stripping, glob syntax, last-match-wins semantics, and the owner-token format. The returned owner strings include both individuals (`@login`) and teams (`@org/slug`); the action separates them downstream.

**Missing file.** If no CODEOWNERS file exists at any of the three paths, a warning is emitted and the ownership component of every candidate's score is zero. Candidates can still be seeded and selected via familiarity signals (§12.2).

**Fallback classification.** An owner string is classified as "fallback" when its rule's pattern matches any regex in `fallback_patterns`. The pattern itself is tested, not the path.

### 11.2 PR core (one GraphQL call)

A single query fetches all PR-scoped data needed by the rest of the pipeline:

- PR number, draft flag, author, labels, existing assignees, existing review requests.
- Head and base repository refs (for fork detection).
- Changed files with `path`, `additions`, `deletions`, `changeType`. Paginated if > 100 files.
- `suggestedReviewers` — GitHub's native commit/comment-based suggestion. Used only as a fallback seed when CODEOWNERS is absent (§12.2).
- The PR's GraphQL node ID (needed for the assignment mutation).

**Rename recovery.** GraphQL's `PullRequestChangedFile` does not expose the previous path. When the file list includes any `RENAMED` entries, the action makes a single REST call (`GET /repos/{o}/{r}/pulls/{n}/files?per_page=100`) and correlates REST responses back to the GraphQL files by current path. This is the one documented exception to the GraphQL-only rule. The correlation is by `filename`, not array position — REST and GraphQL do not guarantee matching order or pagination semantics.

**Large-PR cap.** To bound the cost of downstream queries, the action computes LOC = `additions + deletions` per file, sorts files by LOC descending, and uses only the **top 200 files** for familiarity and ownership-percentage calculations. When the cap trips, a warning is emitted: `"PR touches N files; familiarity and ownership computed on top 200 by LOC."` All files still participate in CODEOWNERS matching (cheap, in-memory).

### 11.3 Activity bundle (one or two GraphQL calls)

Fetches open PRs within `activity_window_days`, each with:

- Author and current assignees.
- Review requests (with `asCodeOwner` flag).
- `timelineItems(itemTypes: [ASSIGNED_EVENT], since: $since)` — precise timestamps of recent assignment events.

Paginated until a page's PRs are all older than `activity_window_days`.

**In-memory projection per candidate:**

- `open_assigned_prs` — count of open PRs where the candidate is currently an assignee.
- `pending_review_requests` — count of open PRs where the candidate is a requested reviewer (directly or, when team expansion is available, via a requested team).
- `recent_assignments` — count of distinct PR numbers with an `AssignedEvent` naming the candidate within `recent_assignment_window_days`.

Cached per-repo for one hour (§16).

### 11.4 Review familiarity (one to three GraphQL calls)

Fetches PRs in states `[OPEN, MERGED, CLOSED]` ordered by `updatedAt` descending, each with its files and reviews. `updatedAt` is used purely as the pagination cursor — it drives how far back we fetch, not which reviews count. A PR updated today but last reviewed two years ago is not double-counted: when projecting familiarity, the engine filters the individual review events by `review.submittedAt` against `review_window_days` and ignores reviews outside the window. Pagination stops when a full page of PRs has `updatedAt` older than `review_window_days`.

Including `OPEN` means that actively reviewing a long-lived open PR on the same files earns review-familiarity credit. This is intentional — `pending_review` penalises *incoming* review requests on a candidate, not reviews they have already submitted, so there is no double-counting.

**Projection per candidate:** count of distinct PRs in the window where (a) at least one file path overlaps with the current PR's (capped) changed files, and (b) the candidate appears as a review author on a review whose `submittedAt` is within `review_window_days`.

### 11.5 File commit history (aliased GraphQL calls)

For each file in the (capped) changed-file set, count commits by each candidate within `familiarity_window_days`. Queries use `Ref.target.history(path:, since:)` on the default branch, batched with aliases — 20 files per query.

GraphQL returns `author.user.login` pre-resolved. Commits where `author.user` is null (unlinked email) are dropped. Attempting to map email to login manually is highly error-prone and would produce false attributions.

**Rename handling.** For files with a one-hop rename (§11.2), history is queried for both the current and previous paths; commit counts are summed.

**Default-branch scope.** History is queried against the default branch only. Commits that live solely on long-lived feature branches are not counted.

### 11.6 Team expansion (conditional)

Fired only when CODEOWNERS contains team references and the token has `members:read`. One query per unique team, cached in-run.

A 404 or 403 response means the team rule contributes **zero candidates**: we cannot enumerate members, and we refuse to award `team_any` credit to users seeded from other signals because we cannot verify membership. A warning is emitted.

### 11.7 Status-based OOO (conditional)

Fired only when `check_github_status: true` and the token has `read:user`. Batched via aliases, up to 20 candidates per query. Users whose `status.indicatesLimitedAvailability` is `true` are treated as unavailable.

### 11.8 Call budget

Typical small PR (< 20 files, < 10 candidates, no teams, Status off): **4–5 GraphQL calls** plus the assign mutation. Large PR (hitting the 200-file cap, 20+ candidates, several teams): **10–15 GraphQL calls**. Either case is a tiny fraction of the per-hour GraphQL points budget.

---

## 12. Candidate pool construction

### 12.1 Seeding from CODEOWNERS

Candidates are seeded from CODEOWNERS matches in the following order:

1. Direct individual matches.
2. Team matches (expanded to members when permitted).
3. Fallback-pattern matches.

Each candidate is annotated with the strongest ownership tier they qualify for: `direct_gte50 > direct_gte20 > direct_floor > team_any > fallback_any`.

### 12.2 Seeding when CODEOWNERS is absent or unhelpful

If no CODEOWNERS file is found, or the CODEOWNERS pool is empty after filters, the action seeds from signal-derived candidates:

1. Users with non-zero **commit familiarity** on the PR's (capped) files in the window.
2. Users with non-zero **review familiarity** on PRs touching overlapping files in the window.
3. As a last resort, `suggestedReviewers.reviewer.login` from the PR core query.

Signal-derived candidates get **no ownership credit** (ownership tier is `none`, worth 0). They must earn their score entirely from familiarity.

A warning is emitted noting that CODEOWNERS was absent (or yielded nothing) and the pool was seeded from signals.

### 12.3 Filters (applied in order)

1. Remove the PR author.
2. Remove logins in `exclude_users`.
3. Remove logins matching any `bot_login_patterns` (case-insensitive).
4. Remove logins in `unavailable_reviewers` or flagged OOO by the Status check.
5. Remove accounts that resolve to `null` (deleted users).

If the pool is empty after filtering, exit with `skipped_reason: "empty_candidate_pool"` and a warning.

### 12.4 De-duplication

Pools are de-duplicated by login. When a candidate appears via multiple routes (e.g. direct and team), the strongest tier wins.

---

## 13. Scoring algorithm

### 13.1 LOC accounting

**LOC = `additions + deletions`** for every file. Deletions weigh equally with additions: removing a line requires the same context and ownership as adding one.

The sum of LOC across the (capped) changed files is the **LOC denominator** used for ownership percentage. When the large-PR cap trips (§11.2), the denominator is the sum over the 200 kept files.

For each candidate, their LOC numerator is the sum of LOC over files where they appear as a direct CODEOWNER. Their tier is determined by `numerator / denominator`:

- ≥ 50% → `direct_gte50`
- ≥ 20%, < 50% → `direct_gte20`
- > 0%, < 20% → `direct_floor`
- 0% but matched by team → `team_any`
- 0% and matched by fallback only → `fallback_any`
- 0% and not matched by CODEOWNERS (signal-seeded) → `none`

### 13.2 Components

```
total = ownership_tier_score
      + code_familiarity_score
      + review_familiarity_score
      - active_load_penalty
      - pending_review_penalty
      - recent_assignment_penalty
      - team_fallback_penalty        (iff ownership tier is `team_any`)
      - fallback_only_penalty        (iff ownership tier is `fallback_any`)
```

Each per-component score is clamped to `[0, max]` where a max is defined.

| Component            | Formula                                                                                     |
|----------------------|---------------------------------------------------------------------------------------------|
| `direct_ownership`   | `weight_{tier}`. `0` when tier is `none`.                                                   |
| `code_familiarity`   | `min(commits * weight_code_familiarity_per_commit, weight_code_familiarity_max)`            |
| `review_familiarity` | `min(reviews * weight_review_familiarity_per_review, weight_review_familiarity_max)`        |
| `active_load`        | `min(open_assigned * weight_active_load_per_pr, weight_active_load_max)` (subtracted)       |
| `pending_review`     | `min(requests * weight_pending_review_per_request, weight_pending_review_max)` (subtracted) |
| `recent_assignment`  | `min(assignments * weight_recent_assignment_per_pr, weight_recent_assignment_max)` (sub.)   |
| `team_fallback`      | `weight_team_fallback_penalty` iff tier == `team_any`, else 0 (subtracted)                  |
| `fallback_only`      | `weight_fallback_only_penalty` iff tier == `fallback_any`, else 0 (subtracted)              |

### 13.3 Worked example

PR changes: `src/db/query.ts` (100 LOC), `src/db/README.md` (20 LOC), total 120 LOC.

CODEOWNERS:
```
/src/db/   @firebolt-db/db-team @alice
*          @firebolt-db/everyone
```

`@firebolt-db/db-team` expands to `[alice, bob]`.

| Candidate | Tier           | Commits | Reviews | Assigned | Pending | Recent |
|-----------|----------------|---------|---------|----------|---------|--------|
| alice     | `direct_gte50` | 4       | 3       | 2        | 1       | 1      |
| bob       | `team_any`     | 1       | 0       | 0        | 0       | 0      |

**alice:** +50 (ownership) + 20 (familiarity) + 12 (reviews) − 16 (load) − 5 (pending) − 6 (recent) = **55**.
**bob:** +20 (team) + 5 (familiarity) − 10 (team fallback) = **15**.

Winner: **alice**.

---

## 14. Selection and tie-breaking

Candidates are ranked by `total` descending. Ties are broken deterministically, in order:

1. Higher ownership tier (`direct_gte50 > ... > fallback_any > none`).
2. Lower `active_load` score.
3. Lower `recent_assignment` score.
4. Higher `code_familiarity` score.
5. Alphabetical by login.

`ranked_candidates_json` reflects the tie-broken order.

### 14.1 Hard floor

A candidate whose total is **≤ 0** is not eligible to win. If every candidate's total is ≤ 0, the action exits with `skipped_reason: "empty_candidate_pool"` and the warning:

> "all candidates have non-positive scores; workload penalties dominated ownership — consider adjusting weights."

---

## 15. Assignment and side-effects

### 15.1 Mutation

The assignment uses GraphQL's `addAssigneesToAssignable` mutation on the PR's node ID.

- Retries once on 5xx with 2 s backoff.
- On a mutation error indicating the user is not assignable (e.g. not a collaborator), the action logs a warning, picks the next-best candidate from the ranked list, and retries up to `min(3, pool_size)` times.
- If all attempts fail, the action sets `assignment_performed: false`, logs the error, and exits 0. The principle: let the PR proceed without automatic assignment rather than failing the CI job.

This retry loop is also the safety net for **invalid CODEOWNERS entries**: typos (`@alcie`), users who left the org but remain in CODEOWNERS, or bot accounts that cannot be assigned all surface here as "not assignable" errors, and the runner-up is selected automatically. The action does not attempt to validate CODEOWNERS logins up front — the cost is extra API calls on every run, and the mutation-time retry produces the same outcome for free.

### 15.2 Dry-run

When `dry_run: true`, the action runs the full pipeline except the mutation. All outputs are populated; `assignment_performed` is `"false"`.

### 15.3 Invariants

- The action never removes assignees.
- The action never modifies PR title, body, labels, or requested reviewers.
- Running the action twice on the same PR is a no-op on the second run.
- At most one successful assignment mutation is issued per run.

---

## 16. Caching strategy

Activity data (open PRs + assignment timelines + review requests) changes slowly and is reused across PR events. It is cached via `@actions/cache`.

`@actions/cache` keys are **immutable**: once a cache is saved under a key, it cannot be overwritten from the same key. The cache strategy is therefore split between a prefix for restore and a unique suffix for save:

- **Save key:** `pr-assignee-activity-<owner>-<repo>-<run_id>`. Unique per workflow run, so saves never collide.
- **Restore keys (prefix match, most specific first):**
  - `pr-assignee-activity-<owner>-<repo>-`
- **Freshness:** on restore, the payload's embedded `fetched_at` timestamp is inspected. If older than 1 hour, the cache is discarded and a live fetch is performed.
- **Invalidation on config change:** the embedded `activity_window_days` is compared to the current input; mismatch → discard.
- **Write timing:** the new cache is saved after a successful run so a pre-assignment failure never poisons subsequent restores.
- **Absent cache:** fall back to a live fetch; log at `core.debug`. No user-visible failure.

Bursts of events (e.g. `opened` → `ready_for_review` in seconds) with `cancel-in-progress: true` bypass the cache because the first run is cancelled before it writes. The second run falls back to a live fetch. This is safe and intentional.

---

## 17. Error handling and exit codes

| Situation                                | Behavior                                                        |
|------------------------------------------|-----------------------------------------------------------------|
| Early-exit condition (§10)               | `core.info(...)`, set `skipped_reason`, exit 0.                 |
| Input parse error                        | `core.setFailed("Invalid input: ...")`, exit 1.                 |
| Missing required input (`github_token`)  | `core.setFailed(...)`, exit 1.                                  |
| GraphQL call exhausts retries            | `core.warning(...)`. If data is non-critical, continue. If the assignment mutation failed, set `assignment_performed: false` and exit 0. |
| Unexpected exception                     | Summarised via `core.setFailed`, exit 1.                        |
| Cache backend unavailable                | Fall back to live fetch. Log at `core.debug`.                   |

Default stance: best-effort assignment, never break CI. `core.setFailed` is reserved for invalid configuration or broken environment, not for data-path issues.

---

## 18. Logging and explanations

### 18.1 Log levels

- `core.debug` — verbose internals (resolved config, score tables, GraphQL cost). Visible only when `ACTIONS_STEP_DEBUG` is set.
- `core.info` — one line per major phase.
- `core.warning` — degraded-mode notices.
- `core.error` — reserved for unrecoverable issues before `setFailed`.

### 18.2 Explanation format

Multi-line, printed via `core.info` and compacted into the `explanation` output:

```
alice — total 55
  direct ownership (≥50%): +50
  code familiarity (4 commits): +20
  review familiarity (3 reviews): +12
  active load (2 PRs): -16
  pending reviews (1): -5
  recent assignments (1): -6
runner-up: bob (15)
```

### 18.3 Job summary

The action writes a Markdown block to `$GITHUB_STEP_SUMMARY` containing the ranked table, the chosen assignee, and the resolved weights — so reviewers can audit a run from the Actions UI without extra tooling.

---

## 19. Testing requirements

The action must be thoroughly testable **without real GitHub integration**. The three-layer architecture (§4) is the foundation; the requirements below follow from it.

### 19.1 Mandatory properties

- **Pure engine.** All scoring, filtering, and tie-breaking logic lives in a pure function of its inputs. The engine has zero I/O dependencies.
- **Injected dependencies.** The orchestration layer accepts GitHub client, filesystem reader, cache, logger, and clock as parameters. Tests substitute fakes for all of them.
- **Recorded fixtures.** GraphQL responses, event payloads, and CODEOWNERS files are stored as fixture files. No inline JSON blobs in test sources.
- **No live GitHub in the default test run.** A live-integration harness may exist but must be gated behind an opt-in environment variable and must not run in CI.
- **Every scoring component has direct unit coverage.** Formulas, clamps, and tie-break rules are tested against golden tables.

### 19.2 Required integration scenarios

The integration suite must cover, at minimum:

- Happy path: single winner, single assign mutation, correct outputs.
- Draft PR → `draft`.
- Already assigned → `already_assigned`.
- Opt-out label present → `opted_out`.
- Fork PR → `fork_pr`.
- CODEOWNERS absent → pool seeded from familiarity signals.
- CODEOWNERS present but all matches filtered → signal fallback.
- Team expansion permission denied → team rule drops, warning emitted.
- First candidate rejected by mutation (not assignable) → retry next candidate.
- Cache miss → live fetch path.
- All totals non-positive → `empty_candidate_pool` via hard floor.
- `dry_run: true` → no mutation, outputs populated.
- PR with > 200 files → large-PR cap trips, warning emitted.

### 19.3 Local debugging

Interactive debugging of the real entry point (without pushing to GitHub) is supported via a local-action simulator such as `@github/local-action`. The repo ships example `.env` files and fixture event payloads. The simulator is a debugging aid, not a CI gate — the simulator emulates only part of the runner, so confidence comes from the unit and integration suites.

### 19.4 Self-reference smoke test

CI ends with a step that runs the action against the CI repo's own PR in `dry_run: true` mode. This validates that the bundled entry point loads and the metadata file is well-formed — the same resolution path a consumer takes.

---

## 20. Release and versioning

### 20.1 Tagging

- Every release is tagged with a full semver tag: `v1.0.0`, `v1.2.3`.
- A moving major tag (`v1`) always points at the latest `v1.x.y` commit.
- A moving minor tag (`v1.2`) is optional and best-effort.
- Breaking changes bump the major and cut a new `v2`; the old major tag is preserved.

### 20.2 Bundled output

The action ships a committed bundled entry point (`dist/index.js`). Two guards keep it fresh:

1. CI fails any PR whose committed bundle is stale relative to source.
2. The release workflow rebuilds the bundle on every published release and force-pushes the moving major tag at the release commit.

### 20.3 Changelog

`CHANGELOG.md` follows Keep-a-Changelog. Every release bumps the version, moves unreleased entries under a version heading, and is the source of truth for release notes.

### 20.4 SHA pinning

The README recommends consumers pin by commit SHA for security-sensitive repos. Dependabot or equivalent keeps SHA pins current.

---

## 21. Marketplace publishing

Prerequisites:

- Repo is public.
- Single `action.yml` at the repo root.
- `name` is unique across the Marketplace.
- `branding.icon` and `branding.color` are present and not in the reserved-icon list.
- README contains: what the action does, inputs and outputs tables, usage example, permissions required, link to this SPEC.

Post-listing: monitor the listing's insights tab, maintain the moving major tag, respond to issues.

---

## 22. Security considerations

- **Token handling.** Tokens are read via `core.getInput` and never logged.
- **Input parsing.** All inputs are strings at the Actions boundary; numeric and list parsing happens in pure code with no shell indirection.
- **CODEOWNERS trust.** CODEOWNERS is fetched via the GitHub API at the PR's `base.ref` (§11.1), not from the local working copy. This defeats the default `actions/checkout` behavior of checking out `refs/pull/:pr/merge` (which contains the PR's changes) and guarantees that a malicious PR cannot poison its own routing by rewriting CODEOWNERS.
- **Team expansion.** Team membership is fetched via the optional extra-scoped token. Its scope is read-only org metadata.
- **Fork PRs.** Skipped early; the action never attempts writes with a read-only token.
- **`pull_request_target` is not supported.** The README explicitly warns against it because it runs with secret-bearing base-repo context against fork code.
- **Rate-limit exhaustion is bounded.** Worst-case call counts are documented (§11.8); the action cannot be weaponised for abuse.
- **Vulnerability disclosure.** Documented in `SECURITY.md` via GitHub Security Advisories.

---

## 23. Known limitations

- **Activity cache is stale up to 1 hour.** Acceptable because workload signals do not change minute-to-minute.
- **Rename detection is one-hop only** (via the REST fallback). Multi-step renames lose attribution.
- **Status-based OOO is best-effort.** `unavailable_reviewers` is authoritative.
- **LOC weighting can overweight mechanical refactors.** Use `opt_out_label` for those PRs.
- **Squash-merged PRs attribute familiarity to the squash-commit author.** A property of the upstream history.
- **Unlinked commits are dropped.** Commits whose author email is not associated with a GitHub user are ignored — mapping email to login manually is too error-prone to trust.
- **No multi-assignee support.** Intentional.
- **Concurrency group is required** but not runtime-enforced.
- **Default-branch-only commit history.** Work that lives solely on long-lived feature branches does not count toward familiarity.
- **Large-PR cap.** PRs with more than 200 changed files have familiarity and ownership-percentage computed on the top-200 subset (by LOC). A warning is emitted when the cap trips.

---

## 24. Glossary

- **Candidate** — a GitHub login that appears in at least one CODEOWNERS match for the PR's changed files, or is seeded from commit/review signals when CODEOWNERS is absent, after filtering.
- **Tier** — the best ownership category a candidate qualifies for: `direct_gte50 > direct_gte20 > direct_floor > team_any > fallback_any > none`.
- **Fallback pattern** — a CODEOWNERS pattern that matches every file (typically `*` or `/`). Candidates matching only via fallback are penalised.
- **Familiarity** — evidence of past engagement with the files in this PR: commit authorship or review activity.
- **Workload** — open PRs currently on a candidate's plate: assigned, pending review requests, or recently assigned.
- **Activity cache** — a 1-hour-TTL `@actions/cache` blob of repo-wide open-PR state.
- **Dry run** — full pipeline execution with the assignment mutation suppressed.
- **Fork PR** — a pull request whose head ref is in a different repository than the base. Skipped because the token is read-only.
- **Pure decision engine** — the function that performs all scoring and selection with no I/O.
- **Adapter** — a module that encapsulates a single I/O concern (GitHub API, disk, cache) and can be replaced by a fake in tests.
