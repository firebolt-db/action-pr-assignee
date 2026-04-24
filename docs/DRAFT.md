# PR Assignee Action

Deterministically picks and assigns a single best reviewer for each pull request using a tiered score-based algorithm. No LLM or external AI service — fully deterministic based on CODEOWNERS ownership, commit/review familiarity, and workload signals.

Full spec: [docs/specs/pr_assignee_action.md](../../../docs/specs/pr_assignee_action.md)

## Usage

```yaml
on:
  pull_request:
    types: [opened, reopened, ready_for_review]

concurrency:
  group: pr-assignee-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write  # or issues: write

jobs:
  assign:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4  # required so the action can read .github/pr-assignee.yml and .github/unavailable-reviewers.yml
      - uses: ./.github/actions/pr-assignee
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github_token` | yes | — | GitHub token with `contents:read` and `pull-requests:write` (or `issues:write`) |
| `token_override` | no | — | GitHub App token or PAT with `members:read` and/or `read:user` for team expansion and GitHub Status checks |
| `config_path` | no | `.github/pr-assignee.yml` | Path to the repo-level config file |

All other tuning knobs (windows, weights, exclusion lists, opt-out label, etc.) are read from the repo-level config YAML — see the [config file](#config-file-githubpr-assigneeyml) section below.

## Outputs

| Output | Type | Description |
|--------|------|-------------|
| `proposed_assignee` | string | GitHub login of the chosen assignee, or empty string if skipped |
| `assignment_performed` | boolean | Whether the assignment API call succeeded |
| `ranked_candidates_json` | JSON string | Ordered array of `{login, total_score}` for all scored candidates |
| `score_breakdown_json` | JSON string | Per-candidate per-component score map (for audit/debugging) |
| `explanation` | string | Human-readable summary of why the chosen assignee won |
| `skipped_reason` | string | One of: `""`, `"draft"`, `"already_assigned"`, `"fork_pr"`, `"opted_out"`, `"empty_candidate_pool"` |

## Required permissions

Minimum for base operation:

```yaml
permissions:
  contents: read
  pull-requests: write
```

`issues: write` also satisfies the assignment call (the assignees endpoint is part of the Issues API).

For extended signals (optional):
- **Team expansion:** `members:read` scope via `token_override` input (GitHub App or PAT). Without it, team-referenced CODEOWNERS entries degrade gracefully to zero direct-ownership credit.
- **GitHub Status OOO detection:** `read:user` scope via `token_override`. Without it, the check is skipped silently.

## Opt-out label

Add the label `no-auto-assign` (configurable via `opt_out_label` input) to any PR to skip auto-assignment. The action exits with `skipped_reason: "opted_out"`. Useful for mechanical refactors or mass-format PRs where LOC-weighted ownership would mislead.

## Config file (`.github/pr-assignee.yml`)

All fields are optional; defaults apply when the file is absent.

```yaml
familiarity_window_days: 60
review_window_days: 45
recent_assignment_window_days: 10
activity_window_days: 90
check_github_status: true
opt_out_label: no-auto-assign
exclude_users:
  - some-bot-login
unavailable_reviewers_path: .github/unavailable-reviewers.yml
fallback_patterns:
  - "^\\*$"
  - "^/$"
bot_login_patterns:
  - "\\[bot\\]$"
  - "^dependabot$"
  - "^renovate$"
# score_weights uses a flat keyed schema; include only the keys you want to override.
score_weights:
  direct_gte50: 50
  direct_gte20: 35
  direct_floor: 20
  team_any: 20
  fallback_any: 5
  code_familiarity_per_commit: 5
  code_familiarity_max: 25
  review_familiarity_per_review: 4
  review_familiarity_max: 20
  active_load_per_pr: 8
  active_load_max: 24
  pending_review_per_request: 5
  pending_review_max: 20
  recent_assignment_per_pr: 6
  recent_assignment_max: 18
  team_fallback_penalty: 10
  fallback_only_penalty: 20
```

## Early-exit conditions

The action exits 0 (no failure) in these cases, setting `skipped_reason` accordingly:

| Reason | Cause |
|--------|-------|
| `draft` | PR is a draft |
| `already_assigned` | PR already has at least one assignee |
| `opted_out` | PR carries the opt-out label |
| `fork_pr` | PR is from a fork (GITHUB_TOKEN is read-only) |
| `empty_candidate_pool` | All candidates excluded; a warning is emitted |

## Concurrency recommendation

The workflow MUST set a concurrency group to prevent double-assignment races on rapid `opened` → `ready_for_review` bursts:

```yaml
concurrency:
  group: pr-assignee-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

## Known limitations

- Activity cache is stale up to ~1 hour (by design — avoids refetching 90 days per event).
- Rename detection is one-hop only (`previous_filename`).
- GitHub Status OOO is best-effort; `.github/unavailable-reviewers.yml` is the authoritative signal.
- LOC weighting can overweight mechanical refactors — use the opt-out label for those PRs.
- Squash-merged PRs attribute familiarity to the squash commit author.
